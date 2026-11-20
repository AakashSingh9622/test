// Docbox "records" (Phase 2, stage 1): one folder / subfolder / contents row inside a box, with its own internal code
// (Docbox COD_INTERNO). Boxes, BoxContent and orders are not touched -- a client that doesn't use records has none.
// A record keeps its home box while it is lent out; `status` says where it is.
const prisma = require("../config/prisma");
const { Prisma } = prisma;
const httpError = require("../utils/httpError");
const { parsePagination } = require("../utils/pagination");
const { nextSequence } = require("./counterService");
const { cleanValuesOrThrow } = require("./customFieldService");

// The first internal code is RECORD_CODE_BASE + 1 (a 7-digit number, like Docbox's 7760941). Codes are never reused.
const RECORD_CODE_BASE = 1000000;
const STATUSES = ["archived", "on_loan", "in_transit", "destroyed"];
const EVENT_TYPES = ["created", "edited", "duplicated", "moved", "status_changed", "destroyed"];
const MAX_COMMENT = 500;

function serializeRecord(r) {
  const out = {
    id: r.id,
    internalCode: r.internalCode,
    clientId: r.clientId,
    clientName: r.clientName,
    expedienteId: r.expedienteId,
    expedienteCode: r.expedienteCode,
    boxId: r.boxId,
    boxNumber: r.boxNumber,
    status: r.status,
    fields: r.fields,
    comments: r.comments,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k]; // the frontend schemas use .optional(), not .nullable()
  return out;
}

