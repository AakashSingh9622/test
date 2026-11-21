// Docbox "Peticiones" (Phase 2, stages 5, 6 and 11): a client asks for several records at once. One request = one client, many
// records. Orders (whole boxes) are not touched.
//   kind   original  the paper goes to the client: the records are put on_loan when the request is accepted
//          digital   a scan: the paper NEVER leaves the box, so no record is ever put on loan
//   source staff     made by staff: starts as "requested" and (original) puts the records on loan at once, all or nothing
//          portal    asked by the client: starts as "pending" and changes nothing physical until staff accept it
// A record is in at most ONE open request (record_request_line.lockKey is unique while the request is open), so two
// people -- or a client and staff -- can't request the same record at the same time.
const { randomUUID } = require("crypto");
const prisma = require("../config/prisma");
const httpError = require("../utils/httpError");
const { parsePagination } = require("../utils/pagination");
const { nextSequence } = require("./counterService");
const { notify } = require("./notificationService");

const LOAN_TYPES = ["normal", "urgent", "superior", "fax"];
const CHANNELS = ["email", "phone", "in_person", "post", "fax"];
const STATUSES = ["pending", "requested", "delivered", "returned", "cancelled"];
const KINDS = ["original", "digital"];
const MAX_RECORDS = 100;
const MAX_NOTES = 500;
const text = (v) => (v == null ? "" : String(v).trim());

const ALREADY_OPEN = "One or more of these records are already in another open request — only one request at a time per record";
const isUniqueViolation = (e) => e && e.code === "P2002";

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
    kind: r.kind,
    source: r.source,
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

// --- the request's own history, the lock, and the client's notifications (always inside the caller's transaction) ---------

function addRequestEvent(db, requestId, type, actor, note) {
  return db.recordRequestEvent.create({ data: { requestId, type, note: note ? String(note).slice(0, 500) : null, actor } });
}

// The request is closed: its records may be requested again.
function releaseLocks(db, requestId) {
  return db.recordRequestLine.updateMany({ where: { requestId, lockKey: { not: null } }, data: { lockKey: null } });
}

const KIND_WORD = { original: "records", digital: "digital copies" };
const CLIENT_TEXT = {
  accepted: (r) => `Your record request ${r.requestNumber} was accepted — we are preparing your ${KIND_WORD[r.kind]}`,
  delivered: (r) => `${r.requestNumber}: your ${KIND_WORD[r.kind]} ${r.kind === "digital" ? "are ready" : "were delivered"}`,
  cancelled: (r) => `Your record request ${r.requestNumber} was cancelled`,
};
// Tells the contact who asked (a main contact sees it too). Only requests with a contact are announced.
async function notifyClient(db, req, what) {
  if (!req.contactEmail || !CLIENT_TEXT[what]) return;
  await notify({ audience: "client", clientId: req.clientId, contactEmail: req.contactEmail, kind: `record_request_${what}`, title: CLIENT_TEXT[what](req) }, db);
}

