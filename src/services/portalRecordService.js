// Client portal: the client's records, and asking for them (Phase 2, stage 11). Everything is scoped by the portal TOKEN
// (ctx.clientId / ctx.email / ctx.isMainContact), never by an id in the request:
//   - records: every record of the company -- except that a contact limited to certain files ("Permisos Web") only sees the
//     records of those files, exactly like the boxes
//   - requests: a contact sees only the requests made for their own email, the main contact sees all of the company's
// A request from the portal starts as "pending" and changes NOTHING physical until staff accept it; a digital request never
// puts a record on loan at all. A record that is already in an open request can't be requested again.
const { randomUUID } = require("crypto");
const prisma = require("../config/prisma");
const httpError = require("../utils/httpError");
const { parsePagination } = require("../utils/pagination");
const { nextSequence } = require("./counterService");
const { notifyStaff } = require("./notificationService");
const { allowedExpedienteIds, assertContactMay } = require("./clientProfileService");
const { visibleToContactWhere } = require("./orderService");
const { summaryOf, addRequestEvent, releaseLocks, isUniqueViolation, ALREADY_OPEN, LOAN_TYPES, KINDS, STATUSES, MAX_RECORDS, MAX_NOTES } = require("./recordRequestService");

const text = (v) => (v == null ? "" : String(v).trim());
const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const RECORD_STATUSES = ["archived", "on_loan", "in_transit", "destroyed"];
const actorOf = (ctx) => ({ id: ctx.email, name: ctx.name || ctx.email, side: "client" });

// The records this contact may see (and therefore ask for).
async function recordScope(ctx) {
  const scope = await allowedExpedienteIds(ctx.clientId, ctx.email);
  return { scope, where: scope ? { clientId: ctx.clientId, expedienteId: { in: scope } } : { clientId: ctx.clientId } };
}

const ownRequests = (ctx) => visibleToContactWhere({ clientId: ctx.clientId, contactEmail: ctx.email, isMainContact: ctx.isMainContact });
const sameContact = (ctx, req) => ctx.isMainContact || (req.contactEmail || "").toLowerCase() === text(ctx.email).toLowerCase();

// --- records -------------------------------------------------------------------------------------------------------------

