// Docbox "records" (Phase 2, stage 1): one folder / subfolder / contents row inside a box, with its own internal code
// (Docbox COD_INTERNO). Boxes, BoxContent and orders are not touched -- a client that doesn't use records has none.
// A record keeps its home box while it is lent out; `status` says where it is.
const prisma = require("../config/prisma");
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
  const boxId = String(input.boxId || "").trim();
  if (!boxId) throw httpError(400, "boxId is required");
  const box = await tx.box.findUnique({ where: { id: boxId } });
  if (!box) throw httpError(404, "Box not found");
  if (box.status === "destroyed" || box.status === "permanently_withdrawn") {
    throw httpError(400, `${box.boxNumber} is ${box.status === "destroyed" ? "destroyed" : "permanently withdrawn"}`);
  }
  const fields = await cleanValuesOrThrow(box.clientId, input.fields, { expedienteId: box.expedienteId });
  const comments = cleanComments(input.comments);
  const internalCode = RECORD_CODE_BASE + (await nextSequence("recordSeq", tx));
  const row = await tx.archiveRecord.create({
    data: {
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
    },
  });
  await addEvent(tx, row.id, "created", actor, `Created in ${box.boxNumber}`);
  return row;
}

async function createRecord(input, actor) {
  const row = await prisma.$transaction((tx) => createRecordIn(tx, input, actor));
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
  getRecord,
  listRecords,
  listRecordEvents,
};
