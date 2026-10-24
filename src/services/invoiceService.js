// Warehouse invoices (Sprint 7 -- Sage One). Prepared here, created in Sage by the BROWSER (Sage tokens live there,
// like DocuSoft Practice), and recorded back here. The backend's job is to make sure one WMS invoice becomes exactly
// one Sage invoice:
//   draft --startSending--> sending --markIssued--> issued        (frozen from then on)
//                              └----markFailed----> draft (with lastError)
// "sending" is a lock with a time limit: a second tab can't send the same invoice at the same time, and an attempt that
// died half-way (browser closed) can be retried after SENDING_LOCK_MS. Before creating, the browser also searches Sage
// for an invoice with our invoiceNumber as reference, so a retry after "created in Sage but not recorded here" finds
// the first one instead of making a second.
const prisma = require("../config/prisma");
const { Prisma } = prisma;
const { nextSequence } = require("./counterService");
const { appendAdminEvent } = require("./adminAuditService");
const { getSageSettings, TAX_RATE_ID } = require("./sageSettingsService");
const { TX_OPTIONS } = require("./boxAllocationService");
const { dateOnly, toDate } = require("../utils/serialize");
const httpError = require("../utils/httpError");
const { parsePagination } = require("../utils/pagination");

const SENDING_LOCK_MS = 2 * 60 * 1000;
const KINDS = ["storage", "intake", "collection", "dispatch", "destruction", "digitize", "other"];
const STORED_STATUSES = ["stored", "reserved", "picked", "digitized"]; // physically in a slot on our shelves
const MAX_LINES = 200;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const num = (d) => (d == null ? d : Number(d)); // Prisma Decimal -> number for the JSON response

function serializeLine(l) {
  return {
    id: l.id,
    position: l.position,
    kind: l.kind,
    description: l.description,
    quantity: num(l.quantity),
    unitPrice: num(l.unitPrice),
    taxRateId: l.taxRateId,
    ...(l.ledgerAccountId && { ledgerAccountId: l.ledgerAccountId }),
    ...(l.sourceType && { sourceType: l.sourceType, sourceId: l.sourceId }),
  };
}

function serializeInvoice(inv) {
  if (!inv) return inv;
  const out = {
    id: inv.id,
    invoiceNumber: inv.invoiceNumber,
    clientId: inv.clientId,
    clientName: inv.clientName,
    periodFrom: dateOnly(inv.periodFrom) ?? undefined,
    periodTo: dateOnly(inv.periodTo) ?? undefined,
    invoiceDate: dateOnly(inv.invoiceDate),
    dueDate: dateOnly(inv.dueDate),
    notes: inv.notes ?? undefined,
    status: inv.status,
    netTotal: num(inv.netTotal),
    sendingSince: inv.sendingSince?.toISOString(),
    lastError: inv.lastError ?? undefined,
    sageContactId: inv.sageContactId ?? undefined,
    sageInvoiceId: inv.sageInvoiceId ?? undefined,
    sageInvoiceNumber: inv.sageInvoiceNumber ?? undefined,
    sageLink: inv.sageLink ?? undefined,
    issuedAt: inv.issuedAt?.toISOString(),
    issuedBy: inv.issuedBy ?? undefined,
    createdBy: inv.createdBy,
    createdAt: inv.createdAt.toISOString(),
    ...(inv.lines && { lines: [...inv.lines].sort((a, b) => a.position - b.position).map(serializeLine) }),
    ...(inv._count && { lineCount: inv._count.lines }),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

// --- input checks ------------------------------------------------------------------------------------------------

function dateField(value, name, { required = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw httpError(400, `${name} is required (YYYY-MM-DD)`);
    return null;
  }
  if (!DATE.test(String(value)) || Number.isNaN(new Date(value).getTime())) throw httpError(400, `${name} must be a date (YYYY-MM-DD)`);
  return String(value);
}

function money(value, name, { min, max }) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw httpError(400, `${name} must be a number from ${min} to ${max}`);
  return n;
}

function cleanLines(rawLines) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) throw httpError(400, "Add at least one invoice line");
  if (rawLines.length > MAX_LINES) throw httpError(400, `At most ${MAX_LINES} lines per invoice`);
  return rawLines.map((l, i) => {
    const where = `Line ${i + 1}`;
    const description = String(l.description || "").trim();
    if (!description) throw httpError(400, `${where}: description is required`);
    if (description.length > 500) throw httpError(400, `${where}: description is longer than 500 characters`);
    const kind = KINDS.includes(l.kind) ? l.kind : "other";
    const taxRateId = String(l.taxRateId || "").trim().toUpperCase();
    if (!TAX_RATE_ID.test(taxRateId)) throw httpError(400, `${where}: VAT rate must be a Sage tax rate id such as GB_STANDARD`);
    return {
      position: i + 1,
      kind,
      description,
      quantity: new Prisma.Decimal(money(l.quantity, `${where}: quantity`, { min: 0.0001, max: 1e6 })).toDecimalPlaces(4),
      unitPrice: new Prisma.Decimal(money(l.unitPrice, `${where}: unit price`, { min: 0, max: 1e9 })).toDecimalPlaces(2),
      taxRateId,
      ledgerAccountId: l.ledgerAccountId ? String(l.ledgerAccountId).trim() : null,
      sourceType: l.sourceType === "order" && l.sourceId ? "order" : null,
      sourceId: l.sourceType === "order" && l.sourceId ? String(l.sourceId) : null,
    };
  });
}

