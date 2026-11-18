// Reports (Docbox "Informes"): requests by type and urgency per client, and the archive by client and box size.
// Small result sets, computed in the database -- the screen shows them and offers them as CSV.
const prisma = require("../config/prisma");
const { Prisma } = prisma;
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

const LOAN_KINDS = ["normal", "urgent", "superior", "fax"];

// Loan requests (dispatch = physical, digitize = digital) created in the period, per client: how many orders and
// boxes, by loan type. Cancelled and rejected requests are left out. Docbox "Listado peticiones" filters: expediente,
// "Solicitado por" (part of the contact's email or name), "Tipo peticion" (request channel) and "Tipo prestamo".
// `byExpediente` ("Desglosar por expediente") splits every client by the file the boxes belong to (the order's boxes, so
// an order with boxes from two files counts once in each).
async function loansReport(params) {
  const byExpediente = params.byExpediente === "true" || params.byExpediente === true;
  const viaLines = byExpediente || !!params.expedienteId;
  const conds = [Prisma.sql`o."type"::text IN ('dispatch', 'digitize')`, Prisma.sql`o."status"::text NOT IN ('cancelled', 'rejected')`];
  if (params.clientId) conds.push(Prisma.sql`o."clientId" = ${String(params.clientId)}`);
  const at = period(params);
  if (at?.gte) conds.push(Prisma.sql`o."createdAt" >= ${at.gte}`);
  if (at?.lt) conds.push(Prisma.sql`o."createdAt" < ${at.lt}`);
  if (params.requester) {
    const like = `%${String(params.requester).trim().slice(0, 100).replace(/[\\%_]/g, (ch) => "\\" + ch)}%`;
    conds.push(Prisma.sql`(o."contactEmail" ILIKE ${like} OR o."contactName" ILIKE ${like})`);
  }
  if (params.requestChannel) conds.push(Prisma.sql`o."requestChannel" = ${String(params.requestChannel)}`);
  if (params.loanType) {
    const lt = String(params.loanType);
    if (!LOAN_KINDS.includes(lt)) throw httpError(400, `loanType must be one of ${LOAN_KINDS.join(", ")}`);
    // Orders made before loan types existed only have the urgent flag.
    const legacy = lt === "normal" ? Prisma.sql` OR (o."loanType" IS NULL AND o."urgent" = false)` : lt === "urgent" ? Prisma.sql` OR (o."loanType" IS NULL AND o."urgent" = true)` : Prisma.empty;
    conds.push(Prisma.sql`(o."loanType" = ${lt}${legacy})`);
  }
  if (params.expedienteId) conds.push(Prisma.sql`b."expedienteId" = ${String(params.expedienteId)}`);
  const where = Prisma.join(conds, " AND ");
  const exp = byExpediente ? Prisma.sql`COALESCE(b."expedienteCode", '')` : Prisma.sql`''`;
  const groupExp = byExpediente ? Prisma.sql`, ${exp}` : Prisma.empty;
  const groups = viaLines
    ? await prisma.$queryRaw`
        SELECT o."clientId" AS "clientId", o."clientName" AS "clientName", o."type"::text AS "type", o."urgent" AS "urgent",
               o."loanType" AS "loanType", ${exp} AS "exp", COUNT(DISTINCT o."id")::int AS "orders", COUNT(*)::int AS "boxes"
        FROM "order" o
        JOIN "order_line" ol ON ol."orderId" = o."id" AND ol."status"::text <> 'removed'
        LEFT JOIN "box" b ON b."id" = ol."boxId"
        WHERE ${where}
        GROUP BY o."clientId", o."clientName", o."type", o."urgent", o."loanType"${groupExp}`
    : await prisma.$queryRaw`
        SELECT o."clientId" AS "clientId", o."clientName" AS "clientName", o."type"::text AS "type", o."urgent" AS "urgent",
               o."loanType" AS "loanType", '' AS "exp", COUNT(*)::int AS "orders", COALESCE(SUM(o."boxCount"), 0)::int AS "boxes"
        FROM "order" o
        WHERE ${where}
        GROUP BY o."clientId", o."clientName", o."type", o."urgent", o."loanType"`;
  const byRow = new Map();
  for (const g of groups) {
    const rowKey = `${g.clientId}|${g.exp}`;
    const row =
      byRow.get(rowKey) ??
      { clientId: g.clientId, clientName: g.clientName, expedienteCode: byExpediente ? g.exp || undefined : undefined, physicalUrgent: 0, physicalNormal: 0, physicalSuperior: 0, digitalUrgent: 0, digitalNormal: 0, digitalSuperior: 0, fax: 0, orders: 0, boxes: 0 };
    const kind = g.loanType ?? (g.urgent ? "urgent" : "normal");
    const key = kind === "fax" ? "fax" : (g.type === "dispatch" ? "physical" : "digital") + (kind === "superior" ? "Superior" : kind === "urgent" ? "Urgent" : "Normal");
    row[key] += g.orders;
    row.orders += g.orders;
    row.boxes += g.boxes;
    byRow.set(rowKey, row);
  }
  return { rows: [...byRow.values()].sort((a, b) => a.clientName.localeCompare(b.clientName) || (a.expedienteCode ?? "").localeCompare(b.expedienteCode ?? "")) };
}

