// CSV exports (spec §3 "search and export", pilot exit criteria): inventory, movements, audit history, charges.
// Rows are read in pages of 1000 and written to the response as they come, so a big export never sits in memory.
const prisma = require("../config/prisma");
const { Prisma } = prisma;
const httpError = require("../utils/httpError");
const { dateOnly, toDate } = require("../utils/serialize");
const { locationText } = require("../utils/locationPath");
const { getBoxSizeNames } = require("./boxSizeService");

const PAGE = 1000;

function cell(v) {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  // Quote everything; also defuse spreadsheet formulas (=, +, -, @ at the start).
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
}
const line = (values) => values.map(cell).join(",") + "\r\n";

function period(params) {
  const where = {};
  if (params.from) {
    const d = toDate(params.from);
    if (Number.isNaN(d.getTime())) throw httpError(400, "from must be a date (YYYY-MM-DD)");
    where.gte = d;
  }
  if (params.to) {
    const d = toDate(params.to);
    if (Number.isNaN(d.getTime())) throw httpError(400, "to must be a date (YYYY-MM-DD)");
    where.lt = new Date(d.getTime() + 24 * 60 * 60 * 1000);
  }
  return Object.keys(where).length ? where : undefined;
}

async function stream(res, filename, header, fetchPage, toRow) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.write("﻿" + line(header)); // BOM so Excel reads UTF-8
  for (let skip = 0; ; skip += PAGE) {
    const rows = await fetchPage(skip, PAGE);
    for (const r of rows) res.write(line(toRow(r)));
    if (rows.length < PAGE) break;
  }
  res.end();
}

