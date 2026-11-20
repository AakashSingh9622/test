// Docbox "Expurgo" by file (Phase 2, stage 8): one Excel file for ONE client, one row per record. Each row either PURGES
// the record (destroyed for good -- who authorised it and on what date) or LENDS it (the rows marked "loan" become one
// record request, exactly like the request screen). Like the imports it is all or nothing: every row is checked first
// (`dryRun` only checks), and if any row is wrong nothing is saved and each bad row is reported by its row in the file.
// A file with any PURGE row waits for a second person (RecordPurgeRequest): the preparer can never approve it.
const prisma = require("../config/prisma");
const httpError = require("../utils/httpError");
const { activeHoldsForBoxes } = require("./legalHoldService");
const { createRequest, MAX_RECORDS } = require("./recordRequestService");
const { nextSequence } = require("./counterService");
const { parsePagination } = require("../utils/pagination");

const MAX_ROWS = 500;
const MAX_WHO = 200;
const text = (v) => (v == null ? "" : String(v).trim());
const norm = (s) => text(s).toLowerCase().replace(/\s+/g, " ");

// what the template's example row says (frontend: src/domain/record-purge.ts); a real purge can never carry it
const EXAMPLE_AUTHORISER = "Name of who authorised it";
const PURGE_WORDS = ["purge", "destroy", "destruction", "expurgo"];
const LOAN_WORDS = ["loan", "lend", "prestamo", "préstamo"];

// dd/mm/yyyy or yyyy-mm-dd -> a real date (UTC midnight), or null
function parseDate(v) {
  const s = text(v);
  let y, m, d;
  let hit = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (hit) [, y, m, d] = hit;
  else if ((hit = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) [, d, m, y] = hit;
  else return null;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) return null;
  return date;
}
const dateText = (d) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;

// Checks every row. Returns { errors: [{ row, message }], purge: [{ record, who, date }], loan: [record] }.
async function validateRows(rows, clientId, clientName) {
  const codes = [];
  for (const r of rows) {
    const s = text(r?.internalCode);
    if (/^\d{1,9}$/.test(s)) codes.push(Number(s));
  }
  const records = codes.length ? await prisma.archiveRecord.findMany({ where: { internalCode: { in: codes } } }) : [];
  const byCode = new Map(records.map((r) => [r.internalCode, r]));
  const boxes = records.length ? await prisma.box.findMany({ where: { id: { in: [...new Set(records.map((r) => r.boxId))] } } }) : [];
  const held = await activeHoldsForBoxes(boxes);
  const boxById = new Map(boxes.map((b) => [b.id, b]));

  const errors = [];
  const purge = [];
  const loan = [];
  const seen = new Set();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  rows.forEach((raw, i) => {
    const r = raw && typeof raw === "object" ? raw : {};
    const rowNo = Number.isInteger(r.row) && r.row > 1 ? r.row : i + 2;
    const problems = [];

    const codeText = text(r.internalCode);
    let record = null;
    if (!codeText) problems.push("Internal code is required");
    else if (!/^\d{1,9}$/.test(codeText)) problems.push(`"${codeText}" is not an internal code (digits only)`);
    else {
      const code = Number(codeText);
      record = byCode.get(code) || null;
      if (!record) problems.push(`No record has internal code ${code}`);
      else if (seen.has(code)) problems.push(`${code} is in the file twice`);
      seen.add(code);
    }

    const action = norm(r.action);
    const isPurge = PURGE_WORDS.includes(action);
    const isLoan = LOAN_WORDS.includes(action);
    if (!isPurge && !isLoan) problems.push(action ? `Action "${text(r.action)}" must be purge or loan` : "Action is required (purge or loan)");

    if (record) {
      if (record.clientId !== clientId) problems.push(`Record ${record.internalCode} belongs to another client (${record.clientName})`);
      else {
        const file = text(r.file);
        if (file && norm(file) !== norm(record.expedienteCode || "")) {
          problems.push(record.expedienteCode ? `File "${file}" doesn't match the record's file "${record.expedienteCode}"` : `Record ${record.internalCode} has no file, but the row says "${file}"`);
        }
        if (record.status !== "archived") problems.push(`Record ${record.internalCode} is ${record.status.replace("_", " ")} — only archived records can be ${isLoan ? "lent" : "purged"}`);
        const holds = held.get(record.boxId);
        if (isPurge && holds) problems.push(`Box ${boxById.get(record.boxId)?.boxNumber || record.boxNumber} is under legal hold (${holds[0].authority}) — can't be purged`);
      }
    }
    const customer = text(r.customer);
    if (customer && norm(customer) !== norm(clientId) && norm(customer) !== norm(clientName)) problems.push(`Customer "${customer}" is not this client`);

    // who authorised it and when are needed for a purge only
    let who = "";
    let date = null;
    if (isPurge) {
      who = text(r.authorisedBy);
      if (!who) problems.push("Authorised by is required for a purge");
      else if (who.length > MAX_WHO) problems.push(`Authorised by is too long (${MAX_WHO} characters at most)`);
      else if (norm(who) === norm(EXAMPLE_AUTHORISER)) problems.push("Authorised by still has the template's example text — type who really authorised it");
      if (!text(r.date)) problems.push("Date is required for a purge");
      else {
        date = parseDate(r.date);
        if (!date) problems.push(`Date "${text(r.date)}" isn't valid (use dd/mm/yyyy)`);
        else if (date > today) problems.push(`Date ${dateText(date)} is in the future`);
      }
    }

    if (problems.length) errors.push({ row: rowNo, message: problems.join("; ") });
    else if (isPurge) purge.push({ record, who, date });
    else loan.push(record);
  });
  return { errors, purge, loan };
}

