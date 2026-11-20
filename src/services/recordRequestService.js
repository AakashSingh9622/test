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

function serializeLine(l) {
  const out = { id: l.id, recordId: l.recordId, internalCode: l.internalCode, boxNumber: l.boxNumber, summary: l.summary };
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

function serializeRequest(r, withLines) {
  const out = {
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
  if (withLines) out.lines = (r.lines || []).slice().sort((a, b) => a.internalCode - b.internalCode).map(serializeLine);
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
async function createRequest(input, actor) {
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

  const records = await prisma.archiveRecord.findMany({ where: { id: { in: ids } } });
  if (records.length !== ids.length) throw httpError(404, "One or more records were not found");
  const other = records.find((r) => r.clientId !== clientId);
  if (other) throw httpError(400, `Record ${other.internalCode} belongs to another client — one request is for one client`);
  const notAvailable = records.filter((r) => r.status !== "archived");
  if (notAvailable.length) {
    const list = notAvailable.slice(0, 5).map((r) => `${r.internalCode} (${r.status})`).join(", ");
    throw httpError(409, `Not available to request: ${list}${notAvailable.length > 5 ? ` and ${notAvailable.length - 5} more` : ""} — only archived records can be requested`);
  }

  const requestNumber = `REQ-${String(await nextSequence("recordRequestSeq")).padStart(6, "0")}`;
  const sorted = records.slice().sort((a, b) => a.internalCode - b.internalCode);
  const created = await prisma.$transaction(
    async (tx) => {
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
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
  return serializeRequest(created, true);
}

async function getRequest(id) {
  const r = await prisma.recordRequest.findUnique({ where: { id }, include: { lines: true } });
  if (!r) throw httpError(404, "Request not found");
  return serializeRequest(r, true);
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

module.exports = { createRequest, getRequest, listRequests, LOAN_TYPES, CHANNELS, STATUSES, MAX_RECORDS };