// `open` = the open request this record is in (if any); it is only named when this contact may see that request.
function portalRecord(r, open, ctx) {
  const out = {
    id: r.id,
    internalCode: r.internalCode,
    boxId: r.boxId,
    boxNumber: r.boxNumber,
    status: r.status,
    expedienteCode: r.expedienteCode,
    fields: r.fields,
    requested: !!open,
  };
  if (open && sameContact(ctx, open)) out.openRequest = { id: open.id, requestNumber: open.requestNumber, kind: open.kind, status: open.status };
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

async function openRequestsFor(ids) {
  if (!ids.length) return new Map();
  const lines = await prisma.recordRequestLine.findMany({ where: { lockKey: { in: ids } }, include: { request: { select: { id: true, requestNumber: true, kind: true, status: true, contactEmail: true } } } });
  return new Map(lines.map((l) => [l.recordId, l.request]));
}

// q: boxId, expedienteId, status (one or several), text (words in the record's own fields or its box number, or an internal
// code), includeDestroyed=true, page, pageSize. Comments are staff notes and are neither shown nor searched.
async function listRecords(ctx, q = {}) {
  const { scope, where: scopeWhere } = await recordScope(ctx);
  const where = { ...scopeWhere };
  if (q.boxId) where.boxId = String(q.boxId);
  if (q.expedienteId) where.expedienteId = scope && !scope.includes(String(q.expedienteId)) ? "__none__" : String(q.expedienteId);
  const statuses = asArray(q.status).map(String).filter((s) => RECORD_STATUSES.includes(s));
  if (statuses.length) where.status = { in: statuses };
  else if (q.includeDestroyed !== "true") where.status = { not: "destroyed" };
  const search = text(q.text);
  if (search) {
    if (search.length > 100) throw httpError(400, "The search is too long");
    const like = "%" + search.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
    const hits = await prisma.$queryRaw`SELECT "id" FROM "archive_record" WHERE "clientId" = ${ctx.clientId} AND ("boxNumber" ILIKE ${like} OR EXISTS (SELECT 1 FROM jsonb_each_text("fields") AS kv WHERE kv.value ILIKE ${like})) LIMIT 2000`;
    const or = [{ id: { in: hits.map((h) => h.id) } }];
    if (/^\d{1,9}$/.test(search)) or.push({ internalCode: Number(search) });
    where.AND = [{ OR: or }];
  }
  const { skip, take } = parsePagination(q, 25);
  const [rows, total] = await Promise.all([
    prisma.archiveRecord.findMany({ where, orderBy: [{ internalCode: "desc" }], skip, take }),
    prisma.archiveRecord.count({ where }),
  ]);
  const open = await openRequestsFor(rows.map((r) => r.id));
  return { items: rows.map((r) => portalRecord(r, open.get(r.id), ctx)), total };
}

async function getRecord(ctx, id) {
  const { where } = await recordScope(ctx);
  const r = await prisma.archiveRecord.findFirst({ where: { ...where, id: text(id) } });
  if (!r) throw httpError(404, "Record not found"); // the same answer for "not yours" and "doesn't exist"
  const open = await openRequestsFor([r.id]);
  return portalRecord(r, open.get(r.id), ctx);
}

// --- requests ------------------------------------------------------------------------------------------------------------

// What the client may know of a request's history: its own actions in full, the warehouse's as "Warehouse" (no staff names,
// and staff notes stay internal).
function portalEvent(e) {
  const client = e.actor && e.actor.side === "client";
  return { id: e.id, type: e.type, at: e.at.toISOString(), by: client ? e.actor.name || "You" : "Warehouse", note: client ? e.note ?? undefined : undefined };
}

function portalRequest(r, ctx, extras = {}) {
  const out = {
    id: r.id,
    requestNumber: r.requestNumber,
    kind: r.kind,
    status: r.status,
    loanType: r.loanType,
    notes: r.notes,
    recordCount: r.recordCount,
    contactName: r.contactName,
    contactEmail: r.contactEmail,
    createdAt: r.createdAt.toISOString(),
    deliveredAt: r.deliveredAt ? r.deliveredAt.toISOString() : null,
    closedAt: r.closedAt ? r.closedAt.toISOString() : null,
    canCancel: r.status === "pending" && sameContact(ctx, r),
  };
  if (extras.lines) {
    out.lines = extras.lines
      .slice()
      .sort((a, b) => a.internalCode - b.internalCode)
      .map((l) => ({ internalCode: l.internalCode, boxNumber: l.boxNumber, fields: extras.fields?.get(l.recordId) ?? undefined, returnedAt: l.returnedAt ? l.returnedAt.toISOString() : undefined }));
  }
  if (extras.events) out.events = extras.events.map(portalEvent);
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

async function listRequests(ctx, q = {}) {
  const where = { ...ownRequests(ctx) };
  const statuses = asArray(q.status).map(String);
  if (statuses.some((s) => !STATUSES.includes(s))) throw httpError(400, `status must be one of ${STATUSES.join(", ")}`);
  if (statuses.length) where.status = { in: statuses };
  if (q.kind) {
    if (!KINDS.includes(String(q.kind))) throw httpError(400, `kind must be one of ${KINDS.join(", ")}`);
    where.kind = String(q.kind);
  }
  const { skip, take } = parsePagination(q, 25);
  const [rows, total] = await Promise.all([
    prisma.recordRequest.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip, take }),
    prisma.recordRequest.count({ where }),
  ]);
  return { items: rows.map((r) => portalRequest(r, ctx)), total };
}

async function findOwnRequest(ctx, id) {
  const r = await prisma.recordRequest.findFirst({ where: { ...ownRequests(ctx), id: text(id) }, include: { lines: true, events: { orderBy: [{ at: "asc" }, { id: "asc" }] } } });
  if (!r) throw httpError(404, "Request not found"); // the same answer for "not yours" and "doesn't exist"
  return r;
}

async function getRequest(ctx, id) {
  const r = await findOwnRequest(ctx, id);
  const recs = await prisma.archiveRecord.findMany({ where: { id: { in: r.lines.map((l) => l.recordId) } }, select: { id: true, fields: true } });
  return portalRequest(r, ctx, { lines: r.lines, fields: new Map(recs.map((x) => [x.id, x.fields])), events: r.events });
}