// What a run does, inside ONE transaction: destroy the purge rows, put the loan rows on one request. `tail` says who signed.
async function runPlan(tx, { purge, loan, loanBlock, clientId, actor, tail }) {
  // The status filter is the real guard against another change at the same moment: if one record moved, the count is short.
  for (const { record, who, date } of purge) {
    const done = await tx.archiveRecord.updateMany({ where: { id: record.id, status: "archived" }, data: { status: "destroyed" } });
    if (done.count !== 1) throw httpError(409, `Record ${record.internalCode} was changed by someone else — check the file again`);
    await tx.archiveRecordEvent.create({
      data: { recordId: record.id, type: "destroyed", note: `archived → destroyed: purged by file, authorised by ${who} on ${dateText(date)}${tail || ""}`.slice(0, 500), actor },
    });
  }
  let request = null;
  if (loan.length) request = await createRequest({ ...(loanBlock || {}), clientId, recordIds: loan.map((r) => r.id) }, actor, tx);
  return { purged: purge.length, lent: loan.length, requestNumber: request?.requestNumber, requestId: request?.id };
}

const TX = { maxWait: 10_000, timeout: 60_000 };
const STATUSES = ["pending", "approved", "rejected", "cancelled"];

// Only plain strings are kept from what was uploaded (this is stored and shown back to the approver).
function cleanRows(rows) {
  return rows.map((r, i) => {
    const o = r && typeof r === "object" ? r : {};
    return {
      row: Number.isInteger(o.row) && o.row > 1 ? o.row : i + 2,
      internalCode: text(o.internalCode).slice(0, 20),
      file: text(o.file).slice(0, 100),
      customer: text(o.customer).slice(0, 200),
      action: text(o.action).slice(0, 20),
      authorisedBy: text(o.authorisedBy).slice(0, MAX_WHO + 1),
      date: text(o.date).slice(0, 20),
    };
  });
}
function cleanLoan(loan) {
  if (!loan || typeof loan !== "object") return null;
  const out = {};
  for (const k of ["loanType", "requestChannel", "contactName", "contactEmail", "notes"]) if (text(loan[k])) out[k] = text(loan[k]).slice(0, 500);
  return Object.keys(out).length ? out : null;
}

