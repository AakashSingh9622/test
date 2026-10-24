// Billing runs (spec §7.3): 1) generate the period's charges, 2) reserve every open charge of the period into the run,
// 3) finance reviews (per client), 4) approve -> totals frozen and ONE draft invoice per client (the Sprint 7 invoice,
// sent to Sage the usual way), charges marked invoiced. A draft run can be discarded (its charges become open again).
const prisma = require("../config/prisma");
const httpError = require("../utils/httpError");
const { nextSequence } = require("./counterService");
const { appendAdminEvent } = require("./adminAuditService");
const { getSageSettings } = require("./sageSettingsService");
const { generateCharges, serializeCharge, parsePeriod } = require("./chargeService");
const { dateOnly } = require("../utils/serialize");
const { parsePagination } = require("../utils/pagination");

const TX = { maxWait: 10000, timeout: 120000 };
const KIND = { intake: "intake", storage: "storage", retrieval: "dispatch", delivery: "dispatch", collection: "collection", destruction: "destruction", digitize: "digitize", other: "other" };
const MAX_INVOICE_LINES = 200;

function serializeRun(r, extra = {}) {
  const out = {
    id: r.id,
    runNumber: r.runNumber,
    periodStart: dateOnly(r.periodStart),
    periodEnd: dateOnly(r.periodEnd),
    status: r.status,
    totals: r.totals ?? undefined,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    approvedBy: r.approvedBy ?? undefined,
    approvedAt: r.approvedAt?.toISOString(),
    ...extra,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

// Per-client totals of the run's (non-void) charges.
async function totalsFor(runId, db = prisma) {
  const groups = await db.chargeEvent.groupBy({
    by: ["clientId", "clientName"],
    where: { billingRunId: runId, status: { not: "voided" } },
    _sum: { amount: true },
    _count: { _all: true },
  });
  const clients = groups
    .map((g) => ({ clientId: g.clientId, clientName: g.clientName, charges: g._count._all, amount: Number(g._sum.amount ?? 0) }))
    .sort((a, b) => a.clientName.localeCompare(b.clientName));
  return { clients, amount: Math.round(clients.reduce((s, c) => s + c.amount, 0) * 100) / 100 };
}

async function createRun({ from, to }, actor) {
  const { start, end } = parsePeriod(from, to);
  const open = await prisma.billingRun.findFirst({ where: { status: "draft" } });
  if (open) throw httpError(409, `Billing run ${open.runNumber} is still a draft — approve or discard it first`);
  const generated = await generateCharges({ from, to }, actor);

  const run = await prisma.$transaction(async (tx) => {
    const seq = await nextSequence("billingRunSeq", tx);
    const created = await tx.billingRun.create({
      data: { runNumber: `BR-${String(seq).padStart(6, "0")}`, periodStart: start, periodEnd: end, createdBy: actor },
    });
    // Every open, un-run charge that falls in the period (including manual ones and older leftovers ending in it).
    await tx.chargeEvent.updateMany({
      where: { status: "open", billingRunId: null, periodEnd: { gte: start, lte: end } },
      data: { billingRunId: created.id },
    });
    await appendAdminEvent(
      "billing_run_created",
      actor,
      { entityType: "billing_run", entityId: created.id, summary: `Billing run ${created.runNumber} for ${dateOnly(start)} to ${dateOnly(end)}` },
      tx
    );
    return created;
  }, TX);
  return serializeRun(run, { totals: await totalsFor(run.id), generated });
}

async function listRuns(params = {}) {
  const { skip, take } = parsePagination(params);
  const [items, total] = await Promise.all([
    prisma.billingRun.findMany({ orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip, take }),
    prisma.billingRun.count(),
  ]);
  return { items: items.map((r) => serializeRun(r)), total };
}

async function getRun(id) {
  const run = await prisma.billingRun.findUnique({ where: { id } });
  if (!run) throw httpError(404, "Billing run not found");
  const [charges, invoices] = await Promise.all([
    prisma.chargeEvent.findMany({ where: { billingRunId: id }, orderBy: [{ clientName: "asc" }, { periodEnd: "asc" }, { id: "asc" }], take: 2000 }),
    prisma.invoice.findMany({ where: { billingRunId: id }, select: { id: true, invoiceNumber: true, clientName: true, netTotal: true, status: true } }),
  ]);
  return serializeRun(run, {
    totals: run.status === "approved" ? run.totals : await totalsFor(id),
    charges: charges.map(serializeCharge),
    invoices: invoices.map((i) => ({ ...i, netTotal: Number(i.netTotal) })),
  });
}

// Approve: freeze totals, one draft invoice per client from its charges, charges -> invoiced.
async function approveRun(id, actor) {
  const settings = await getSageSettings();
  return prisma.$transaction(async (tx) => {
    const run = await tx.billingRun.findUnique({ where: { id } });
    if (!run) throw httpError(404, "Billing run not found");
    if (run.status !== "draft") throw httpError(409, `Billing run ${run.runNumber} is already approved`);
    const taken = await tx.billingRun.updateMany({ where: { id, status: "draft" }, data: { status: "approved" } });
    if (taken.count !== 1) throw httpError(409, "This billing run was just approved by someone else");

    const charges = await tx.chargeEvent.findMany({ where: { billingRunId: id, status: "open" }, orderBy: [{ chargeType: "asc" }, { periodEnd: "asc" }] });
    const byClient = new Map();
    for (const c of charges) byClient.set(c.clientId, [...(byClient.get(c.clientId) || []), c]);

    const today = new Date(new Date().toISOString().slice(0, 10));
    const due = new Date(today.getTime() + settings.paymentTermsDays * 24 * 60 * 60 * 1000);
    const invoices = [];
    for (const [clientId, list] of byClient) {
      // One line per charge; a client with very many charges gets them summed per type + price + VAT instead.
      let lines = list.map((c) => ({ c, quantity: c.quantity, description: c.description }));
      if (lines.length > MAX_INVOICE_LINES) {
        const grouped = new Map();
        for (const c of list) {
          const key = `${c.chargeType}|${c.unitPrice}|${c.taxRateId}`;
          const g = grouped.get(key) || { c, quantity: 0, count: 0 };
          g.quantity = Number(g.quantity) + Number(c.quantity);
          g.count += 1;
          grouped.set(key, g);
        }
        lines = [...grouped.values()].map((g) => ({ c: g.c, quantity: g.quantity, description: `${g.c.chargeType} — ${g.count} charges` }));
      }
      const seq = await nextSequence("invoiceSeq", tx);
      const netTotal = list.reduce((s, c) => s + Number(c.amount), 0);
      const invoice = await tx.invoice.create({
        data: {
          invoiceNumber: `WMS-INV-${String(seq).padStart(6, "0")}`,
          clientId,
          clientName: list[0].clientName,
          periodFrom: run.periodStart,
          periodTo: run.periodEnd,
          invoiceDate: today,
          dueDate: due,
          notes: `Billing run ${run.runNumber}`,
          netTotal: Math.round(netTotal * 100) / 100,
          billingRunId: id,
          createdBy: actor,
          lines: {
            create: lines.map((l, i) => ({
              position: i + 1,
              kind: KIND[l.c.chargeType] || "other",
              description: l.description.slice(0, 500),
              quantity: l.quantity,
              unitPrice: l.c.unitPrice,
              taxRateId: l.c.taxRateId,
              sourceType: l.c.sourceType === "order" ? "order" : null,
              sourceId: l.c.sourceType === "order" ? l.c.sourceKey : null,
            })),
          },
        },
      });
      await tx.chargeEvent.updateMany({ where: { id: { in: list.map((c) => c.id) } }, data: { status: "invoiced", invoiceId: invoice.id } });
      invoices.push(invoice);
    }

    const totals = await totalsFor(id, tx);
    await tx.billingRun.update({ where: { id }, data: { totals, approvedBy: actor, approvedAt: new Date() } });
    await appendAdminEvent(
      "billing_run_approved",
      actor,
      { entityType: "billing_run", entityId: id, summary: `Approved billing run ${run.runNumber}: ${invoices.length} invoice(s), £${totals.amount.toFixed(2)}` },
      tx
    );
    return { runNumber: run.runNumber, invoices: invoices.map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, clientName: i.clientName, netTotal: Number(i.netTotal) })), totals };
  }, TX);
}

async function discardRun(id, actor) {
  return prisma.$transaction(async (tx) => {
    const run = await tx.billingRun.findUnique({ where: { id } });
    if (!run) throw httpError(404, "Billing run not found");
    if (run.status !== "draft") throw httpError(409, "An approved billing run can't be discarded");
    await tx.chargeEvent.updateMany({ where: { billingRunId: id }, data: { billingRunId: null } });
    await tx.billingRun.delete({ where: { id } });
    await appendAdminEvent("billing_run_discarded", actor, { entityType: "billing_run", entityId: id, summary: `Discarded draft billing run ${run.runNumber}` }, tx);
    return { ok: true };
  }, TX);
}

module.exports = { createRun, listRuns, getRun, approveRun, discardRun };