//   body { recordIds: [..], kind: "original" | "digital", loanType?, notes? }
async function createRequest(ctx, body = {}) {
  const kind = text(body.kind);
  if (!KINDS.includes(kind)) throw httpError(400, `kind must be one of ${KINDS.join(", ")}`);
  // The same switch as for boxes and scans ("canLoan"): a contact the main contact has switched off can't ask for records either.
  await assertContactMay(ctx.clientId, ctx.email, kind === "digital" ? "digitize" : "dispatch", ctx.perms);
  if (!Array.isArray(body.recordIds)) throw httpError(400, "recordIds (non-empty array) is required");
  const ids = [...new Set(body.recordIds.map(text).filter(Boolean))];
  if (ids.length === 0) throw httpError(400, "recordIds (non-empty array) is required");
  if (ids.length > MAX_RECORDS) throw httpError(400, `At most ${MAX_RECORDS} records per request`);
  const loanType = body.loanType ? String(body.loanType) : "normal";
  if (!LOAN_TYPES.includes(loanType)) throw httpError(400, `loanType must be one of ${LOAN_TYPES.join(", ")}`);
  const notes = text(body.notes);
  if (notes.length > MAX_NOTES) throw httpError(400, `Notes are too long (${MAX_NOTES} characters at most)`);

  // Only this contact's own records are found; anything else (another client's, a file the contact may not see, a made-up id)
  // is the same "not found".
  const { where } = await recordScope(ctx);
  const records = await prisma.archiveRecord.findMany({ where: { ...where, id: { in: ids } } });
  if (records.length !== ids.length) throw httpError(404, "One or more records were not found");
  const away = records.filter((r) => r.status !== "archived");
  if (away.length) {
    const list = away.slice(0, 5).map((r) => `${r.internalCode} (${r.status === "on_loan" ? "with you or on loan" : r.status.replace("_", " ")})`).join(", ");
    throw httpError(409, `Not available to request: ${list}${away.length > 5 ? ` and ${away.length - 5} more` : ""} — only records in storage can be requested`);
  }
  const taken = await prisma.recordRequestLine.findMany({ where: { lockKey: { in: ids } }, select: { internalCode: true } });
  if (taken.length) throw httpError(409, `${ALREADY_OPEN}: ${taken.slice(0, 5).map((t) => t.internalCode).join(", ")}`);

  const actor = actorOf(ctx);
  const sorted = records.slice().sort((a, b) => a.internalCode - b.internalCode);
  const requestNumber = `REQ-${String(await nextSequence("recordRequestSeq")).padStart(6, "0")}`;
  const clientName = sorted[0].clientName;
  let created;
  try {
    created = await prisma.$transaction(
      async (tx) => {
        const req = await tx.recordRequest.create({
          data: {
            id: randomUUID(),
            requestNumber,
            clientId: ctx.clientId,
            clientName,
            status: "pending", // nothing physical happens until staff accept it
            kind,
            source: "portal",
            loanType,
            contactName: ctx.name || null,
            contactEmail: text(ctx.email).toLowerCase() || null,
            notes: notes || null,
            recordCount: sorted.length,
            requestedBy: actor,
            // the unique lockKey is the real guard: if another request got one of these records a moment ago, this whole insert fails
            lines: { create: sorted.map((r) => ({ recordId: r.id, internalCode: r.internalCode, boxNumber: r.boxNumber, summary: summaryOf(r), lockKey: r.id })) },
          },
          include: { lines: true },
        });
        await addRequestEvent(tx, req.id, "created", actor, `${kind === "digital" ? "Digital copy" : "Original"} requested in the portal${notes ? `: ${notes}` : ""}`);
        await tx.archiveRecordEvent.createMany({
          data: sorted.map((r) => ({ recordId: r.id, type: "requested", note: `${requestNumber}: ${kind === "digital" ? "digital copy" : "original"} requested in the portal by ${actor.name} (waiting for staff)`.slice(0, 500), actor })),
        });
        await notifyStaff({ kind: "record_request_new", title: `${clientName}: new ${kind === "digital" ? "digital" : "original"} record request ${requestNumber} (${sorted.length} record${sorted.length === 1 ? "" : "s"})`, clientId: ctx.clientId }, tx);
        return req;
      },
      { maxWait: 10_000, timeout: 60_000 },
    );
  } catch (e) {
    if (isUniqueViolation(e)) throw httpError(409, ALREADY_OPEN);
    throw e;
  }
  return portalRequest(created, ctx, { lines: created.lines, fields: new Map(sorted.map((r) => [r.id, r.fields])) });
}

// The client withdraws a request staff haven't accepted yet. The records are never touched (they were never lent).
async function cancelRequest(ctx, id, reason) {
  const r = await findOwnRequest(ctx, id);
  if (r.status !== "pending") throw httpError(409, `${r.requestNumber} was already ${r.status === "requested" ? "accepted" : r.status} — contact the warehouse to change it`);
  const why = text(reason).slice(0, 300);
  const actor = actorOf(ctx);
  await prisma.$transaction(
    async (tx) => {
      // Only succeeds if staff haven't accepted it in the meantime (accept and cancel can't both win).
      const done = await tx.recordRequest.updateMany({ where: { id: r.id, status: "pending" }, data: { status: "cancelled", closedAt: new Date(), closedBy: actor } });
      if (done.count !== 1) throw httpError(409, `${r.requestNumber} was just accepted by the warehouse — contact them to change it`);
      await releaseLocks(tx, r.id);
      await addRequestEvent(tx, r.id, "cancelled", actor, why ? `Cancelled by the client: ${why}` : "Cancelled by the client");
      await tx.archiveRecordEvent.createMany({ data: r.lines.map((l) => ({ recordId: l.recordId, type: "requested", note: `${r.requestNumber} cancelled by the client before it was accepted`, actor })) });
      await notifyStaff({ kind: "record_request_cancelled", title: `${r.clientName}: record request ${r.requestNumber} was cancelled by the client`, clientId: r.clientId }, tx);
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
  return getRequest(ctx, id);
}

module.exports = { listRecords, getRecord, listRequests, getRequest, createRequest, cancelRequest };