function serialize(r, withRows) {
  const out = {
    id: r.id,
    requestNumber: r.requestNumber,
    clientId: r.clientId,
    clientName: r.clientName,
    status: r.status,
    purgeCount: r.purgeCount,
    loanCount: r.loanCount,
    preparedBy: r.preparedBy,
    decidedBy: r.decidedBy,
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    decisionNote: r.decisionNote,
    result: r.result,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
  if (withRows) out.rows = r.rows;
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k]; // the frontend schemas use .optional(), not .nullable()
  return out;
}

//   input { clientId, clientName?, dryRun?, rows: [{ row?, internalCode, file?, customer?, action: "purge"|"loan", authorisedBy?, date? }],
//           loan?: { loanType?, requestChannel?, contactName?, contactEmail?, notes? } }
// Every row is checked first. A file with NO purge row (only loans) runs at once. A file with ANY purge row is saved as a
// pending request (PRG-nnnnnn) and nothing is changed until a different person approves it.
async function purgeByFile(input, actor) {
  const clientId = input.clientId == null ? "" : String(input.clientId); // exact: a stored id can have spaces
  if (!clientId.trim()) throw httpError(400, "clientId is required");
  if (!Array.isArray(input.rows) || input.rows.length === 0) throw httpError(400, "rows (non-empty array) is required");
  if (input.rows.length > MAX_ROWS) throw httpError(400, `At most ${MAX_ROWS} rows per file — split it`);

  const { errors, purge, loan } = await validateRows(input.rows, clientId, text(input.clientName));
  if (loan.length > MAX_RECORDS) errors.push({ row: 1, message: `At most ${MAX_RECORDS} records can be lent in one file` });
  if (errors.length) {
    errors.sort((a, b) => a.row - b.row);
    const err = httpError(422, `${errors.length} row${errors.length === 1 ? " has" : "s have"} problems — nothing was changed`);
    err.errorCode = "PURGE_INVALID";
    err.rowErrors = errors;
    throw err;
  }
  const needsApproval = purge.length > 0;
  if (input.dryRun) return { dryRun: true, purgeCount: purge.length, loanCount: loan.length, needsApproval };

  if (!needsApproval) {
    const result = await prisma.$transaction((tx) => runPlan(tx, { purge, loan, loanBlock: input.loan, clientId, actor }), TX);
    return { dryRun: false, pending: false, ...result };
  }

  const requestNumber = `PRG-${String(await nextSequence("purgeRequestSeq")).padStart(6, "0")}`;
  const created = await prisma.recordPurgeRequest.create({
    data: {
      requestNumber,
      clientId,
      clientName: text(input.clientName) || clientId,
      purgeCount: purge.length,
      loanCount: loan.length,
      rows: cleanRows(input.rows),
      loan: cleanLoan(input.loan),
      preparedBy: actor,
    },
  });
  return { dryRun: false, pending: true, requestId: created.id, requestNumber, purgeCount: purge.length, loanCount: loan.length };
}

async function getPurgeRequest(id) {
  const r = await prisma.recordPurgeRequest.findUnique({ where: { id } });
  if (!r) throw httpError(404, "Purge request not found");
  return serialize(r, true);
}

async function listPurgeRequests(params = {}) {
  const where = {};
  if (params.clientId) where.clientId = String(params.clientId);
  if (params.status) {
    const list = (Array.isArray(params.status) ? params.status : [params.status]).map(String);
    if (list.some((s) => !STATUSES.includes(s))) throw httpError(400, `status must be one of ${STATUSES.join(", ")}`);
    where.status = { in: list };
  }
  const q = text(params.q);
  if (q) where.OR = [{ requestNumber: { contains: q, mode: "insensitive" } }, { clientName: { contains: q, mode: "insensitive" } }];
  const { skip, take } = parsePagination(params, 25);
  const [rows, total] = await Promise.all([
    prisma.recordPurgeRequest.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip, take }),
    prisma.recordPurgeRequest.count({ where }),
  ]);
  return { items: rows.map((r) => serialize(r, false)), total };
}