function netTotalOf(lines) {
  return lines.reduce((sum, l) => sum.plus(l.quantity.mul(l.unitPrice).toDecimalPlaces(2)), new Prisma.Decimal(0));
}

function cleanHeader(input) {
  const clientId = String(input.clientId || "").trim();
  const clientName = String(input.clientName || "").trim();
  if (!clientId || !clientName) throw httpError(400, "clientId and clientName are required");
  const invoiceDate = dateField(input.invoiceDate, "invoiceDate");
  const dueDate = dateField(input.dueDate, "dueDate");
  if (dueDate < invoiceDate) throw httpError(400, "The due date can't be before the invoice date");
  const periodFrom = dateField(input.periodFrom, "periodFrom", { required: false });
  const periodTo = dateField(input.periodTo, "periodTo", { required: false });
  if (periodFrom && periodTo && periodTo < periodFrom) throw httpError(400, "The period ends before it starts");
  const notes = input.notes ? String(input.notes).trim().slice(0, 2000) : null;
  return { clientId, clientName, invoiceDate, dueDate, periodFrom, periodTo, notes };
}

// --- reads ---------------------------------------------------------------------------------------------------------

async function listInvoices(params = {}) {
  const where = {};
  if (params.clientId) where.clientId = params.clientId;
  if (params.status) where.status = params.status;
  if (params.q) {
    const contains = { contains: params.q, mode: "insensitive" };
    where.OR = [{ invoiceNumber: contains }, { clientName: contains }, { sageInvoiceNumber: contains }];
  }
  const { skip, take } = parsePagination(params);
  const [items, total] = await Promise.all([
    prisma.invoice.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip, take, include: { _count: { select: { lines: true } } } }),
    prisma.invoice.count({ where }),
  ]);
  return { items: items.map(serializeInvoice), total };
}

async function getInvoice(id) {
  const inv = await prisma.invoice.findUnique({ where: { id }, include: { lines: true } });
  if (!inv) throw httpError(404, "Invoice not found");
  return serializeInvoice(inv);
}