// Who asked ("Solicitado por"): the contacts that have made loan requests, for the report's picker.
async function requestersReport(params) {
  const where = { type: { in: ["dispatch", "digitize"] }, contactEmail: { not: null } };
  if (params.clientId) where.clientId = String(params.clientId);
  const rows = await prisma.order.groupBy({ by: ["contactEmail", "contactName"], where, _count: { _all: true }, orderBy: { contactEmail: "asc" }, take: 200 });
  return rows.map((r) => ({ email: r.contactEmail, name: r.contactName ?? undefined, orders: r._count._all }));
}

// Docbox "Estado" (Archivado / Prestado / Transito) as the box statuses behind it.
const STATE_GROUPS = { archived: ["stored", "reserved"], loan: ["out"], transit: ["picked", "received"] };

// The filters of the archive reports, as SQL conditions on box "b" (with its warehouse "w"): client, expediente, state,
// site (Sede), warehouse (Almacen) and the entry-date period. Used by both the box count and the contents / container counts.
function archiveConditions(params) {
  const conds = [];
  if (params.clientId) conds.push(Prisma.sql`b."clientId" = ${String(params.clientId)}`);
  if (params.expedienteId) conds.push(Prisma.sql`b."expedienteId" = ${String(params.expedienteId)}`);
  const statuses = params.status ? [String(params.status)] : STATE_GROUPS[params.state];
  if (statuses) conds.push(Prisma.sql`b."status"::text IN (${Prisma.join(statuses)})`);
  else conds.push(Prisma.sql`b."status"::text <> 'destroyed'`);
  if (params.site) conds.push(Prisma.sql`lower(w."site") = lower(${String(params.site).trim()})`);
  if (params.warehouse) {
    const wanted = String(params.warehouse).trim();
    conds.push(Prisma.sql`(lower(w."code") = lower(${wanted}) OR lower(w."name") = lower(${wanted}))`);
  }
  const at = period({ from: params.from, to: params.to });
  if (at?.gte) conds.push(Prisma.sql`COALESCE(b."entryDate", b."createdAt") >= ${at.gte}`);
  if (at?.lt) conds.push(Prisma.sql`COALESCE(b."entryDate", b."createdAt") < ${at.lt}`);
  return Prisma.join(conds, " AND ");
}

