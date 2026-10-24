// CSV exports (spec §3 "search and export", pilot exit criteria): inventory, movements, audit history, charges.
// Rows are read in pages of 1000 and written to the response as they come, so a big export never sits in memory.
const prisma = require("../config/prisma");
const httpError = require("../utils/httpError");
const { dateOnly, toDate } = require("../utils/serialize");
const { locationText } = require("../utils/locationPath");

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
    const where = {};
    if (params.clientId) where.clientId = params.clientId;
    if (params.status) where.status = params.status;
    else where.status = { not: "destroyed" };
    return {
      header: ["Box number", "Barcode", "Client id", "Client", "Description", "Department", "Reference", "Filing from", "Filing to", "Destroy after", "Retention category", "Size", "Status", "On hold", "Location", "Registered"],
      fetch: (skip, take) => prisma.box.findMany({ where, orderBy: [{ clientName: "asc" }, { boxNumber: "asc" }], skip, take }),
      row: (b) => [b.boxNumber, b.barcode, b.clientId, b.clientName, b.description, b.department, b.reference, dateOnly(b.filingDateFrom), dateOnly(b.filingDateTo), dateOnly(b.destroyAfter), b.retentionCategory, b.size, b.status, b.onHold ? "yes" : "no", locationText(b.locationPath), dateOnly(b.createdAt)],
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
  const stamp = new Date().toISOString().slice(0, 10);
  await stream(res, `${kind}-${stamp}.csv`, spec.header, spec.fetch, spec.row);
}

module.exports = { exportCsv, cell };