// Suggested lines for one client and period, from what the warehouse did. Prices: the last price used for the same
// kind of line on any invoice (0 if never used) -- staff check and change them before saving.
async function suggestLines({ clientId, from, to }) {
  if (!clientId) throw httpError(400, "clientId is required");
  const fromDate = dateField(from, "from");
  const toDateStr = dateField(to, "to");
  if (toDateStr < fromDate) throw httpError(400, "The period ends before it starts");
  const start = new Date(`${fromDate}T00:00:00.000Z`);
  const endExclusive = new Date(new Date(`${toDateStr}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000);

  const settings = await getSageSettings();
  const [storedCount, intakeCount, orders, invoicedOrderLines] = await Promise.all([
    prisma.box.count({ where: { clientId, status: { in: STORED_STATUSES } } }),
    prisma.box.count({ where: { clientId, createdAt: { gte: start, lt: endExclusive } } }),
    prisma.order.findMany({
      where: { clientId, status: "completed", completedAt: { gte: start, lt: endExclusive } },
      orderBy: { completedAt: "asc" },
    }),
    prisma.invoiceLine.findMany({ where: { sourceType: "order", sourceId: { not: null } }, select: { sourceId: true } }),
  ]);
  const alreadyInvoiced = new Set(invoicedOrderLines.map((l) => l.sourceId));

  const lastPriceCache = new Map();
  async function lastPrice(kind) {
    if (!lastPriceCache.has(kind)) {
      const last = await prisma.invoiceLine.findFirst({ where: { kind }, orderBy: { invoice: { createdAt: "desc" } }, select: { unitPrice: true } });
      lastPriceCache.set(kind, last ? num(last.unitPrice) : 0);
    }
    return lastPriceCache.get(kind);
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : word.endsWith("x") ? "es" : "s"}`;
  const line = async (kind, description, quantity, source) => ({
    kind,
    description,
    quantity,
    unitPrice: await lastPrice(kind),
    taxRateId: settings.defaultTaxRateId,
    ...(source && { sourceType: "order", sourceId: source }),
  });

  const lines = [];
  if (storedCount > 0) lines.push(await line("storage", `Storage — ${plural(storedCount, "box")}, ${fromDate} to ${toDateStr}`, storedCount));
  if (intakeCount > 0) lines.push(await line("intake", `Intake — ${plural(intakeCount, "new box")} registered`, intakeCount));

  const skipped = [];
  for (const o of orders) {
    if (alreadyInvoiced.has(o.id)) {
      skipped.push(o.orderNumber);
      continue;
    }
    const s = o.lineSummary || {};
    const done = dateOnly(o.completedAt);
    if (o.type === "dispatch") {
      const n = s.dispatched ?? o.boxCount;
      lines.push(await line("dispatch", `Dispatch ${o.orderNumber} — ${plural(n, "box")}, completed ${done}`, Math.max(n, 1), o.id));
    } else if (o.type === "destruction") {
      const n = s.destroyed ?? o.boxCount;
      lines.push(await line("destruction", `Destruction ${o.orderNumber} — ${plural(n, "box")}, completed ${done}`, Math.max(n, 1), o.id));
    } else if (o.type === "digitize") {
      const n = s.digitized ?? o.boxCount;
      lines.push(await line("digitize", `Digitizing ${o.orderNumber} — ${plural(n, "box")}, completed ${done}`, Math.max(n, 1), o.id));
    } else if (o.type === "collection") {
      const n = s.received ?? o.boxCount;
      lines.push(await line("collection", `Collection ${o.orderNumber} — ${plural(n, "box")} received, completed ${done}`, 1, o.id));
    }
  }
  return { lines, alreadyInvoicedOrders: skipped };
}

// --- writes --------------------------------------------------------------------------------------------------------

async function createInvoice(input, actor) {
  const header = cleanHeader(input);
  const lines = cleanLines(input.lines);
  return prisma.$transaction(async (tx) => {
    const seq = await nextSequence("invoiceSeq", tx);
    const invoiceNumber = `WMS-INV-${String(seq).padStart(6, "0")}`;
    const inv = await tx.invoice.create({
      data: {
        invoiceNumber,
        clientId: header.clientId,
        clientName: header.clientName,
        invoiceDate: toDate(header.invoiceDate),
        dueDate: toDate(header.dueDate),
        periodFrom: toDate(header.periodFrom),
        periodTo: toDate(header.periodTo),
        notes: header.notes,
        netTotal: netTotalOf(lines),
        createdBy: actor,
        lines: { create: lines },
      },
      include: { lines: true },
    });
    await appendAdminEvent(
      "invoice_created",
      actor,
      { entityType: "invoice", entityId: inv.id, summary: `Prepared invoice ${invoiceNumber} for ${header.clientName}` },
      tx
    );
    return serializeInvoice(inv);
  }, TX_OPTIONS);
}

async function draftOrThrow(id, db) {
  const inv = await db.invoice.findUnique({ where: { id } });
  if (!inv) throw httpError(404, "Invoice not found");
  if (inv.status !== "draft") throw httpError(409, `Invoice ${inv.invoiceNumber} is ${inv.status} and can't be changed`);
  return inv;
}

async function updateInvoice(id, input) {
  const header = cleanHeader(input);
  const lines = cleanLines(input.lines);
  return prisma.$transaction(async (tx) => {
    await draftOrThrow(id, tx);
    await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
    // Only a draft is replaced -- the conditional update makes a parallel "send" win cleanly instead of racing.
    const changed = await tx.invoice.updateMany({
      where: { id, status: "draft" },
      data: {
        clientId: header.clientId,
        clientName: header.clientName,
        invoiceDate: toDate(header.invoiceDate),
        dueDate: toDate(header.dueDate),
        periodFrom: toDate(header.periodFrom),
        periodTo: toDate(header.periodTo),
        notes: header.notes,
        netTotal: netTotalOf(lines),
      },
    });
    if (changed.count !== 1) throw httpError(409, "The invoice was changed by someone else -- reload it");
    await tx.invoiceLine.createMany({ data: lines.map((l) => ({ ...l, invoiceId: id })) });
    return serializeInvoice(await tx.invoice.findUnique({ where: { id }, include: { lines: true } }));
  }, TX_OPTIONS);
}

async function deleteInvoice(id, actor) {
  await prisma.$transaction(async (tx) => {
    const inv = await draftOrThrow(id, tx);
    await tx.invoice.delete({ where: { id } });
    await appendAdminEvent(
      "invoice_deleted",
      actor,
      { entityType: "invoice", entityId: id, summary: `Deleted draft invoice ${inv.invoiceNumber} for ${inv.clientName}` },
      tx
    );
  }, TX_OPTIONS);
}

// Takes the "sending" lock. Free = a draft, or a "sending" attempt older than SENDING_LOCK_MS (that browser is gone).
async function startSending(id) {
  const inv = await prisma.invoice.findUnique({ where: { id } });
  if (!inv) throw httpError(404, "Invoice not found");
  if (inv.status === "issued") throw httpError(409, `Invoice ${inv.invoiceNumber} is already in Sage`);
  const staleBefore = new Date(Date.now() - SENDING_LOCK_MS);
  const taken = await prisma.invoice.updateMany({
    where: { id, OR: [{ status: "draft" }, { status: "sending", sendingSince: { lt: staleBefore } }] },
    data: { status: "sending", sendingSince: new Date(), lastError: null },
  });
  if (taken.count !== 1) throw httpError(409, `Invoice ${inv.invoiceNumber} is being sent to Sage right now -- wait a minute and reload`);
  return getInvoice(id);
}

async function markIssued(id, input, actor) {
  const sageInvoiceId = String(input.sageInvoiceId || "").trim();
  if (!sageInvoiceId) throw httpError(400, "sageInvoiceId is required");
  return prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.findUnique({ where: { id } });
    if (!inv) throw httpError(404, "Invoice not found");
    if (inv.status === "issued") {
      if (inv.sageInvoiceId === sageInvoiceId) return serializeInvoice(await tx.invoice.findUnique({ where: { id }, include: { lines: true } }));
      throw httpError(409, `Invoice ${inv.invoiceNumber} is already linked to another Sage invoice`);
    }
    if (inv.status !== "sending") throw httpError(409, `Invoice ${inv.invoiceNumber} is not being sent -- start sending first`);
    await tx.invoice.update({
      where: { id },
      data: {
        status: "issued",
        sendingSince: null,
        lastError: null,
        sageInvoiceId,
        sageInvoiceNumber: input.sageInvoiceNumber ? String(input.sageInvoiceNumber).slice(0, 100) : null,
        sageLink: input.sageLink ? String(input.sageLink).slice(0, 1000) : null,
        sageContactId: input.sageContactId ? String(input.sageContactId) : inv.sageContactId,
        sageBusinessId: input.sageBusinessId ? String(input.sageBusinessId) : inv.sageBusinessId,
        issuedAt: new Date(),
        issuedBy: actor,
      },
    });
    await appendAdminEvent(
      "invoice_issued",
      actor,
      {
        entityType: "invoice",
        entityId: id,
        summary: `Created invoice ${inv.invoiceNumber} for ${inv.clientName} in Sage${input.sageInvoiceNumber ? ` (${input.sageInvoiceNumber})` : ""}`,
      },
      tx
    );
    return serializeInvoice(await tx.invoice.findUnique({ where: { id }, include: { lines: true } }));
  }, TX_OPTIONS);
}

async function markFailed(id, message) {
  const reason = String(message || "Sending to Sage failed").slice(0, 1000);
  const changed = await prisma.invoice.updateMany({
    where: { id, status: "sending" },
    data: { status: "draft", sendingSince: null, lastError: reason },
  });
  if (changed.count !== 1) {
    const inv = await prisma.invoice.findUnique({ where: { id } });
    if (!inv) throw httpError(404, "Invoice not found");
  }
  return getInvoice(id);
}

module.exports = {
  SENDING_LOCK_MS,
  listInvoices,
  getInvoice,
  suggestLines,
  createInvoice,
  updateInvoice,
  deleteInvoice,
  startSending,
  markIssued,
  markFailed,
};
