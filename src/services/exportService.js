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

// --- Docbox "Exportar Archivo a Excel" (Phase 2, Item 2): the RECORDS inventory --------------------------------------------------------
// One row per archive record (not per box), with the internal code the purge / move files need. The filters are the form of the PDF's step 10:
// client, file, site, warehouse, floor/block (zone), aisle, module (rack), row, box / container / pallet ranges -- plus the record's status.
// The location filters look at the record's box's slot (a box with no slot has no warehouse, so it drops out as soon as one is used).
// Default status = everything except destroyed (Docbox only knows archived / on loan / in transit); destroyed only with status=destroyed.
const RECORD_EXPORT_STATUSES = ["archived", "on_loan", "in_transit", "destroyed"];
const RECORDS_FROM = Prisma.sql`FROM "archive_record" a JOIN "box" b ON b."id" = a."boxId"
  LEFT JOIN "slot" s ON s."id" = b."slotId" LEFT JOIN "rack" rk ON rk."id" = s."rackId" LEFT JOIN "zone" z ON z."id" = rk."zoneId"
  LEFT JOIN "aisle" ai ON ai."id" = rk."aisleId" LEFT JOIN "warehouse" w ON w."id" = s."warehouseId"`;

function recordsFilter(params) {
  const conds = [];
  const t = (v) => String(v).trim();
  const like = (v) => `%${t(v).replace(/[\\%_]/g, (c) => "\\" + c)}%`;
  if (params.clientId) conds.push(Prisma.sql`a."clientId" = ${String(params.clientId)}`);
  if (params.expediente) conds.push(Prisma.sql`lower(a."expedienteCode") = lower(${t(params.expediente)})`);
  if (params.status) {
    const st = t(params.status);
    if (!RECORD_EXPORT_STATUSES.includes(st)) throw httpError(400, `status must be one of ${RECORD_EXPORT_STATUSES.join(", ")}`);
    conds.push(Prisma.sql`a."status" = ${st}`);
  } else conds.push(Prisma.sql`a."status" <> 'destroyed'`);
  if (params.site) conds.push(Prisma.sql`lower(w."site") = lower(${t(params.site)})`);
  if (params.warehouse) conds.push(Prisma.sql`(lower(w."code") = lower(${t(params.warehouse)}) OR lower(w."name") = lower(${t(params.warehouse)}))`);
  if (params.warehouseId) conds.push(Prisma.sql`w."id" = ${String(params.warehouseId)}`);
  if (params.zone) conds.push(Prisma.sql`(lower(z."code") = lower(${t(params.zone)}) OR z."name" ILIKE ${like(params.zone)})`);
  if (params.aisle) conds.push(Prisma.sql`(lower(ai."code") = lower(${t(params.aisle)}) OR ai."name" ILIKE ${like(params.aisle)})`);
  if (params.rack) conds.push(Prisma.sql`lower(rk."code") = lower(${t(params.rack)})`);
  if (params.rackId) conds.push(Prisma.sql`rk."id" = ${String(params.rackId)}`);
  if (params.row !== undefined && t(params.row) !== "") {
    if (!/^\d{1,9}$/.test(t(params.row))) throw httpError(400, "row must be a whole number");
    conds.push(Prisma.sql`s."row" = ${Number(t(params.row))}`);
  }
  // Box range ("Nº Caja desde / hasta"): "125" means BX00000125; a full number is used as it is.
  const boxNo = (v) => (/^\d+$/.test(t(v)) ? `BX${t(v).padStart(8, "0")}` : t(v).toUpperCase());
  if (params.boxFrom && t(params.boxFrom)) conds.push(Prisma.sql`b."boxNumber" >= ${boxNo(params.boxFrom)}`);
  if (params.boxTo && t(params.boxTo)) conds.push(Prisma.sql`b."boxNumber" <= ${boxNo(params.boxTo)}`);
  // Container / pallet ranges: whole numbers; a box whose value is not a number is left out of a ranged export. The cast is guarded (CASE) so a
  // text value can never make the query fail.
  const range = (from, to, col, name) => {
    const whole = (v, n) => {
      if (v === undefined || v === null || t(v) === "") return undefined;
      if (!/^\d{1,15}$/.test(t(v))) throw httpError(400, `${n} must be a whole number`);
      return BigInt(t(v));
    };
    const lo = whole(from, name + "From");
    const hi = whole(to, name + "To");
    if (lo !== undefined && hi !== undefined && lo > hi) throw httpError(400, `The ${name} range ends before it starts`);
    const num = Prisma.sql`(CASE WHEN ${Prisma.raw(col)} ~ '^[0-9]{1,15}$' THEN (${Prisma.raw(col)})::bigint END)`;
    if (lo !== undefined) conds.push(Prisma.sql`${num} >= ${lo}`);
    if (hi !== undefined) conds.push(Prisma.sql`${num} <= ${hi}`);
  };
  range(params.containerFrom, params.containerTo, 'b."containerNo"', "container");
  range(params.palletFrom, params.palletTo, 'b."palletNo"', "pallet");
  return Prisma.join(conds, " AND ");
}

