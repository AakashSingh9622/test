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
    // Floor / aisle (Docbox "Bloque/Planta", "Pasillo"): by code, or part of the name, any letter case.
    const nameOrCode = (v) => ({ OR: [{ code: { equals: String(v).trim(), mode: "insensitive" } }, { name: { contains: String(v).trim(), mode: "insensitive" } }] });
    // Expediente (by its code, any letter case).
    if (params.expediente) where.expedienteCode = { equals: String(params.expediente).trim(), mode: "insensitive" };
    // Site (Docbox "Sede"): the site the warehouse belongs to.
    if (params.site) {
      where.slot = { ...(where.slot ?? {}), warehouse: { site: { equals: String(params.site).trim(), mode: "insensitive" } } };
    }
    if (params.zone || params.aisle) {
      where.slot = {
        ...(where.slot ?? {}),
        rack: { ...(params.zone && { zone: nameOrCode(params.zone) }), ...(params.aisle && { aisle: nameOrCode(params.aisle) }) },
      };
    }
    // Box number range ("Nº Caja desde / hasta"): "125" means BX00000125; a full number is used as it is.
    const boxNo = (v) => {
      const t = String(v).trim().toUpperCase();
      return /^\d+$/.test(t) ? `BX${t.padStart(8, "0")}` : t;
    };
    if (params.boxFrom || params.boxTo) {
      where.boxNumber = { ...(params.boxFrom && { gte: boxNo(params.boxFrom) }), ...(params.boxTo && { lte: boxNo(params.boxTo) }) };
    }
    // Pallet range ("Nº Palet desde / hasta"): whole numbers; a box whose pallet isn't a number is left out of a ranged export.
    const whole = (v, name) => {
      if (v === undefined || v === null || String(v).trim() === "") return undefined;
      if (!/^\d{1,15}$/.test(String(v).trim())) throw httpError(400, `${name} must be a whole number`);
      return BigInt(String(v).trim());
    };
    const palletFrom = whole(params.palletFrom, "palletFrom");
    const palletTo = whole(params.palletTo, "palletTo");
    if (palletFrom !== undefined && palletTo !== undefined && palletFrom > palletTo) throw httpError(400, "The pallet range ends before it starts");
    // Container range ("Nº Contenedor desde / hasta"): same rule as the pallet range.
    const containerFrom = whole(params.containerFrom, "containerFrom");
    const containerTo = whole(params.containerTo, "containerTo");
    if (containerFrom !== undefined && containerTo !== undefined && containerFrom > containerTo) throw httpError(400, "The container range ends before it starts");
    let fields = []; // the client's own fields -- extra columns, only when one client is exported
    const spec = {
      header: ["Box number", "Barcode", "Client id", "Client", "Expediente", "Description", "Department", "Reference", "Filing from", "Filing to", "Destroy after", "Retention category", "Size", "Status", "On hold", "Location", "Site", "Warehouse", "Floor", "Aisle", "Module", "Shelf", "Position", "Pallet", "Container number", "Container type", "Comments", "Entry date", "Registered"],
      init: async () => {
        if (palletFrom !== undefined || palletTo !== undefined) {
          const lo = palletFrom ?? 0n;
          const hi = palletTo ?? 999999999999999n;
          const ids = await prisma.$queryRaw`SELECT "id" FROM "box" WHERE "palletNo" ~ '^[0-9]{1,15}$' AND ("palletNo")::bigint BETWEEN ${lo} AND ${hi}`;
          where.id = { in: ids.map((r) => r.id) };
        }
        if (containerFrom !== undefined || containerTo !== undefined) {
          const lo = containerFrom ?? 0n;
          const hi = containerTo ?? 999999999999999n;
          const ids = await prisma.$queryRaw`SELECT "id" FROM "box" WHERE "containerNo" ~ '^[0-9]{1,15}$' AND ("containerNo")::bigint BETWEEN ${lo} AND ${hi}`;
          const inContainers = new Set(ids.map((r) => r.id));
          // both a pallet and a container range: the box must be in both
          where.id = { in: where.id ? where.id.in.filter((id) => inContainers.has(id)) : [...inContainers] };
        }
        if (!params.clientId) return;
        fields = await prisma.customFieldDef.findMany({ where: { clientId: String(params.clientId), active: true }, orderBy: { position: "asc" } });
        spec.header = [...spec.header, ...fields.map((f) => f.name)];
      },
      fetch: async (skip, take) => {
        sizeNames = sizeNames ?? (await getBoxSizeNames());
        return prisma.box.findMany({ where, orderBy: [{ clientName: "asc" }, { boxNumber: "asc" }], skip, take });
      },
      row: (b) => [b.boxNumber, b.barcode, b.clientId, b.clientName, b.expedienteCode, b.description, b.department, b.reference, dateOnly(b.filingDateFrom), dateOnly(b.filingDateTo), dateOnly(b.destroyAfter), b.retentionCategory, sizeNames?.[b.size] ?? b.size, b.status, b.onHold ? "yes" : "no", locationText(b.locationPath), b.locationPath?.site, b.locationPath?.warehouse, b.locationPath?.zone, b.locationPath?.aisle, b.locationPath?.rack, b.locationPath?.shelf, b.locationPath?.position, b.palletNo, b.containerNo, b.containerType, b.comments, dateOnly(b.entryDate ?? b.createdAt), dateOnly(b.createdAt), ...fields.map((f) => b.customFields?.[f.code])],
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
      row: (l) => [l.order.clientName, l.box?.boxNumber ?? l.boxNumber, l.box?.description, l.box?.department, l.box?.reference, l.order.orderNumber, l.order.loanType ?? (l.order.urgent ? "urgent" : "normal"), l.order.requestChannel, l.order.contactEmail, dateOnly(l.order.createdAt), dateOnly(l.order.completedAt), locationText(l.fromLocation)],
    };
  },
  // Docbox "loan register" for RECORDS (Phase 2, item 10b): every record that is ON LOAN right now -- one row per record, from its ONE current
  // physical loan (the open original request, accepted or delivered, not yet returned). Never listed: pending, returned and cancelled
  // requests (history), digital requests (the paper never left), destroyed records. A record is in at most one open request (unique
  // lockKey), so no record can appear twice. The client's own fields become columns (names, in order, only the ACTIVE ones); a
  // per-file field is filled only for records of that file; a switched-off or unknown field is never shown. Without a client there is
  // one "Fields" column ("Name: value; ...") using each record's own client's names. The box-level loans export above is untouched.
  "record-loans": (params) => {
    const clientId = params.clientId ? String(params.clientId) : "";
    const at = period(params);
    const REGISTER = ["Request date", "Requested by", "Internal code", "Issue date", "Request", "Urgency", "File", "Box number"];
    const defsOf = new Map(); // clientId -> its ACTIVE field definitions in position order
    const loadDefs = async (ids) => {
      const need = ids.filter((id) => !defsOf.has(id));
      if (!need.length) return;
      const defs = await prisma.customFieldDef.findMany({ where: { clientId: { in: need }, active: true }, orderBy: [{ position: "asc" }, { code: "asc" }] });
      for (const id of need) defsOf.set(id, defs.filter((d) => d.clientId === id));
    };
    const applies = (def, rec) => def.expedienteId == null || def.expedienteId === rec.expedienteId;
    const value = (def, rec) => {
      const v = rec.fields && typeof rec.fields === "object" ? rec.fields[def.code] : undefined;
      return v === undefined || v === null ? "" : String(v);
    };
    const spec = { header: [] };
    spec.init = async () => {
      if (clientId) {
        await loadDefs([clientId]);
        spec.header = [...defsOf.get(clientId).map((d) => d.name), ...REGISTER, "Client"];
      } else spec.header = ["Client", "Fields", ...REGISTER];
    };
    spec.fetch = async (skip, take) => {
      const byClient = clientId ? Prisma.sql` AND q."clientId" = ${clientId}` : Prisma.empty;
      const from = at && at.gte ? Prisma.sql` AND q."createdAt" >= ${at.gte}` : Prisma.empty;
      const to = at && at.lt ? Prisma.sql` AND q."createdAt" < ${at.lt}` : Prisma.empty;
      const rows = await prisma.$queryRaw(Prisma.sql`
        SELECT l."internalCode", q."requestNumber", q."loanType", q."contactEmail", q."contactName", q."createdAt" AS "requestedAt", q."deliveredAt",
               a."clientId", a."clientName", a."expedienteId", a."expedienteCode", a."boxNumber", a."fields"
        FROM "record_request_line" l
        JOIN "record_request" q ON q."id" = l."requestId"
        JOIN "archive_record" a ON a."id" = l."recordId"
        WHERE l."lockKey" IS NOT NULL AND l."returnedAt" IS NULL
          AND q."kind" = 'original' AND q."status" IN ('requested', 'delivered')
          AND a."status" = 'on_loan'${byClient}${from}${to}
        ORDER BY q."createdAt" ASC, l."internalCode" ASC, l."id" ASC
        LIMIT ${take} OFFSET ${skip}`);
      if (!clientId) await loadDefs([...new Set(rows.map((r) => r.clientId))]);
      return rows;
    };
    spec.row = (r) => {
      const register = [dateOnly(r.requestedAt), r.contactEmail || r.contactName, r.internalCode, dateOnly(r.deliveredAt), r.requestNumber, r.loanType, r.expedienteCode, r.boxNumber];
      if (clientId) return [...defsOf.get(clientId).map((d) => (applies(d, r) ? value(d, r) : "")), ...register, r.clientName];
      const fields = (defsOf.get(r.clientId) || [])
        .filter((d) => applies(d, r) && value(d, r) !== "")
        .map((d) => `${d.name}: ${value(d, r)}`)
        .join("; ");
      return [r.clientName, fields, ...register];
    };
    return spec;
  },
  // Docbox "Intercalado por cliente": every box that holds recorded files, and how many.
  interfiling: (params) => {
    const { interfilingWhere } = require("./reportService");
    const where = interfilingWhere(params);
    let stats = new Map();
    return {
      header: ["Client id", "Client", "Box number", "Barcode", "Status", "Location", "Records", "Filed from", "Filed to"],
      fetch: async (skip, take) => {
        const boxes = await prisma.box.findMany({ where, orderBy: [{ clientName: "asc" }, { boxNumber: "asc" }], skip, take });
        const g = await prisma.boxContent.groupBy({ by: ["boxId"], where: { boxId: { in: boxes.map((b) => b.id) } }, _count: { _all: true }, _min: { dateFrom: true }, _max: { dateTo: true } });
        stats = new Map(g.map((s) => [s.boxId, s]));
        return boxes;
      },
      row: (b) => [b.clientId, b.clientName, b.boxNumber, b.barcode, b.status, locationText(b.locationPath), stats.get(b.id)?._count._all ?? 0, dateOnly(stats.get(b.id)?._min.dateFrom), dateOnly(stats.get(b.id)?._max.dateTo)],
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
