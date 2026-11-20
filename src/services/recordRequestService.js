// Docbox "Peticiones" (Phase 2, stage 5): a client asks for several records at once. One request = one client, many
// records. Creating it puts every record on_loan (with a history row each) in the same transaction -- all or nothing.
// Orders (whole boxes) are not touched. Stage 6 adds the status changes and the printouts.
const { randomUUID } = require("crypto");
const prisma = require("../config/prisma");
const httpError = require("../utils/httpError");
const { parsePagination } = require("../utils/pagination");
const { nextSequence } = require("./counterService");

const LOAN_TYPES = ["normal", "urgent", "superior", "fax"];
const CHANNELS = ["email", "phone", "in_person", "post", "fax"];
const STATUSES = ["requested", "delivered", "returned", "cancelled"];
const MAX_RECORDS = 100;
const MAX_NOTES = 500;
const text = (v) => (v == null ? "" : String(v).trim());

// `extra` = what comes from the record itself (its own field values and the box's location now), for the printouts.
function serializeLine(l, extra = {}) {
  const out = {
    id: l.id,
    recordId: l.recordId,
    internalCode: l.internalCode,
    boxNumber: l.boxNumber,
    summary: l.summary,
    returnedAt: l.returnedAt ? l.returnedAt.toISOString() : null,
    fields: extra.fields ?? null,
    location: extra.location ?? null,
  };
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

function serializeRequest(r, withLines, extras = new Map()) {
  const out = {
    deliveredAt: r.deliveredAt ? r.deliveredAt.toISOString() : null,
    deliveredBy: r.deliveredBy,
    closedAt: r.closedAt ? r.closedAt.toISOString() : null,
    closedBy: r.closedBy,
    id: r.id,
    requestNumber: r.requestNumber,
    clientId: r.clientId,
    clientName: r.clientName,
    status: r.status,
    loanType: r.loanType,
    requestChannel: r.requestChannel,
    contactName: r.contactName,
    contactEmail: r.contactEmail,
    notes: r.notes,
    recordCount: r.recordCount,
    requestedBy: r.requestedBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
  if (withLines) out.lines = (r.lines || []).slice().sort((a, b) => a.internalCode - b.internalCode).map((l) => serializeLine(l, extras.get(l.recordId)));
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k]; // the frontend schemas use .optional(), not .nullable()
  return out;
}

// A short line for printing: the record's own field values.
function summaryOf(record) {
  const v = record.fields && typeof record.fields === "object" ? Object.values(record.fields) : [];
  const s = v.map((x) => String(x)).filter(Boolean).join(" / ");
  return s ? s.slice(0, 300) : null;
}

//   input { clientId, recordIds: [..], loanType?, requestChannel?, contactName?, contactEmail?, notes? }
// `outerTx`: run inside the caller's transaction (the purge file lends some records and destroys others in one go).
async function createRequest(input, actor, outerTx) {
  const db = outerTx || prisma;
  const clientId = input.clientId == null ? "" : String(input.clientId); // exact: a stored id can have spaces
  if (!clientId.trim()) throw httpError(400, "clientId is required");
  if (!Array.isArray(input.recordIds)) throw httpError(400, "recordIds (non-empty array) is required");
  const ids = [...new Set(input.recordIds.map((x) => text(x)).filter(Boolean))];
  if (ids.length === 0) throw httpError(400, "recordIds (non-empty array) is required");
  if (ids.length > MAX_RECORDS) throw httpError(400, `At most ${MAX_RECORDS} records per request`);

  const loanType = input.loanType ? String(input.loanType) : "normal";
  if (!LOAN_TYPES.includes(loanType)) throw httpError(400, `loanType must be one of ${LOAN_TYPES.join(", ")}`);
  const requestChannel = input.requestChannel ? String(input.requestChannel) : null;
  if (requestChannel && !CHANNELS.includes(requestChannel)) throw httpError(400, `requestChannel must be one of ${CHANNELS.join(", ")}`);
  const notes = text(input.notes);
  if (notes.length > MAX_NOTES) throw httpError(400, `Notes are too long (${MAX_NOTES} characters at most)`);
  const contactEmail = text(input.contactEmail).toLowerCase();
  if (contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) throw httpError(400, "contactEmail is not a valid email");

  const records = await db.archiveRecord.findMany({ where: { id: { in: ids } } });
  if (records.length !== ids.length) throw httpError(404, "One or more records were not found");
  const other = records.find((r) => r.clientId !== clientId);
  if (other) throw httpError(400, `Record ${other.internalCode} belongs to another client — one request is for one client`);
  const notAvailable = records.filter((r) => r.status !== "archived");
  if (notAvailable.length) {
    const list = notAvailable.slice(0, 5).map((r) => `${r.internalCode} (${r.status})`).join(", ");
    throw httpError(409, `Not available to request: ${list}${notAvailable.length > 5 ? ` and ${notAvailable.length - 5} more` : ""} — only archived records can be requested`);
  }

  const requestNumber = `REQ-${String(await nextSequence("recordRequestSeq", db)).padStart(6, "0")}`;
  const sorted = records.slice().sort((a, b) => a.internalCode - b.internalCode);
  const work = async (tx) => {
      // The status filter is the real guard: if anyone lent one of these records since we read it, the count is short -> nothing is saved.
      const changed = await tx.archiveRecord.updateMany({ where: { id: { in: ids }, status: "archived" }, data: { status: "on_loan" } });
      if (changed.count !== ids.length) throw httpError(409, "Some records were requested by someone else just now — search again");
      await tx.archiveRecordEvent.createMany({
        data: sorted.map((r) => ({ recordId: r.id, type: "status_changed", note: `archived → on_loan: requested in ${requestNumber}`, actor })),
      });
      return tx.recordRequest.create({
        data: {
          id: randomUUID(),
          requestNumber,
          clientId,
          clientName: sorted[0].clientName,
          loanType,
          requestChannel,
          contactName: text(input.contactName) || null,
          contactEmail: contactEmail || null,
          notes: notes || null,
          recordCount: sorted.length,
          requestedBy: actor,
          lines: { create: sorted.map((r) => ({ recordId: r.id, internalCode: r.internalCode, boxNumber: r.boxNumber, summary: summaryOf(r) })) },
        },
        include: { lines: true },
      });
  };
  const created = outerTx ? await work(outerTx) : await prisma.$transaction(work, { maxWait: 10_000, timeout: 60_000 });
  return serializeRequest(created, true);
}

async function getRequest(id) {
  const r = await prisma.recordRequest.findUnique({ where: { id }, include: { lines: true } });
  if (!r) throw httpError(404, "Request not found");
  // The records' own values and the box's current place, for the delivery note and the witness slips.
  const recs = await prisma.archiveRecord.findMany({ where: { id: { in: r.lines.map((l) => l.recordId) } }, select: { id: true, fields: true, box: { select: { locationPath: true } } } });
  const extras = new Map(recs.map((x) => [x.id, { fields: x.fields, location: x.box?.locationPath }]));
  return serializeRequest(r, true, extras);
}

// requested -> delivered (the records stay on loan) | cancelled (the records go back to archived)
// delivered -> returned (all records not yet back return to archived). Returning single records is stage 7.
const TRANSITIONS = { requested: ["delivered", "cancelled"], delivered: ["returned"], returned: [], cancelled: [] };

//   input { to, note? }
async function changeStatus(id, input, actor) {
  const to = text(input.to);
  if (!STATUSES.includes(to)) throw httpError(400, `status must be one of ${STATUSES.join(", ")}`);
  const note = text(input.note);
  if (note.length > MAX_NOTES) throw httpError(400, `The note is too long (${MAX_NOTES} characters at most)`);
  const req = await prisma.recordRequest.findUnique({ where: { id }, include: { lines: true } });
  if (!req) throw httpError(404, "Request not found");
  if (req.status === to) throw httpError(409, `${req.requestNumber} is already ${to}`);
  if (!TRANSITIONS[req.status].includes(to)) throw httpError(409, `${req.requestNumber} is ${req.status} and can't become ${to}`);

  const now = new Date();
  const tail = note ? `: ${note}` : "";
  await prisma.$transaction(
    async (tx) => {
      const data = { status: to };
      if (to === "delivered") Object.assign(data, { deliveredAt: now, deliveredBy: actor });
      else Object.assign(data, { closedAt: now, closedBy: actor });
      // Only succeeds if the request is still in the status we read.
      const moved = await tx.recordRequest.updateMany({ where: { id, status: req.status }, data });
      if (moved.count !== 1) throw httpError(409, `${req.requestNumber} was changed by someone else — reload`);

      const open = req.lines.filter((l) => !l.returnedAt);
      if (to === "delivered") {
        await tx.archiveRecordEvent.createMany({ data: open.map((l) => ({ recordId: l.recordId, type: "status_changed", note: `${req.requestNumber} delivered to the client${tail}`, actor })) });
        return;
      }
      // cancelled / returned: the records still out come back to the archive
      const back = await tx.archiveRecord.updateMany({ where: { id: { in: open.map((l) => l.recordId) }, status: "on_loan" }, data: { status: "archived" } });
      if (back.count !== open.length) throw httpError(409, `Some records of ${req.requestNumber} are no longer on loan — check them before closing the request`);
      await tx.archiveRecordEvent.createMany({
        data: open.map((l) => ({ recordId: l.recordId, type: "status_changed", note: `on_loan → archived: ${req.requestNumber} ${to}${tail}`, actor })),
      });
      if (to === "returned") await tx.recordRequestLine.updateMany({ where: { id: { in: open.map((l) => l.id) } }, data: { returnedAt: now } });
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
  return getRequest(id);
}

// { items, total }, newest first. Filters: clientId, status (one or several), q (request number, client name, or an internal code on it).
async function listRequests(params = {}) {
  const where = {};
  if (params.clientId) where.clientId = String(params.clientId);
  if (params.status) {
    const list = (Array.isArray(params.status) ? params.status : [params.status]).map(String);
    if (list.some((s) => !STATUSES.includes(s))) throw httpError(400, `status must be one of ${STATUSES.join(", ")}`);
    where.status = { in: list };
  }
  const q = text(params.q);
  if (q) {
    const or = [{ requestNumber: { contains: q, mode: "insensitive" } }, { clientName: { contains: q, mode: "insensitive" } }];
    if (/^\d{1,9}$/.test(q)) or.push({ lines: { some: { internalCode: Number(q) } } });
    where.OR = or;
  }
  const { skip, take } = parsePagination(params, 25);
  const [rows, total] = await Promise.all([
    prisma.recordRequest.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip, take }),
    prisma.recordRequest.count({ where }),
  ]);
  return { items: rows.map((r) => serializeRequest(r, false)), total };
}

module.exports = { createRequest, getRequest, listRequests, changeStatus, LOAN_TYPES, CHANNELS, STATUSES, MAX_RECORDS };