// How many rows the same filters give (the Excel screen checks it before it builds a file, and again against what it received).
async function countRecords(params) {
  const where = recordsFilter(params);
  const [r] = await prisma.$queryRaw(Prisma.sql`SELECT COUNT(*)::int AS n ${RECORDS_FROM} WHERE ${where}`);
  return r.n;
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
        spec.header = [...defsOf.get(clientId).map((d) => d.name), ...REGISTER, "Client", "Order number"];
      } else spec.header = ["Client", "Fields", ...REGISTER, "Order number"];
    };
    spec.fetch = async (skip, take) => {
      const byClient = clientId ? Prisma.sql` AND q."clientId" = ${clientId}` : Prisma.empty;
      const from = at && at.gte ? Prisma.sql` AND q."createdAt" >= ${at.gte}` : Prisma.empty;
      const to = at && at.lt ? Prisma.sql` AND q."createdAt" < ${at.lt}` : Prisma.empty;
      const rows = await prisma.$queryRaw(Prisma.sql`
        SELECT l."internalCode", q."requestNumber", q."loanType", q."contactEmail", q."contactName", q."createdAt" AS "requestedAt", q."deliveredAt", q."orderNumber",
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
      if (clientId) return [...defsOf.get(clientId).map((d) => (applies(d, r) ? value(d, r) : "")), ...register, r.clientName, r.orderNumber];
      const fields = (defsOf.get(r.clientId) || [])
        .filter((d) => applies(d, r) && value(d, r) !== "")
        .map((d) => `${d.name}: ${value(d, r)}`)
        .join("; ");
      return [r.clientName, fields, ...register, r.orderNumber];
    };
    return spec;
  },
  // Docbox "returns shelving sheet" for RECORDS (Phase 2, item 10c): the records that came back, with the physical location of their box,
  // so they can be shelved. Two ways to ask: ids=<record ids> (exactly the records just returned, at most 500) or a return period
  // (from / to, optionally one client). Only records that are BACK IN STORAGE are listed -- one that was lent out again is not -- and each
  // record appears ONCE, from its LATEST return (issue date = when that loan was delivered). Order = the pick list's walking order (warehouse,
  // zone, aisle, rack, shelf, position, box; Site is NOT in the order; a box with no location LAST) -- the same as the Return Records list and
  // the printed list. The location is split into columns (Site is only shown); a missing part is blank. With one client the client's own
  // ACTIVE field names are columns; with several, one "Fields" column. loans / toshelve / record-loans are untouched.
  "record-shelving": (params) => {
    const { locationColumns, placeParts, compareByPlace } = require("../utils/locationPath");
    const byIds = params.ids !== undefined;
    let ids = [];
    if (byIds) {
      ids = String(params.ids).split(",").map((x) => x.trim()).filter(Boolean);
      if (ids.length === 0) throw httpError(400, "ids is empty");
      if (ids.length > 500) throw httpError(400, "At most 500 records at a time");
    }
    const clientId = params.clientId ? String(params.clientId) : "";
    const at = period(params);
    const MAX = 20000;
    const LOCATION = ["Site", "Warehouse", "Block/Floor", "Aisle", "Shelving unit/Module", "Row/Shelf", "Position", "Box No."];
    const TAIL = ["Issue date", "Internal code", "Returned on", "Request", "Client"];
    const defsOf = new Map(); // clientId -> its ACTIVE field definitions in position order
    const loadDefs = async (clientIds) => {
      const need = clientIds.filter((id) => !defsOf.has(id));
      if (!need.length) return;
      const defs = await prisma.customFieldDef.findMany({ where: { clientId: { in: need }, active: true }, orderBy: [{ position: "asc" }, { code: "asc" }] });
      for (const id of need) defsOf.set(id, defs.filter((d) => d.clientId === id));
    };
    const applies = (def, rec) => def.expedienteId == null || def.expedienteId === rec.expedienteId;
    const value = (def, rec) => {
      const v = rec.fields && typeof rec.fields === "object" ? rec.fields[def.code] : undefined;
      return v === undefined || v === null ? "" : String(v);
    };
    let rows = null; // every row, sorted in walking order (loaded once)
    let oneClient = ""; // the client whose field names are columns ("" = several, so one Fields column)
    const spec = { header: [] };
    const load = async () => {
      if (rows) return;
      const byId = byIds ? Prisma.sql` AND a."id" IN (${Prisma.join(ids)})` : Prisma.empty;
      const byClient = clientId ? Prisma.sql` AND a."clientId" = ${clientId}` : Prisma.empty;
      const needReturn = byIds ? Prisma.empty : Prisma.sql` AND l."returnedAt" IS NOT NULL`;
      const from = !byIds && at && at.gte ? Prisma.sql` AND l."returnedAt" >= ${at.gte}` : Prisma.empty;
      const to = !byIds && at && at.lt ? Prisma.sql` AND l."returnedAt" < ${at.lt}` : Prisma.empty;
      const got = await prisma.$queryRaw(Prisma.sql`
        SELECT a."internalCode", a."clientId", a."clientName", a."expedienteId", a."boxNumber", a."fields", b."locationPath",
               s."row" AS "slotRow", s."column" AS "slotColumn", w."code" AS "slotWarehouse", rk."code" AS "slotRack", z."code" AS "slotZone", ai."code" AS "slotAisle",
               l."returnedAt", q."requestNumber", q."deliveredAt"
        FROM "archive_record" a
        JOIN "box" b ON b."id" = a."boxId"
        LEFT JOIN "slot" s ON s."id" = b."slotId"
        LEFT JOIN "rack" rk ON rk."id" = s."rackId"
        LEFT JOIN "zone" z ON z."id" = rk."zoneId"
        LEFT JOIN "aisle" ai ON ai."id" = rk."aisleId"
        LEFT JOIN "warehouse" w ON w."id" = s."warehouseId"
        LEFT JOIN LATERAL (
          SELECT l2."returnedAt", l2."requestId" FROM "record_request_line" l2
          WHERE l2."recordId" = a."id" AND l2."returnedAt" IS NOT NULL
          ORDER BY l2."returnedAt" DESC, l2."id" DESC LIMIT 1
        ) l ON TRUE
        LEFT JOIN "record_request" q ON q."id" = l."requestId"
        WHERE a."status" = 'archived'${byId}${byClient}${needReturn}${from}${to}
        LIMIT ${MAX + 1}`);
      if (got.length > MAX) throw httpError(400, `More than ${MAX} records -- narrow the dates or choose a client`);
      for (const r of got) {
        const live = r.slotRow !== null && r.slotRow !== undefined ? { row: r.slotRow, column: r.slotColumn, warehouse: { code: r.slotWarehouse }, rack: { code: r.slotRack, zone: r.slotZone ? { code: r.slotZone } : null, aisle: r.slotAisle ? { code: r.slotAisle } : null } } : null;
        r._parts = placeParts({ slot: live, locationPath: r.locationPath });
      }
      got.sort((x, y) => compareByPlace(x._parts, y._parts) || x.boxNumber.localeCompare(y.boxNumber) || x.internalCode - y.internalCode);
      rows = got;
      const clients = [...new Set(rows.map((r) => r.clientId))];
      oneClient = clientId || (clients.length === 1 ? clients[0] : "");
    };
    spec.init = async () => {
      await load();
      if (oneClient) {
        await loadDefs([oneClient]);
        spec.header = [...LOCATION, ...defsOf.get(oneClient).map((d) => d.name), ...TAIL];
      } else {
        await loadDefs([...new Set(rows.map((r) => r.clientId))]);
        spec.header = [...LOCATION, "Fields", ...TAIL];
      }
    };
    spec.fetch = async (skip, take) => rows.slice(skip, skip + take);
    spec.row = (r) => {
      const c = locationColumns(r.locationPath);
      const place = [c.site, c.warehouse, c.zone, c.aisle, c.rack, c.shelf, c.position, r.boxNumber];
      const tail = [dateOnly(r.deliveredAt), r.internalCode, dateOnly(r.returnedAt), r.requestNumber, r.clientName];
      if (oneClient) return [...place, ...defsOf.get(oneClient).map((d) => (applies(d, r) ? value(d, r) : "")), ...tail];
      const fields = (defsOf.get(r.clientId) || [])
        .filter((d) => applies(d, r) && value(d, r) !== "")
        .map((d) => `${d.name}: ${value(d, r)}`)
        .join("; ");
      return [...place, fields, ...tail];
    };
    return spec;
  },
  // Docbox "Exportar Archivo a Excel" (Item 2): the records inventory. One row per RECORD. Columns: the client's own ACTIVE fields (one client: a
  // column each; several clients: one "Fields" column "Name: value; ..."; a per-file field only for that file's records), then Internal code, Status
  // and the template's Docbox columns (the same names as the import template, so the file also feeds Purge / Move, which read Internal code, File and
  // Customer). Order = internal code ascending, read with KEYSET paging (internalCode > last): unique, never reused and indexed, so no record is
  // skipped or sent twice however the table changes while the file is written. The location comes from the box's live slot, else its stored snapshot.
  records: (params) => {
    const { locationColumns } = require("../utils/locationPath");
    const where = recordsFilter(params);
    const TAIL = ["Internal code", "Status", "Block/Floor", "Aisle", "Shelving unit/Module", "Row/Shelf", "Pallet No.", "Site", "Warehouse", "NCE", "TYPECE", "Box No.", "Box Type", "File", "Customer", "Comments"];
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
    let oneClient = ""; // "" = several clients (one Fields column)
    let sizeNames = null;
    let last = 0; // the keyset cursor: the highest internal code sent so far
    const spec = { header: [] };
    spec.init = async () => {
      sizeNames = await getBoxSizeNames();
      if (params.clientId) oneClient = String(params.clientId);
      else {
        const some = await prisma.$queryRaw(Prisma.sql`SELECT DISTINCT a."clientId" AS "clientId" ${RECORDS_FROM} WHERE ${where} LIMIT 2`);
        if (some.length === 1) oneClient = some[0].clientId;
      }
      if (oneClient) {
        await loadDefs([oneClient]);
        spec.header = [...defsOf.get(oneClient).map((d) => d.name), ...TAIL];
      } else spec.header = ["Fields", ...TAIL];
    };
    spec.fetch = async (_skip, take) => {
      const rows = await prisma.$queryRaw(Prisma.sql`
        SELECT a."internalCode", a."status", a."clientId", a."clientName", a."expedienteId", a."expedienteCode", a."boxNumber", a."fields", a."comments",
               b."locationPath", b."palletNo", b."containerNo", b."containerType", b."size",
               s."id" AS "slotId", s."row" AS "slotRow", rk."code" AS "rackCode", z."code" AS "zoneCode", ai."code" AS "aisleCode", w."code" AS "whCode", w."site" AS "whSite"
        ${RECORDS_FROM}
        WHERE ${where} AND a."internalCode" > ${last}
        ORDER BY a."internalCode" ASC
        LIMIT ${take}`);
      if (rows.length) last = rows[rows.length - 1].internalCode;
      if (!oneClient) await loadDefs([...new Set(rows.map((r) => r.clientId))]);
      return rows;
    };
    spec.row = (r) => {
      const loc = r.slotId
        ? { site: r.whSite ?? "", warehouse: r.whCode ?? "", zone: r.zoneCode ?? "", aisle: r.aisleCode ?? "", rack: r.rackCode ?? "", shelf: String(r.slotRow ?? "") }
        : locationColumns(r.locationPath);
      const tail = [r.internalCode, r.status, loc.zone, loc.aisle, loc.rack, loc.shelf, r.palletNo, loc.site, loc.warehouse, r.containerNo, r.containerType, r.boxNumber, sizeNames?.[r.size] ?? r.size, r.expedienteCode, r.clientId, r.comments];
      if (oneClient) return [...defsOf.get(oneClient).map((d) => (applies(d, r) ? value(d, r) : "")), ...tail];
      const fields = (defsOf.get(r.clientId) || [])
        .filter((d) => applies(d, r) && value(d, r) !== "")
        .map((d) => `${d.name}: ${value(d, r)}`)
        .join("; ");
      return [fields, ...tail];
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

module.exports = { exportCsv, cell, countRecords };
