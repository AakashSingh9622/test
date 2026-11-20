// Docbox "Devoluciones" (Phase 2, stage 7): records come back and are put back into their boxes. Staff give the internal
// codes (typed or scanned). Every code is checked first; if any is wrong NOTHING changes (rowErrors, like the imports).
// Each record goes on_loan -> archived with a history row, its request line is marked back, and a delivered request whose
// last record is back becomes "returned". The shelving list is the same records sorted by where their box is.
const prisma = require("../config/prisma");
const httpError = require("../utils/httpError");

const MAX_CODES = 200;
const MAX_NOTE = 500;
const text = (v) => (v == null ? "" : String(v).trim());

// Where to put a record back: a sortable key from its box's location, so a list reads in walking order.
function placeKey(p) {
  const loc = p && typeof p === "object" ? p : {};
  const num = (n) => String(Number.isFinite(Number(n)) ? Number(n) : 0).padStart(4, "0");
  return [loc.site || "", loc.warehouse || "", loc.zone || "", loc.aisle || "", loc.rack || "", num(loc.shelf), num(loc.position)].join("|");
}

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
const byPlace = (a, b) => placeKey(a.location).localeCompare(placeKey(b.location)) || a.boxNumber.localeCompare(b.boxNumber) || a.internalCode - b.internalCode;

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

  const records = await prisma.archiveRecord.findMany({ where: { internalCode: { in: wanted.map((w) => w.code) } } });
  const byCode = new Map(records.map((r) => [r.internalCode, r]));
  const lines = records.length
    ? await prisma.recordRequestLine.findMany({
        where: { recordId: { in: records.map((r) => r.id) }, returnedAt: null, request: { status: { in: ["requested", "delivered"] } } },
        include: { request: true },
      })
    : [];
  const openLine = new Map(lines.map((l) => [l.recordId, l]));
  for (const { code, row } of wanted) {
    const rec = byCode.get(code);
    if (!rec) errors.push({ row, message: `No record has internal code ${code}` });
    else if (rec.status !== "on_loan") errors.push({ row, message: `${code} is ${rec.status.replace("_", " ")}, not on loan — nothing to return` });
    else {
      const line = openLine.get(rec.id);
      if (line && line.request.status === "requested") errors.push({ row, message: `${code}: ${line.request.requestNumber} isn't marked delivered yet — mark it delivered first` });
    }
  }
  if (errors.length) {
    errors.sort((a, b) => a.row - b.row);
    const err = httpError(422, `${errors.length} code${errors.length === 1 ? " has" : "s have"} problems — nothing was returned`);
    err.errorCode = "RETURN_INVALID";
    err.rowErrors = errors;
    throw err;
  }

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

  const withBox = await prisma.archiveRecord.findMany({ where: { id: { in: ids } }, include: { box: { select: { locationPath: true } } } });
  const items = withBox.map((r) => shelvingItem(r, { requestNumber: openLine.get(r.id)?.request.requestNumber })).sort(byPlace);
  return { count: items.length, closedRequests: closed.sort(), items };
}

// The shelving list of records already returned (to reprint it): ids -> the records with their box's place, in walking order.
async function shelvingList(idsParam) {
  const ids = String(idsParam || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) throw httpError(400, "ids is required");
  if (ids.length > 500) throw httpError(400, "Too many ids");
  const rows = await prisma.archiveRecord.findMany({ where: { id: { in: ids } }, include: { box: { select: { locationPath: true } } } });
  return { items: rows.map((r) => shelvingItem(r)).sort(byPlace) };
}

module.exports = { returnRecords, shelvingList, MAX_CODES };
