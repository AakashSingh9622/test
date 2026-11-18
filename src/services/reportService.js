// Reports (Docbox "Informes"): requests by type and urgency per client, and the archive by client and box size.
// Small result sets, computed in the database -- the screen shows them and offers them as CSV.
const prisma = require("../config/prisma");
const httpError = require("../utils/httpError");
const { getBoxSizeNames } = require("./boxSizeService");
const { toDate, dateOnly } = require("../utils/serialize");
const { parsePagination } = require("../utils/pagination");
const { locationText } = require("../utils/locationPath");

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

// Loan requests (dispatch = physical, digitize = digital) created in the period, per client: how many orders and
// boxes, urgent vs normal. Cancelled and rejected requests are left out.
async function loansReport(params) {
  const where = { type: { in: ["dispatch", "digitize"] }, status: { notIn: ["cancelled", "rejected"] } };
  if (params.clientId) where.clientId = String(params.clientId);
  const at = period(params);
  if (at) where.createdAt = at;
  const groups = await prisma.order.groupBy({
    by: ["clientId", "clientName", "type", "urgent", "loanType"],
    where,
    _count: { _all: true },
    _sum: { boxCount: true },
  });
  const byClient = new Map();
  for (const g of groups) {
    const row =
      byClient.get(g.clientId) ??
      { clientId: g.clientId, clientName: g.clientName, physicalUrgent: 0, physicalNormal: 0, physicalSuperior: 0, digitalUrgent: 0, digitalNormal: 0, digitalSuperior: 0, fax: 0, orders: 0, boxes: 0 };
    // Orders made before loan types existed only have the urgent flag.
    const kind = g.loanType ?? (g.urgent ? "urgent" : "normal");
    const key = kind === "fax" ? "fax" : (g.type === "dispatch" ? "physical" : "digital") + (kind === "superior" ? "Superior" : kind === "urgent" ? "Urgent" : "Normal");
    row[key] += g._count._all;
    row.orders += g._count._all;
    row.boxes += g._sum.boxCount ?? 0;
    byClient.set(g.clientId, row);
  }
  return { rows: [...byClient.values()].sort((a, b) => a.clientName.localeCompare(b.clientName)) };
}

// The archive: boxes per client, box size and status (destroyed boxes excluded unless asked), plus the number of
// recorded contents (files inside boxes) per client.
async function archiveReport(params) {
  const where = {};
  if (params.clientId) where.clientId = String(params.clientId);
  if (params.status) where.status = String(params.status);
  else where.status = { not: "destroyed" };
  const [groups, names, contents] = await Promise.all([
    prisma.box.groupBy({ by: ["clientId", "clientName", "size", "status"], where, _count: { _all: true } }),
    getBoxSizeNames(),
    prisma.$queryRaw`SELECT b."clientId" AS "clientId", COUNT(*)::int AS "records" FROM box_content bc JOIN box b ON b.id = bc."boxId" GROUP BY b."clientId"`,
  ]);
  const records = new Map(contents.map((r) => [r.clientId, r.records]));
  const rows = groups
    .map((g) => ({
      clientId: g.clientId,
      clientName: g.clientName,
      size: names[g.size] ?? g.size,
      status: g.status,
      boxes: g._count._all,
    }))
    .sort((a, b) => a.clientName.localeCompare(b.clientName) || a.size.localeCompare(b.size) || a.status.localeCompare(b.status));
  return { rows, records: Object.fromEntries(records) };
}

// Docbox "Intercalado por cliente": the files (recorded contents) filed inside each box. One row per box that holds
// at least one record, with how many and the filing dates they cover. Paged on the server.
function interfilingWhere(params) {
  const where = { contents: { some: {} }, status: params.status ? String(params.status) : { not: "destroyed" } };
  if (params.clientId) where.clientId = String(params.clientId);
  return where;
}

async function interfilingReport(params) {
  const where = interfilingWhere(params);
  const { skip, take } = parsePagination(params);
  const [boxes, total] = await Promise.all([
    prisma.box.findMany({ where, orderBy: [{ clientName: "asc" }, { boxNumber: "asc" }], skip, take }),
    prisma.box.count({ where }),
  ]);
  const stats = await prisma.boxContent.groupBy({
    by: ["boxId"],
    where: { boxId: { in: boxes.map((b) => b.id) } },
    _count: { _all: true },
    _min: { dateFrom: true },
    _max: { dateTo: true },
  });
  const byBox = new Map(stats.map((s) => [s.boxId, s]));
  const items = boxes.map((b) => {
    const s = byBox.get(b.id);
    return {
      boxId: b.id,
      boxNumber: b.boxNumber,
      clientId: b.clientId,
      clientName: b.clientName,
      status: b.status,
      location: locationText(b.locationPath) || undefined,
      records: s?._count._all ?? 0,
      filedFrom: dateOnly(s?._min.dateFrom) || undefined,
      filedTo: dateOnly(s?._max.dateTo) || undefined,
    };
  });
  return { items, total };
}

module.exports = { loansReport, archiveReport, interfilingReport, interfilingWhere };