const samePerson = (a, b) => !!a?.id && !!b?.id && a.id === b.id;

// The second signature. A DIFFERENT person than the one who prepared it. Every row is checked again first (the world may have
// changed since the upload: a record lent, a legal hold placed): if any row is wrong nothing runs and the request stays pending.
async function approvePurgeRequest(id, actor) {
  const req = await prisma.recordPurgeRequest.findUnique({ where: { id } });
  if (!req) throw httpError(404, "Purge request not found");
  if (req.status !== "pending") throw httpError(409, `${req.requestNumber} is already ${req.status}`);
  if (!actor?.id) throw httpError(403, "Can't tell who you are — sign in again");
  if (samePerson(req.preparedBy, actor)) throw httpError(403, "You prepared this purge — a different person must approve it");

  const { errors, purge, loan } = await validateRows(req.rows, req.clientId, req.clientName);
  if (errors.length) {
    errors.sort((a, b) => a.row - b.row);
    const err = httpError(422, `${errors.length} row${errors.length === 1 ? " is" : "s are"} no longer valid — nothing was purged. Reject this request and upload a corrected file`);
    err.errorCode = "PURGE_INVALID";
    err.rowErrors = errors;
    throw err;
  }
  const tail = `; prepared by ${req.preparedBy?.name || "?"}, approved by ${actor.name || "?"} (${req.requestNumber})`;
  const result = await prisma.$transaction(async (tx) => {
    // Only one approval can win: the request must still be pending.
    const claimed = await tx.recordPurgeRequest.updateMany({ where: { id, status: "pending" }, data: { status: "approved", decidedBy: actor, decidedAt: new Date() } });
    if (claimed.count !== 1) throw httpError(409, `${req.requestNumber} was decided by someone else`);
    const done = await runPlan(tx, { purge, loan, loanBlock: req.loan, clientId: req.clientId, actor, tail });
    await tx.recordPurgeRequest.update({ where: { id }, data: { result: done } });
    return done;
  }, TX);
  void result;
  return getPurgeRequest(id);
}

// Another person says no (a reason is required). The records are not touched.
async function rejectPurgeRequest(id, input, actor) {
  const note = text(input.note);
  if (!note) throw httpError(400, "A reason is required");
  if (note.length > 500) throw httpError(400, "The reason is too long (500 characters at most)");
  const req = await prisma.recordPurgeRequest.findUnique({ where: { id } });
  if (!req) throw httpError(404, "Purge request not found");
  if (req.status !== "pending") throw httpError(409, `${req.requestNumber} is already ${req.status}`);
  if (samePerson(req.preparedBy, actor)) throw httpError(403, "You prepared this purge — use Cancel to withdraw it");
  const done = await prisma.recordPurgeRequest.updateMany({ where: { id, status: "pending" }, data: { status: "rejected", decidedBy: actor, decidedAt: new Date(), decisionNote: note } });
  if (done.count !== 1) throw httpError(409, `${req.requestNumber} was decided by someone else`);
  return getPurgeRequest(id);
}

// The person who prepared it withdraws it (a mistake in the file). The records are not touched.
async function cancelPurgeRequest(id, actor) {
  const req = await prisma.recordPurgeRequest.findUnique({ where: { id } });
  if (!req) throw httpError(404, "Purge request not found");
  if (req.status !== "pending") throw httpError(409, `${req.requestNumber} is already ${req.status}`);
  if (!samePerson(req.preparedBy, actor)) throw httpError(403, "Only the person who prepared this purge can cancel it (anyone else can reject it)");
  const done = await prisma.recordPurgeRequest.updateMany({ where: { id, status: "pending" }, data: { status: "cancelled", decidedBy: actor, decidedAt: new Date() } });
  if (done.count !== 1) throw httpError(409, `${req.requestNumber} was decided by someone else`);
  return getPurgeRequest(id);
}

module.exports = { purgeByFile, getPurgeRequest, listPurgeRequests, approvePurgeRequest, rejectPurgeRequest, cancelPurgeRequest, MAX_ROWS };