// The archive (Docbox "Listado archivo"): boxes per client, box size and status (destroyed boxes excluded unless asked),
// the recorded contents (files inside boxes) and the containers (NCE). `byExpediente` ("Cajas y contenedores por cliente y
// expediente") splits every row by the client's file too; the count maps are then keyed "clientId|expedienteCode".
async function archiveReport(params) {
  const byExpediente = params.byExpediente === "true" || params.byExpediente === true;
  const conds = archiveConditions(params);
  const exp = byExpediente ? Prisma.sql`COALESCE(b."expedienteCode", '')` : Prisma.sql`''`;
  const groupExp = byExpediente ? Prisma.sql`, ${exp}` : Prisma.empty;
  const joins = Prisma.sql`LEFT JOIN "slot" s ON s."id" = b."slotId" LEFT JOIN "warehouse" w ON w."id" = s."warehouseId"`;
  const [groups, names, contents, containers] = await Promise.all([
    prisma.$queryRaw`
      SELECT b."clientId" AS "clientId", b."clientName" AS "clientName", b."size" AS "size", b."status"::text AS "status",
             ${exp} AS "exp", COUNT(*)::int AS "boxes"
      FROM "box" b ${joins} WHERE ${conds}
      GROUP BY b."clientId", b."clientName", b."size", b."status"${groupExp}`,
    getBoxSizeNames(),
    prisma.$queryRaw`
      SELECT b."clientId" AS "clientId", ${exp} AS "exp", COUNT(*)::int AS "records"
      FROM "box_content" bc JOIN "box" b ON b."id" = bc."boxId" ${joins} WHERE ${conds}
      GROUP BY b."clientId"${groupExp}`,
    prisma.$queryRaw`
      SELECT b."clientId" AS "clientId", ${exp} AS "exp", COUNT(DISTINCT NULLIF(b."containerNo", ''))::int AS "containers"
      FROM "box" b ${joins} WHERE ${conds}
      GROUP BY b."clientId"${groupExp}`,
  ]);
  const key = (clientId, e) => (byExpediente ? `${clientId}|${e}` : clientId);
  const rows = groups
    .map((g) => ({
      clientId: g.clientId,
      clientName: g.clientName,
      expedienteCode: byExpediente ? g.exp || undefined : undefined,
      size: names[g.size] ?? g.size,
      status: g.status,
      boxes: g.boxes,
    }))
    .sort(
      (a, b) =>
        a.clientName.localeCompare(b.clientName) ||
        (a.expedienteCode ?? "").localeCompare(b.expedienteCode ?? "") ||
        a.size.localeCompare(b.size) ||
        a.status.localeCompare(b.status)
    );
  return {
    rows,
    records: Object.fromEntries(contents.map((r) => [key(r.clientId, r.exp), r.records])),
    containers: Object.fromEntries(containers.map((r) => [key(r.clientId, r.exp), r.containers])),
  };
}

// Docbox "Intercalado por cliente": the files (recorded contents) filed inside each box. One row per box that holds
// at least one record, with how many and the filing dates they cover. Paged on the server.
function interfilingWhere(params) {
  const statuses = params.status ? [String(params.status)] : STATE_GROUPS[params.state];
  const where = { contents: { some: {} }, status: statuses ? { in: statuses } : { not: "destroyed" } };
  if (params.clientId) where.clientId = String(params.clientId);
  if (params.expedienteId) where.expedienteId = String(params.expedienteId);
  const warehouse = {};
  if (params.site) warehouse.site = { equals: String(params.site).trim(), mode: "insensitive" };
  if (params.warehouse) {
    const wanted = String(params.warehouse).trim();
    warehouse.OR = [{ code: { equals: wanted, mode: "insensitive" } }, { name: { equals: wanted, mode: "insensitive" } }];
  }
  if (Object.keys(warehouse).length) where.slot = { warehouse };
  const at = period({ from: params.from, to: params.to });
  if (at) where.OR = [{ entryDate: at }, { entryDate: null, createdAt: at }];
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

module.exports = { requestersReport, loansReport, archiveReport, interfilingReport, interfilingWhere };