//   input { clientId, recordIds: [..], loanType?, requestChannel?, contactName?, contactEmail?, notes?, kind?, notifyContact?, via? }
//   kind  original (default): the records go on loan now.  digital: a scan -- the paper never leaves its box, so no record is put on loan.
//   notifyContact: tell the contact (portal Updates) that the warehouse made this request for them;  via: where it came from (history note).
// A staff request: `outerTx`: run inside the caller's transaction (the purge
// file lends some records and destroys others in one go).
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
  const kind = input.kind ? String(input.kind) : "original";
  if (!KINDS.includes(kind)) throw httpError(400, `kind must be one of ${KINDS.join(", ")}`);
  const digital = kind === "digital";
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
  const taken = await db.recordRequestLine.findMany({ where: { lockKey: { in: ids } }, select: { internalCode: true } });
  if (taken.length) throw httpError(409, `${ALREADY_OPEN}: ${taken.slice(0, 5).map((t) => t.internalCode).join(", ")}`);

  const requestNumber = `REQ-${String(await nextSequence("recordRequestSeq", db)).padStart(6, "0")}`;
  const sorted = records.slice().sort((a, b) => a.internalCode - b.internalCode);
  const work = async (tx) => {
    if (digital) {
      // a digital copy never moves the paper: the physical status is NOT touched, the record is only locked in this request
      await tx.archiveRecordEvent.createMany({
        data: sorted.map((r) => ({ recordId: r.id, type: "requested", note: `${requestNumber}: digital copy requested by staff (the paper stays in the box)`, actor })),
      });
    } else {
      // The status filter is the real guard: if anyone lent one of these records since we read it, the count is short -> nothing is saved.
      const changed = await tx.archiveRecord.updateMany({ where: { id: { in: ids }, status: "archived" }, data: { status: "on_loan" } });
      if (changed.count !== ids.length) throw httpError(409, "Some records were requested by someone else just now — search again");
      await tx.archiveRecordEvent.createMany({
        data: sorted.map((r) => ({ recordId: r.id, type: "status_changed", note: `archived → on_loan: requested in ${requestNumber}`, actor })),
      });
    }
    const created = await tx.recordRequest.create({
      data: {
        id: randomUUID(),
        requestNumber,
        clientId,
        clientName: sorted[0].clientName,
        kind,
        loanType,
        requestChannel,
        contactName: text(input.contactName) || null,
        contactEmail: contactEmail || null,
        notes: notes || null,
        recordCount: sorted.length,
        requestedBy: actor,
        lines: { create: sorted.map((r) => ({ recordId: r.id, internalCode: r.internalCode, boxNumber: r.boxNumber, summary: summaryOf(r), lockKey: r.id })) },
      },
      include: { lines: true },
    });
    const via = text(input.via) ? ` (${text(input.via)})` : "";
    await addRequestEvent(tx, created.id, "created", actor, digital ? `Created by staff${via} — digital copy, nothing is lent` : `Created by staff${via} — the records are on loan`);
    if (input.notifyContact && created.contactEmail) {
      await notify({ audience: "client", clientId, contactEmail: created.contactEmail, kind: "record_request_created", title: `The warehouse created record request ${requestNumber} for you — ${sorted.length} record${sorted.length === 1 ? "" : "s"}, ${digital ? "digital copy" : "original"}` }, tx);
    }
    return created;
  };
  let created;
  try {
    created = outerTx ? await work(outerTx) : await prisma.$transaction(work, { maxWait: 10_000, timeout: 60_000 });
  } catch (e) {
    if (isUniqueViolation(e)) throw httpError(409, ALREADY_OPEN);
    throw e;
  }
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

// The request's whole history, oldest first (staff see who did what).
async function listRequestEvents(id) {
  const exists = await prisma.recordRequest.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw httpError(404, "Request not found");
  const rows = await prisma.recordRequestEvent.findMany({ where: { requestId: id }, orderBy: [{ at: "asc" }, { id: "asc" }] });
  return rows.map((e) => ({ id: e.id, type: e.type, note: e.note ?? undefined, actor: e.actor, at: e.at.toISOString() }));
}