const SPECS = {
  inventory: (params) => {
    let sizeNames = null; // { code: name }, loaded with the first page
    const where = {};
    if (params.clientId) where.clientId = params.clientId;
    if (params.status) where.status = params.status;
    else where.status = { not: "destroyed" };
    // Docbox "Exportar archivo": narrow the inventory to one warehouse / rack / shelf row.
    if (params.warehouseId || params.rackId || params.row) {
      const row = params.row ? Number(params.row) : undefined;
      if (params.row && !Number.isInteger(row)) throw httpError(400, "row must be a whole number");
      where.slot = {
        ...(params.warehouseId && { warehouseId: String(params.warehouseId) }),
        ...(params.rackId && { rackId: String(params.rackId) }),
        ...(row && { row }),
      };
    }
    let fields = []; // the client's own fields -- extra columns, only when one client is exported
    const spec = {
      header: ["Box number", "Barcode", "Client id", "Client", "Description", "Department", "Reference", "Filing from", "Filing to", "Destroy after", "Retention category", "Size", "Status", "On hold", "Location", "Pallet", "Registered"],
      init: async () => {
        if (!params.clientId) return;
        fields = await prisma.customFieldDef.findMany({ where: { clientId: String(params.clientId), active: true }, orderBy: { position: "asc" } });
        spec.header = [...spec.header, ...fields.map((f) => f.name)];
      },
      fetch: async (skip, take) => {
        sizeNames = sizeNames ?? (await getBoxSizeNames());
        return prisma.box.findMany({ where, orderBy: [{ clientName: "asc" }, { boxNumber: "asc" }], skip, take });
      },
      row: (b) => [b.boxNumber, b.barcode, b.clientId, b.clientName, b.description, b.department, b.reference, dateOnly(b.filingDateFrom), dateOnly(b.filingDateTo), dateOnly(b.destroyAfter), b.retentionCategory, sizeNames?.[b.size] ?? b.size, b.status, b.onHold ? "yes" : "no", locationText(b.locationPath), b.palletNo, dateOnly(b.createdAt), ...fields.map((f) => b.customFields?.[f.code])],
    };
    return spec;
  },
  // Docbox "loan register" (Registro de prestamos): everything out with a client on a completed dispatch order, with
  // who asked, when, and the original shelf -- what the driver takes when collecting returns.
  loans: (params) => {
    const where = { status: { in: ["picked", "dispatched"] }, box: { status: "out" }, order: { type: "dispatch", status: "completed", permanentWithdrawal: false } };
    if (params.clientId) where.order.clientId = String(params.clientId);
    const at = period(params);
    if (at) where.order.completedAt = at;
    return {
      header: ["Client", "Box number", "Description", "Department", "Reference", "Order", "Urgent", "Requested via", "Requested by", "Requested on", "Issued on", "Original location"],
      fetch: (skip, take) =>
        prisma.orderLine.findMany({ where, include: { order: true, box: true }, orderBy: [{ order: { completedAt: "asc" } }, { id: "asc" }], skip, take }),
      row: (l) => [l.order.clientName, l.box?.boxNumber ?? l.boxNumber, l.box?.description, l.box?.department, l.box?.reference, l.order.orderNumber, l.order.urgent ? "urgent" : "normal", l.order.requestChannel, l.order.contactEmail, dateOnly(l.order.createdAt), dateOnly(l.order.completedAt), locationText(l.fromLocation)],
    };
  },
  // Docbox "returns" sheet: boxes that came back and wait at Goods-In, with the shelf they used to be on, so they can be shelved.
  toshelve: (params) => {
    const where = { status: "received" };
    if (params.clientId) where.clientId = String(params.clientId);
    let lastShelf = new Map(); // boxId -> where it was before
    return {
      header: ["Client", "Box number", "Barcode", "Description", "Goods-In", "Previous location"],
      fetch: async (skip, take) => {
        const boxes = await prisma.box.findMany({ where, orderBy: [{ clientName: "asc" }, { boxNumber: "asc" }], skip, take });
        const moves = await prisma.movement.findMany({
          where: { boxId: { in: boxes.map((b) => b.id) }, fromLocation: { not: Prisma.DbNull } },
          orderBy: { at: "desc" },
        });
        lastShelf = new Map();
        for (const m of moves) if (!lastShelf.has(m.boxId)) lastShelf.set(m.boxId, m.fromLocation);
        return boxes;
      },
      row: (b) => [b.clientName, b.boxNumber, b.barcode, b.description, locationText(b.locationPath), locationText(lastShelf.get(b.id))],
    };
  },
  movements: (params) => {
    const where = {};
    if (params.clientId) where.clientId = params.clientId;
    const at = period(params);
    if (at) where.at = at;
    return {
      header: ["When", "Box number", "Client id", "Type", "From", "To", "Order", "Reason", "By"],
      fetch: (skip, take) => prisma.movement.findMany({ where, orderBy: [{ at: "asc" }, { id: "asc" }], skip, take }),
      row: (m) => [m.at, m.boxNumber, m.clientId, m.type, locationText(m.fromLocation), locationText(m.toLocation), m.orderNumber, m.reason, m.actor?.name],
    };
  },
  audit: (params) => {
    const where = {};
    if (params.clientId) where.clientId = params.clientId;
    const at = period(params);
    if (at) where.at = at;
    return {
      header: ["When", "Box number", "Client id", "Event", "Order", "From", "To", "Note", "By", "Shown to client"],
      fetch: (skip, take) => prisma.auditEvent.findMany({ where, orderBy: [{ at: "asc" }, { id: "asc" }], skip, take }),
      row: (e) => [e.at, e.boxNumber, e.clientId, e.type, e.orderNumber, locationText(e.fromLocation), locationText(e.toLocation), e.note, e.actor?.name, e.visibleToClient ? "yes" : "no"],
    };
  },
  charges: (params) => {
    const where = {};
    if (params.clientId) where.clientId = params.clientId;
    if (params.status) where.status = params.status;
    const end = period(params);
    if (end) where.periodEnd = { ...(end.gte && { gte: end.gte }), ...(end.lt && { lt: end.lt }) };
    return {
      header: ["Period from", "Period to", "Client id", "Client", "Type", "Description", "Quantity", "Unit price", "Amount", "VAT", "Status", "Billing run", "Invoice"],
      fetch: (skip, take) => prisma.chargeEvent.findMany({ where, orderBy: [{ periodEnd: "asc" }, { clientName: "asc" }, { id: "asc" }], skip, take }),
      row: (c) => [dateOnly(c.periodStart), dateOnly(c.periodEnd), c.clientId, c.clientName, c.chargeType, c.description, Number(c.quantity), Number(c.unitPrice), Number(c.amount), c.taxRateId, c.status, c.billingRunId, c.invoiceId],
    };
  },
};

async function exportCsv(kind, params, res) {
  const make = SPECS[kind];
  if (!make) throw httpError(404, "Unknown export");
  const spec = make(params);
  if (spec.init) await spec.init();
  const stamp = new Date().toISOString().slice(0, 10);
  await stream(res, `${kind}-${stamp}.csv`, spec.header, spec.fetch, spec.row);
}

module.exports = { exportCsv, cell };
