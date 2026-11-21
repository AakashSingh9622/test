// Docbox "Devoluciones" (Phase 2, stage 7): records come back and are put back into their boxes. Staff give the internal
// codes (typed or scanned). Every code is checked first; if any is wrong NOTHING changes (rowErrors, like the imports).
// Each record goes on_loan -> archived with a history row, its request line is marked back, and a delivered request whose
// last record is back becomes "returned". The shelving list is the same records sorted by where their box is.
const prisma = require("../config/prisma");
const httpError = require("../utils/httpError");
const { placeParts, compareByPlace, BOX_ORDER_SELECT } = require("../utils/locationPath");

const MAX_CODES = 200;
const MAX_NOTE = 500;
const text = (v) => (v == null ? "" : String(v).trim());

function shelvingItem(rec, extra = {}) {
  const out = {
    id: rec.id,
    internalCode: rec.internalCode,
    clientId: rec.clientId,
    clientName: rec.clientName,
    boxNumber: rec.boxNumber,
    fields: rec.fields,
    comments: rec.comments,
    location: rec.box?.locationPath,
    requestNumber: extra.requestNumber,
  };
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}
// The shelving list in walking order -- the pick list's order (src/utils/locationPath.js): warehouse, zone, aisle, rack, shelf, position, box;
// a box with no location LAST. The Return Records screen, the printed list and the shelving Excel all use it.
function orderedItems(rows, extraOf) {
  return rows
    .map((r) => ({ parts: placeParts(r.box), item: shelvingItem(r, extraOf ? extraOf(r) : {}) }))
    .sort((x, y) => compareByPlace(x.parts, y.parts) || x.item.boxNumber.localeCompare(y.item.boxNumber) || x.item.internalCode - y.item.internalCode)
    .map((x) => x.item);
}

// The records behind some internal codes, and the open (not yet returned) request line of each.
async function loadForReturn(codeNumbers) {
  const records = codeNumbers.length ? await prisma.archiveRecord.findMany({ where: { internalCode: { in: codeNumbers } } }) : [];
  const byCode = new Map(records.map((r) => [r.internalCode, r]));
  const lines = records.length
    ? await prisma.recordRequestLine.findMany({
        where: { recordId: { in: records.map((r) => r.id) }, returnedAt: null, request: { status: { in: ["requested", "delivered"] } } },
        include: { request: true },
      })
    : [];
  return { records, byCode, lines, openLine: new Map(lines.map((l) => [l.recordId, l])) };
}

// Why this record can't be returned (null = it can). Used by the typed list and by the import.
function returnProblem(code, rec, openLine) {
  if (!rec) return `No record has internal code ${code}`;
  if (rec.status !== "on_loan") return `${code} is ${rec.status.replace("_", " ")}, not on loan — nothing to return`;
  const line = openLine.get(rec.id);
  if (line && line.request.status === "requested") return `${code}: ${line.request.requestNumber} isn't marked delivered yet — mark it delivered first`;
  return null;
}

// The returning itself (shared by the typed list and the import): all in one transaction.
async function applyReturn({ records, lines, openLine }, note, actor) {
  const ids = records.map((r) => r.id);
  const now = new Date();
  const tail = note ? `: ${note}` : "";
  const closed = await prisma.$transaction(
    async (tx) => {
      // The status filter is the real guard against someone else changing a record at the same moment.
      const back = await tx.archiveRecord.updateMany({ where: { id: { in: ids }, status: "on_loan" }, data: { status: "archived" } });
      if (back.count !== ids.length) throw httpError(409, "Some records changed while returning — try again");
      await tx.archiveRecordEvent.createMany({
        data: records.map((r) => {
          const line = openLine.get(r.id);
          return { recordId: r.id, type: "status_changed", note: `on_loan → archived: returned${line ? ` (${line.request.requestNumber})` : ""}${tail}`, actor };
        }),
      });
      const lineIds = lines.map((l) => l.id);
      if (lineIds.length) await tx.recordRequestLine.updateMany({ where: { id: { in: lineIds }, returnedAt: null }, data: { returnedAt: now, lockKey: null } }); // back: the record may be requested again
      // A delivered request with no record still out is finished.
      const closedNumbers = [];
      for (const requestId of new Set(lines.map((l) => l.requestId))) {
        const still = await tx.recordRequestLine.count({ where: { requestId, returnedAt: null } });
        if (still === 0) {
          const moved = await tx.recordRequest.updateMany({ where: { id: requestId, status: "delivered" }, data: { status: "returned", closedAt: now, closedBy: actor } });
          if (moved.count === 1) {
            closedNumbers.push(lines.find((l) => l.requestId === requestId).request.requestNumber);
            await tx.recordRequestEvent.create({ data: { requestId, type: "returned", note: "The last record came back (returned by internal code)", actor } });
          }
        }
      }
      return closedNumbers;
    },
    { maxWait: 10_000, timeout: 60_000 },
  );

  const withBox = await prisma.archiveRecord.findMany({ where: { id: { in: ids } }, include: { box: { select: BOX_ORDER_SELECT } } });
  const items = orderedItems(withBox, (r) => ({ requestNumber: openLine.get(r.id)?.request.requestNumber }));
  return { count: items.length, closedRequests: closed.sort(), items };
}