// pending   -> requested (ACCEPT: an original's records go on loan; a digital request changes nothing physical) | cancelled
// requested -> delivered (an original stays on loan; a digital request is finished) | cancelled (an original's records go back)
// delivered -> returned (originals only: the records not yet back return to archived)
const TRANSITIONS = { pending: ["requested", "cancelled"], requested: ["delivered", "cancelled"], delivered: ["returned"], returned: [], cancelled: [] };
const EVENT_OF = { requested: "accepted", delivered: "delivered", returned: "returned", cancelled: "cancelled" };

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
  const physical = req.kind === "original"; // a digital request never moves a record
  if (!physical && to === "returned") throw httpError(409, `${req.requestNumber} is a digital request — there is nothing to return`);

  const now = new Date();
  const tail = note ? `: ${note}` : "";
  await prisma.$transaction(
    async (tx) => {
      const data = { status: to };
      if (to === "delivered") Object.assign(data, { deliveredAt: now, deliveredBy: actor });
      else if (to !== "requested") Object.assign(data, { closedAt: now, closedBy: actor });
      // Only succeeds if the request is still in the status we read (a client cancelling and staff accepting can't both win).
      const moved = await tx.recordRequest.updateMany({ where: { id, status: req.status }, data });
      if (moved.count !== 1) throw httpError(409, `${req.requestNumber} was changed by someone else — reload`);

      const open = req.lines.filter((l) => !l.returnedAt);
      const recordEvents = (type, noteOf) => tx.archiveRecordEvent.createMany({ data: open.map((l) => ({ recordId: l.recordId, type, note: noteOf, actor })) });

      if (to === "requested") {
        // ACCEPT
        if (physical) {
          const changed = await tx.archiveRecord.updateMany({ where: { id: { in: open.map((l) => l.recordId) }, status: "archived" }, data: { status: "on_loan" } });
          if (changed.count !== open.length) throw httpError(409, `Some records of ${req.requestNumber} are no longer available (not archived any more) — cancel this request`);
          await recordEvents("status_changed", `archived → on_loan: ${req.requestNumber} accepted${tail}`);
        } else {
          await recordEvents("requested", `${req.requestNumber} accepted — digital copy to be made (the paper stays in the box)${tail}`);
        }
      } else if (to === "delivered") {
        await recordEvents(physical ? "status_changed" : "requested", physical ? `${req.requestNumber} delivered to the client${tail}` : `${req.requestNumber}: digital copy delivered${tail}`);
        if (!physical) await releaseLocks(tx, id); // nothing to give back: the request is finished
      } else {
        // cancelled | returned
        if (req.status === "pending" || !physical) {
          // never on loan: the record's physical status is NOT touched
          await recordEvents("requested", `${req.requestNumber} cancelled${req.status === "pending" ? " before it was accepted" : ""}${tail}`);
        } else {
          const back = await tx.archiveRecord.updateMany({ where: { id: { in: open.map((l) => l.recordId) }, status: "on_loan" }, data: { status: "archived" } });
          if (back.count !== open.length) throw httpError(409, `Some records of ${req.requestNumber} are no longer on loan — check them before closing the request`);
          await recordEvents("status_changed", `on_loan → archived: ${req.requestNumber} ${to}${tail}`);
        }
        if (to === "returned") await tx.recordRequestLine.updateMany({ where: { id: { in: open.map((l) => l.id) } }, data: { returnedAt: now } });
        await releaseLocks(tx, id);
      }
      await addRequestEvent(tx, id, EVENT_OF[to], actor, note);
      await notifyClient(tx, req, EVENT_OF[to]);
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
  return getRequest(id);
}

// --- editing an OPEN request (pending | requested) ------------------------------------------------------------------
// input { contactName?, contactEmail?, loanType?, requestChannel?, notes?, addRecordIds?, removeRecordIds?, note? (the reason), clientId?/kind? (only if equal) }
// ALL OR NOTHING in one transaction. The client and the kind never change. A PORTAL request keeps its contact (the client sees it through it).
// Records: a requested ORIGINAL request holds its records on loan, so an added one goes on loan and a removed one goes back; a pending
// or digital request only locks / unlocks them (their status is untouched) -- the same rules as create / cancel.
// The client is told ONCE per edit, and only about what concerns them: contact, loan type, records added/removed (not notes / channel).
const EDIT_STATUSES = ["pending", "requested"];
const codeList = (rs) => {
  const c = rs.map((r) => r.internalCode).sort((a, b) => a - b);
  return c.length > 15 ? `${c.slice(0, 15).join(", ")} and ${c.length - 15} more` : c.join(", ");
};
const show = (v) => (v == null || v === "" ? "(none)" : String(v));

async function editRequest(id, input, actor) {
  const req = await prisma.recordRequest.findUnique({ where: { id }, include: { lines: true } });
  if (!req) throw httpError(404, "Request not found");
  if (!EDIT_STATUSES.includes(req.status)) throw httpError(409, `${req.requestNumber} is ${req.status} — only a pending or requested request can be edited`);
  if (input.clientId != null && String(input.clientId) !== req.clientId) throw httpError(400, "The client of a request can't be changed");
  if (input.kind != null && String(input.kind) !== req.kind) throw httpError(400, "The kind (original / digital) of a request can't be changed");
  const reason = text(input.note);
  if (reason.length > MAX_NOTES) throw httpError(400, `The note is too long (${MAX_NOTES} characters at most)`);

  // ---- the header ----
  const changes = [];
  const data = {};
  const setField = (key, label, value) => {
    if ((req[key] ?? null) === (value ?? null)) return;
    data[key] = value;
    changes.push({ key, label, from: req[key], to: value });
  };
  if (input.loanType !== undefined) {
    const loanType = String(input.loanType);
    if (!LOAN_TYPES.includes(loanType)) throw httpError(400, `loanType must be one of ${LOAN_TYPES.join(", ")}`);
    setField("loanType", "loan type", loanType);
  }
  if (input.requestChannel !== undefined) {
    const ch = input.requestChannel ? String(input.requestChannel) : null;
    if (ch && !CHANNELS.includes(ch)) throw httpError(400, `requestChannel must be one of ${CHANNELS.join(", ")}`);
    setField("requestChannel", "request channel", ch);
  }
  if (input.notes !== undefined) {
    const notes = text(input.notes);
    if (notes.length > MAX_NOTES) throw httpError(400, `Notes are too long (${MAX_NOTES} characters at most)`);
    setField("notes", "notes", notes || null);
  }
  const portalLocked = "The contact of a request made in the portal can't be changed";
  if (input.contactName !== undefined) {
    const name = text(input.contactName) || null;
    if (req.source === "portal" && name !== (req.contactName ?? null)) throw httpError(409, portalLocked);
    setField("contactName", "contact name", name);
  }
  if (input.contactEmail !== undefined) {
    const email = text(input.contactEmail).toLowerCase();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, "contactEmail is not a valid email");
    if (req.source === "portal" && (email || null) !== (req.contactEmail ?? null)) throw httpError(409, portalLocked);
    setField("contactEmail", "contact email", email || null);
  }

  // ---- the records ----
  const idList = (v, label) => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw httpError(400, `${label} must be an array`);
    return [...new Set(v.map((x) => text(x)).filter(Boolean))];
  };
  const addIds = idList(input.addRecordIds, "addRecordIds");
  const removeIds = idList(input.removeRecordIds, "removeRecordIds");
  if (addIds.length > MAX_RECORDS) throw httpError(400, `At most ${MAX_RECORDS} records per request`);
  if (addIds.some((x) => removeIds.includes(x))) throw httpError(400, "A record can't be added and removed in the same edit");
  if (!changes.length && !addIds.length && !removeIds.length) throw httpError(400, "Nothing to change");

  const onRequest = new Map(req.lines.map((l) => [l.recordId, l]));
  if (addIds.some((x) => onRequest.has(x))) throw httpError(400, "One or more records are already on this request");
  if (removeIds.some((x) => !onRequest.has(x))) throw httpError(400, "One or more records to remove are not on this request");
  const total = req.lines.length + addIds.length - removeIds.length;
  if (total < 1) throw httpError(400, "A request needs at least one record — cancel the request instead");
  if (total > MAX_RECORDS) throw httpError(400, `At most ${MAX_RECORDS} records per request`);

  const holdsLoan = req.kind === "original" && req.status === "requested"; // this request's records are on loan right now
  let toAdd = [];
  if (addIds.length) {
    toAdd = await prisma.archiveRecord.findMany({ where: { id: { in: addIds } } });
    if (toAdd.length !== addIds.length) throw httpError(404, "One or more records were not found");
    const other = toAdd.find((r) => r.clientId !== req.clientId);
    if (other) throw httpError(400, `Record ${other.internalCode} belongs to another client — one request is for one client`);
    const notAvailable = toAdd.filter((r) => r.status !== "archived");
    if (notAvailable.length) throw httpError(409, `Not available to add: ${notAvailable.slice(0, 5).map((r) => `${r.internalCode} (${r.status})`).join(", ")} — only archived records can be requested`);
    const taken = await prisma.recordRequestLine.findMany({ where: { lockKey: { in: addIds } }, select: { internalCode: true } });
    if (taken.length) throw httpError(409, `${ALREADY_OPEN}: ${taken.slice(0, 5).map((t) => t.internalCode).join(", ")}`);
  }
  const toRemove = removeIds.map((x) => onRequest.get(x));
  if (toRemove.some((l) => l.returnedAt)) throw httpError(409, "A record that already came back can't be removed");

  const tail = reason ? `: ${reason}` : "";
  const num = req.requestNumber;
  const work = async (tx) => {
    // Only succeeds if the request is still open and as we read it (a cancel / accept / another edit racing us loses or wins cleanly).
    const stamp = await tx.recordRequest.updateMany({ where: { id, status: req.status, recordCount: req.recordCount }, data: { ...data, recordCount: total } });
    if (stamp.count !== 1) throw httpError(409, `${num} was changed by someone else — reload`);

    if (toRemove.length) {
      if (holdsLoan) {
        const back = await tx.archiveRecord.updateMany({ where: { id: { in: removeIds }, status: "on_loan" }, data: { status: "archived" } });
        if (back.count !== removeIds.length) throw httpError(409, "Some records to remove are no longer on loan — check them first");
        await tx.archiveRecordEvent.createMany({ data: toRemove.map((l) => ({ recordId: l.recordId, type: "status_changed", note: `on_loan → archived: removed from ${num}${tail}`, actor })) });
      } else {
        await tx.archiveRecordEvent.createMany({ data: toRemove.map((l) => ({ recordId: l.recordId, type: "requested", note: `removed from ${num}${tail}`, actor })) });
      }
      await tx.recordRequestLine.deleteMany({ where: { id: { in: toRemove.map((l) => l.id) }, requestId: id } }); // frees the lock: the record may be requested again
      await addRequestEvent(tx, id, "records_removed", actor, `Removed ${toRemove.length}: ${codeList(toRemove)}${tail}`);
    }
    if (toAdd.length) {
      const sorted = toAdd.slice().sort((a, b) => a.internalCode - b.internalCode);
      if (holdsLoan) {
        const changed = await tx.archiveRecord.updateMany({ where: { id: { in: addIds }, status: "archived" }, data: { status: "on_loan" } });
        if (changed.count !== addIds.length) throw httpError(409, "Some records were requested by someone else just now — search again");
        await tx.archiveRecordEvent.createMany({ data: sorted.map((r) => ({ recordId: r.id, type: "status_changed", note: `archived → on_loan: added to ${num}${tail}`, actor })) });
      } else {
        const how = req.kind === "digital" ? " (digital copy — the paper stays in the box)" : " (not on loan until the request is accepted)";
        await tx.archiveRecordEvent.createMany({ data: sorted.map((r) => ({ recordId: r.id, type: "requested", note: `added to ${num}${how}${tail}`, actor })) });
      }
      await tx.recordRequestLine.createMany({ data: sorted.map((r) => ({ requestId: id, recordId: r.id, internalCode: r.internalCode, boxNumber: r.boxNumber, summary: summaryOf(r), lockKey: r.id })) });
      await addRequestEvent(tx, id, "records_added", actor, `Added ${sorted.length}: ${codeList(sorted)}${tail}`);
    }
    if (changes.length) {
      await addRequestEvent(tx, id, "edited", actor, changes.map((c) => `${c.label}: ${show(c.from)} → ${show(c.to)}`).join("; ") + tail);
    }

    // ONE notification per edit, only for what the client cares about (not notes / channel).
    const meaningful = changes.some((c) => ["contactName", "contactEmail", "loanType"].includes(c.key)) || toAdd.length > 0 || toRemove.length > 0;
    if (meaningful) {
      const parts = [];
      if ("loanType" in data) parts.push(`urgency is now ${data.loanType}`);
      if ("contactName" in data || "contactEmail" in data) parts.push("contact details changed");
      if (toAdd.length) parts.push(`${toAdd.length} record${toAdd.length === 1 ? "" : "s"} added`);
      if (toRemove.length) parts.push(`${toRemove.length} record${toRemove.length === 1 ? "" : "s"} removed`);
      const newEmail = "contactEmail" in data ? data.contactEmail : req.contactEmail;
      if (newEmail) await notify({ audience: "client", clientId: req.clientId, contactEmail: newEmail, kind: "record_request_edited", title: `${num} was updated: ${parts.join(", ")}` }, tx);
      if ("contactEmail" in data && req.contactEmail && req.contactEmail !== newEmail) {
        await notify({ audience: "client", clientId: req.clientId, contactEmail: req.contactEmail, kind: "record_request_edited", title: `${num} is now handled for another contact` }, tx);
      }
    }
  };
  try {
    await prisma.$transaction(work, { maxWait: 10_000, timeout: 60_000 });
  } catch (e) {
    if (isUniqueViolation(e)) throw httpError(409, ALREADY_OPEN);
    throw e;
  }
  return getRequest(id);
}