function serializeEvent(e) {
  const out = { id: e.id, recordId: e.recordId, type: e.type, note: e.note, actor: e.actor, at: e.at.toISOString() };
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

function addEvent(tx, recordId, type, actor, note) {
  return tx.archiveRecordEvent.create({ data: { recordId, type, note: note ? String(note).slice(0, 500) : null, actor } });
}

function cleanComments(value) {
  const text = value == null ? "" : String(value).trim();
  if (text.length > MAX_COMMENT) throw httpError(400, `Comments are too long (${MAX_COMMENT} characters at most)`);
  return text || null;
}

// Creates one record inside `tx` (a Prisma transaction client), so a later bulk import can add many in one transaction.
//   input { boxId, fields?: { C1: "...", ... }, comments? } -- the client and expediente come from the box.
async function createRecordIn(tx, input, actor) {
  const prep = await prepareRecord(tx, input);
  const internalCode = RECORD_CODE_BASE + (await nextSequence("recordSeq", tx));
  return tx.archiveRecord.create({ data: recordData(prep, internalCode, actor) });
}

// Checks the input against the box and the client's own fields (all reads, nothing written).
async function prepareRecord(db, input) {
  const boxId = String(input.boxId || "").trim();
  if (!boxId) throw httpError(400, "boxId is required");
  const box = await db.box.findUnique({ where: { id: boxId } });
  if (!box) throw httpError(404, "Box not found");
  if (box.status === "destroyed" || box.status === "permanently_withdrawn") {
    throw httpError(400, `${box.boxNumber} is ${box.status === "destroyed" ? "destroyed" : "permanently withdrawn"}`);
  }
  const fields = await cleanValuesOrThrow(box.clientId, input.fields, { expedienteId: box.expedienteId });
  return { box, fields, comments: cleanComments(input.comments) };
}

// The row to insert, with its first history row ("created") written in the same INSERT -- one atomic statement.
function recordData({ box, fields, comments }, internalCode, actor, event) {
  return {
    internalCode,
    clientId: box.clientId,
    clientName: box.clientName,
    expedienteId: box.expedienteId ?? null,
    expedienteCode: box.expedienteCode ?? null,
    boxId: box.id,
    boxNumber: box.boxNumber,
    fields: Object.keys(fields).length ? fields : undefined,
    comments,
    createdBy: actor,
    events: { create: { type: event?.type || "created", note: event?.note || `Created in ${box.boxNumber}`, actor } },
  };
}

// The ONLY place a record's status changes (requests, loans, returns, purges and imports will all call it), so every
// change writes its history row in the same transaction. A change from the wrong current status is refused with 409,
// so two people acting on one record at once can't both succeed. `destroyed` is final.
const TRANSITIONS = {
  archived: ["on_loan", "in_transit", "destroyed"],
  on_loan: ["archived", "in_transit", "destroyed"],
  in_transit: ["archived", "on_loan", "destroyed"],
  destroyed: [],
};

async function setStatusIn(tx, recordId, to, actor, note) {
  if (!STATUSES.includes(to)) throw httpError(400, `status must be one of ${STATUSES.join(", ")}`);
  const row = await tx.archiveRecord.findUnique({ where: { id: recordId } });
  if (!row) throw httpError(404, "Record not found");
  if (row.status === to) throw httpError(409, `Record ${row.internalCode} is already ${to}`);
  if (!(TRANSITIONS[row.status] || []).includes(to)) throw httpError(409, `Record ${row.internalCode} is ${row.status} and can't become ${to}`);
  // Only succeeds if the status is still what we just read.
  const changed = await tx.archiveRecord.updateMany({ where: { id: recordId, status: row.status }, data: { status: to } });
  if (changed.count !== 1) throw httpError(409, `Record ${row.internalCode} was changed by someone else — try again`);
  await addEvent(tx, recordId, to === "destroyed" ? "destroyed" : "status_changed", actor, `${row.status} → ${to}${note ? `: ${note}` : ""}`);
  return tx.archiveRecord.findUnique({ where: { id: recordId } });
}

async function setStatus(recordId, to, actor, note) {
  const row = await prisma.$transaction((tx) => setStatusIn(tx, recordId, to, actor, note));
  return serializeRecord(row);
}

// One record. The checks run first, then the code is taken in ONE quick statement (so the counter row is locked for a
// single round trip, not for a whole transaction -- many people creating at once don't queue behind each other), then
// the record and its history row are inserted together. If that last insert fails the code is simply skipped: codes are
// unique and increasing, not guaranteed gap-free.
async function createRecord(input, actor) {
  const prep = await prepareRecord(prisma, input);
  const internalCode = RECORD_CODE_BASE + (await nextSequence("recordSeq"));
  const row = await prisma.archiveRecord.create({ data: recordData(prep, internalCode, actor) });
  return serializeRecord(row);
}

const show = (v) => (v === undefined || v === null || v === "" ? "—" : String(v));

// Docbox "Modificar": change the client's own fields (only the codes sent change; "" clears an optional one) and/or the
// comments. Destroyed records are final. One history row lists what changed. Two people saving at once: the second gets 409.
async function updateRecord(id, patch, actor) {
  const row = await prisma.archiveRecord.findUnique({ where: { id } });
  if (!row) throw httpError(404, "Record not found");
  if (row.status === "destroyed") throw httpError(409, `Record ${row.internalCode} is destroyed and can't be edited`);
  const data = {};
  const changes = [];
  if (patch.fields !== undefined) {
    const clean = await cleanValuesOrThrow(row.clientId, patch.fields, { partial: true, expedienteId: row.expedienteId });
    const current = row.fields && typeof row.fields === "object" ? row.fields : {};
    const defs = await prisma.customFieldDef.findMany({ where: { clientId: row.clientId } });
    const merged = { ...current };
    for (const code of Object.keys(patch.fields || {})) {
      const name = defs.find((d) => d.code === code)?.name ?? code;
      const next = clean[code];
      if (next === undefined) delete merged[code];
      else merged[code] = next;
      if (current[code] !== next) changes.push(`${name}: ${show(current[code])} → ${show(next)}`);
    }
    data.fields = Object.keys(merged).length ? merged : Prisma.DbNull;
  }
  if (patch.comments !== undefined) {
    const comments = cleanComments(patch.comments);
    if ((row.comments ?? null) !== comments) changes.push(`Comments: ${show(row.comments)} → ${show(comments)}`);
    data.comments = comments;
  }
  if (changes.length === 0) return serializeRecord(row);
  const updated = await prisma.$transaction(async (tx) => {
    const done = await tx.archiveRecord.updateMany({ where: { id, updatedAt: row.updatedAt }, data });
    if (done.count !== 1) throw httpError(409, `Record ${row.internalCode} was changed by someone else — reload it and try again`);
    await addEvent(tx, id, "edited", actor, changes.join("; "));
    return tx.archiveRecord.findUnique({ where: { id } });
  });
  return serializeRecord(updated);
}

// Docbox "Duplicar": a new record (new internal code) that starts as a copy of another -- same box unless `boxId` names
// another box of the same client -- with the fields / comments you send changed. The copy is archived whatever the
// original's status; a destroyed record can't be copied.
async function duplicateRecord(sourceId, input, actor) {
  const src = await prisma.archiveRecord.findUnique({ where: { id: sourceId } });
  if (!src) throw httpError(404, "Record not found");
  if (src.status === "destroyed") throw httpError(409, `Record ${src.internalCode} is destroyed and can't be copied`);
  const boxId = String(input.boxId || src.boxId);
  const prep = await prepareRecord(prisma, {
    boxId,
    fields: { ...(src.fields && typeof src.fields === "object" ? src.fields : {}), ...(input.fields && typeof input.fields === "object" ? input.fields : {}) },
    comments: input.comments !== undefined ? input.comments : src.comments,
  });
  if (prep.box.clientId !== src.clientId) throw httpError(400, "A copy must stay with the same client");
  const internalCode = RECORD_CODE_BASE + (await nextSequence("recordSeq"));
  const row = await prisma.archiveRecord.create({
    data: recordData(prep, internalCode, actor, { type: "duplicated", note: `Copy of ${src.internalCode}` }),
  });
  return serializeRecord(row);
}

async function getRecord(id) {
  const row = await prisma.archiveRecord.findUnique({ where: { id } });
  if (!row) throw httpError(404, "Record not found");
  return serializeRecord(row);
}

async function listRecordEvents(id) {
  const exists = await prisma.archiveRecord.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw httpError(404, "Record not found");
  const rows = await prisma.archiveRecordEvent.findMany({ where: { recordId: id }, orderBy: [{ at: "desc" }, { id: "asc" }] });
  return rows.map(serializeEvent);
}

// Server-paginated like every other list: { items, total }. `q` is an internal code (digits) -- the search by field
// text comes with the request screen. Newest first.
async function listRecords(params = {}) {
  const where = {};
  if (params.clientId) where.clientId = String(params.clientId);
  if (params.expedienteId) where.expedienteId = String(params.expedienteId);
  if (params.boxId) where.boxId = String(params.boxId);
  if (params.status) {
    const list = (Array.isArray(params.status) ? params.status : [params.status]).map(String);
    if (list.some((s) => !STATUSES.includes(s))) throw httpError(400, `status must be one of ${STATUSES.join(", ")}`);
    where.status = { in: list };
  }
  const q = String(params.q || "").trim();
  if (q) {
    if (!/^\d{1,9}$/.test(q)) throw httpError(400, "q must be an internal code (digits only)");
    where.internalCode = Number(q);
  }
  // `text`: words found in the record's own field values, its comments or its box number (any case). Narrowed by the
  // other filters first (the request screen always sends the client), and capped, so it stays quick.
  const text = String(params.text || "").trim();
  if (text) {
    if (text.length > 100) throw httpError(400, "text is too long");
    const like = "%" + text.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
    const cid = where.clientId ?? null;
    const hits = await prisma.$queryRaw`SELECT "id" FROM "archive_record" WHERE (comments ILIKE ${like} OR "boxNumber" ILIKE ${like} OR EXISTS (SELECT 1 FROM jsonb_each_text("fields") AS kv WHERE kv.value ILIKE ${like})) AND (${cid}::text IS NULL OR "clientId" = ${cid}) LIMIT 2000`;
    where.id = { in: hits.map((r) => r.id) };
  }
  const { skip, take } = parsePagination(params, 50);
  const [rows, total] = await Promise.all([
    prisma.archiveRecord.findMany({ where, orderBy: [{ internalCode: "desc" }], skip, take }),
    prisma.archiveRecord.count({ where }),
  ]);
  return { items: rows.map(serializeRecord), total };
}

module.exports = {
  RECORD_CODE_BASE,
  STATUSES,
  EVENT_TYPES,
  serializeRecord,
  addEvent,
  createRecordIn,
  createRecord,
  setStatusIn,
  setStatus,
  updateRecord,
  duplicateRecord,
  TRANSITIONS,
  getRecord,
  listRecords,
  listRecordEvents,
};