//   input { codes: [1000003, ...] (internal codes), note? }
async function returnRecords(input, actor) {
  if (!Array.isArray(input.codes) || input.codes.length === 0) throw httpError(400, "codes (non-empty array) is required");
  if (input.codes.length > MAX_CODES) throw httpError(400, `At most ${MAX_CODES} records at a time`);
  const note = text(input.note);
  if (note.length > MAX_NOTE) throw httpError(400, `The note is too long (${MAX_NOTE} characters at most)`);

  // row = the code's position in the list (1-based), so a bad one can be pointed at
  const wanted = [];
  const seen = new Set();
  const errors = [];
  input.codes.forEach((raw, i) => {
    const s = text(raw);
    if (!/^\d{1,9}$/.test(s)) return errors.push({ row: i + 1, message: `"${s}" is not an internal code (digits only)` });
    const code = Number(s);
    if (seen.has(code)) return errors.push({ row: i + 1, message: `${code} is in the list twice` });
    seen.add(code);
    wanted.push({ code, row: i + 1 });
  });

  const loaded = await loadForReturn(wanted.map((w) => w.code));
  for (const { code, row } of wanted) {
    const problem = returnProblem(code, loaded.byCode.get(code), loaded.openLine);
    if (problem) errors.push({ row, message: problem });
  }
  if (errors.length) {
    errors.sort((a, b) => a.row - b.row);
    const err = httpError(422, `${errors.length} code${errors.length === 1 ? " has" : "s have"} problems — nothing was returned`);
    err.errorCode = "RETURN_INVALID";
    err.rowErrors = errors;
    throw err;
  }
  return applyReturn(loaded, note, actor);
}

// Docbox "Importar Devoluciones": the same return, but from a file (Excel: Internal code, File, Customer). ALL OR NOTHING: every row is
// checked first (`dryRun` only checks) and each bad row is named by its row in the file. The returning is applyReturn() -- the typed list's.
//   input { clientId, clientName?, dryRun?, note?, rows: [{ row?, internalCode, file?, customer? }] }
const MAX_IMPORT_ROWS = 500;
const norm = (s) => text(s).toLowerCase().replace(/\s+/g, " ");
async function importReturns(input, actor) {
  const clientId = input.clientId == null ? "" : String(input.clientId); // exact: a stored id can have spaces
  if (!clientId.trim()) throw httpError(400, "clientId is required");
  if (!Array.isArray(input.rows) || input.rows.length === 0) throw httpError(400, "rows (non-empty array) is required");
  if (input.rows.length > MAX_IMPORT_ROWS) throw httpError(400, `At most ${MAX_IMPORT_ROWS} rows per file — split it`);
  const note = text(input.note);
  if (note.length > MAX_NOTE) throw httpError(400, `The note is too long (${MAX_NOTE} characters at most)`);
  const clientName = text(input.clientName);

  const codeNumbers = [];
  for (const r of input.rows) {
    const s = text(r?.internalCode);
    if (/^\d{1,9}$/.test(s)) codeNumbers.push(Number(s));
  }
  const loaded = await loadForReturn(codeNumbers);

  const errors = [];
  const chosen = [];
  const seen = new Set();
  input.rows.forEach((raw, i) => {
    const r = raw && typeof raw === "object" ? raw : {};
    const rowNo = Number.isInteger(r.row) && r.row > 1 ? r.row : i + 2; // the header is row 1
    const problems = [];
    const codeText = text(r.internalCode);
    let rec = null;
    if (!codeText) problems.push("Internal code is required");
    else if (!/^\d{1,9}$/.test(codeText)) problems.push(`"${codeText}" is not an internal code (digits only)`);
    else {
      const code = Number(codeText);
      if (seen.has(code)) problems.push(`${code} is in the file twice`);
      else {
        seen.add(code);
        rec = loaded.byCode.get(code) || null;
        const customer = text(r.customer);
        if (customer && norm(customer) !== norm(clientId) && norm(customer) !== norm(clientName)) problems.push(`Customer "${customer}" is not this client`);
        if (rec && rec.clientId !== clientId) problems.push(`Record ${code} belongs to another client (${rec.clientName})`);
        else {
          const file = text(r.file);
          if (rec && file && norm(file) !== norm(rec.expedienteCode || "")) {
            problems.push(rec.expedienteCode ? `File "${file}" doesn't match the record's file "${rec.expedienteCode}"` : `Record ${code} has no file, but the row says "${file}"`);
          }
          const p = returnProblem(code, rec, loaded.openLine);
          if (p) problems.push(p);
        }
      }
    }
    if (problems.length) errors.push({ row: rowNo, message: problems.join("; ") });
    else chosen.push(rec);
  });
  if (errors.length) {
    errors.sort((a, b) => a.row - b.row);
    const err = httpError(422, `${errors.length} row${errors.length === 1 ? " has" : "s have"} problems — nothing was returned`);
    err.errorCode = "RETURN_IMPORT_INVALID";
    err.rowErrors = errors;
    throw err;
  }
  if (input.dryRun) return { dryRun: true, count: chosen.length };

  const ids = new Set(chosen.map((r) => r.id));
  const result = await applyReturn({ records: chosen, lines: loaded.lines.filter((l) => ids.has(l.recordId)), openLine: loaded.openLine }, note, actor);
  return { dryRun: false, ...result };
}

// The shelving list of records already returned (to reprint it): ids -> the records with their box's place, in walking order.
async function shelvingList(idsParam) {
  const ids = String(idsParam || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) throw httpError(400, "ids is required");
  if (ids.length > 500) throw httpError(400, "Too many ids");
  const rows = await prisma.archiveRecord.findMany({ where: { id: { in: ids } }, include: { box: { select: BOX_ORDER_SELECT } } });
  return { items: orderedItems(rows) };
}

module.exports = { returnRecords, importReturns, shelvingList, MAX_CODES, MAX_IMPORT_ROWS };