// { items, total }, newest first. Filters: clientId, status (one or several), kind, source, q (request number, client name, or an internal code on it).
async function listRequests(params = {}) {
  const where = {};
  if (params.clientId) where.clientId = String(params.clientId);
  if (params.status) {
    const list = (Array.isArray(params.status) ? params.status : [params.status]).map(String);
    if (list.some((s) => !STATUSES.includes(s))) throw httpError(400, `status must be one of ${STATUSES.join(", ")}`);
    where.status = { in: list };
  }
  if (params.kind) {
    if (!KINDS.includes(String(params.kind))) throw httpError(400, `kind must be one of ${KINDS.join(", ")}`);
    where.kind = String(params.kind);
  }
  if (params.source) {
    if (!["staff", "portal"].includes(String(params.source))) throw httpError(400, "source must be staff or portal");
    where.source = String(params.source);
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

module.exports = {
  createRequest,
  getRequest,
  listRequests,
  listRequestEvents,
  changeStatus,
  editRequest,
  // shared with the portal (portalRecordService.js)
  serializeRequest,
  summaryOf,
  addRequestEvent,
  releaseLocks,
  isUniqueViolation,
  ALREADY_OPEN,
  LOAN_TYPES,
  CHANNELS,
  STATUSES,
  KINDS,
  MAX_RECORDS,
  MAX_NOTES,
};
