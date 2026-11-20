// Import of record requests (Phase 2, item 10a -- Docbox "IMPORTACION PRESTAMOS"): a file lists the records a client asked for
// (internal code, type physical / digital, urgency, who asked) and creates the requests in one go.
//   - Every row is checked first (`dryRun` only checks). If ANY row is wrong, nothing is created and each problem is named by its
//     Excel row. The creation itself is ONE transaction: all requests or none (and no request number is used up by a failure).
//   - "Requested by" must be a real contact of the client. The contacts live in DocuSoft, which only the staff browser can read, so the
//     screen sends the list it read (`contacts`); nothing is stored here. A contact switched off for loans (ContactPermission.canLoan
//     = false) is refused, exactly like in the portal.
//   - physical -> the records go ON LOAN at once;  digital -> the physical status is NEVER changed.
//   - Rows are grouped by (type, urgency, contact); a group is split into requests of at most MAX_RECORDS (100) records.
//   - One open request per record: a record already in an open request is refused (and the database lock stops two imports that
//     pass the check at the same moment).
const prisma = require("../config/prisma");
const httpError = require("../utils/httpError");
const { createRequest, MAX_RECORDS } = require("./recordRequestService");

const MAX_ROWS = 500;
const text = (v) => (v == null ? "" : String(v).trim());
const norm = (s) => text(s).toLowerCase().replace(/\s+/g, " ");
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// what a person may type -> what we store
const TYPES = { physical: "original", original: "original", paper: "original", digital: "digital" };
const URGENCY = { standard: "normal", normal: "normal", urgent: "urgent", superior: "superior", fax: "fax" };

// the contacts the screen read from DocuSoft: [{ email, name? }] -> Map(lower-case email -> name)
function readContacts(list) {
  if (!Array.isArray(list) || list.length === 0) throw httpError(400, "contacts (the client's DocuSoft contacts, as read by the screen) is required");
  if (list.length > 5000) throw httpError(400, "Too many contacts");
  const map = new Map();
  for (const c of list) {
    const email = text(c && c.email).toLowerCase();
    if (EMAIL.test(email) && !map.has(email)) map.set(email, text(c.name).slice(0, 200));
  }
  if (map.size === 0) throw httpError(400, "contacts has no valid email address");
  return map;
}

// Checks every row. Returns { errors: [{ row, message }], good: [{ row, record, kind, loanType, email }] }.
async function validateRows(rows, clientId, clientName, contacts) {
  const codes = [];
  for (const r of rows) {
    const s = text(r && r.internalCode);
    if (/^\d{1,9}$/.test(s)) codes.push(Number(s));
  }
  const records = codes.length ? await prisma.archiveRecord.findMany({ where: { internalCode: { in: codes } } }) : [];
  const byCode = new Map(records.map((r) => [r.internalCode, r]));
  const locks = records.length
    ? await prisma.recordRequestLine.findMany({ where: { lockKey: { in: records.map((r) => r.id) } }, select: { recordId: true, request: { select: { requestNumber: true } } } })
    : [];
  const openIn = new Map(locks.map((l) => [l.recordId, l.request.requestNumber]));
  const emails = [...new Set(rows.map((r) => text(r && r.requestedBy).toLowerCase()).filter((e) => EMAIL.test(e)))];
  const switchedOff = new Set(
    emails.length ? (await prisma.contactPermission.findMany({ where: { clientId, email: { in: emails }, canLoan: false }, select: { email: true } })).map((p) => p.email.toLowerCase()) : [],
  );

  const errors = [];
  const good = [];
  const seen = new Set();
  rows.forEach((raw, i) => {
    const r = raw && typeof raw === "object" ? raw : {};
    const rowNo = Number.isInteger(r.row) && r.row > 1 ? r.row : i + 2;
    const problems = [];

    // the record
    const codeText = text(r.internalCode);
    let record = null;
    if (!codeText) problems.push("Internal code is required");
    else if (!/^\d{1,9}$/.test(codeText)) problems.push(`"${codeText}" is not an internal code (digits only)`);
    else {
      const code = Number(codeText);
      if (seen.has(code)) problems.push(`${code} is in the file twice`);
      else {
        seen.add(code);
        record = byCode.get(code) || null;
        if (!record) problems.push(`No record has internal code ${code}`);
      }
    }
    if (record) {
      if (record.clientId !== clientId) problems.push(`Record ${record.internalCode} belongs to another client (${record.clientName})`);
      else {
        const file = text(r.file);
        if (file && norm(file) !== norm(record.expedienteCode || "")) {
          problems.push(record.expedienteCode ? `File "${file}" doesn't match the record's file "${record.expedienteCode}"` : `Record ${record.internalCode} has no file, but the row says "${file}"`);
        }
        // a record in an open request says so (and names it) before any status wording: that is the one to look at
        if (openIn.has(record.id)) problems.push(`Record ${record.internalCode} is already in another open request (${openIn.get(record.id)})`);
        else if (record.status !== "archived") problems.push(`Record ${record.internalCode} is ${record.status.replace("_", " ")} — only archived records can be requested`);
      }
    }
    const customer = text(r.customer);
    if (customer && norm(customer) !== norm(clientId) && norm(customer) !== norm(clientName)) problems.push(`Customer "${customer}" is not this client`);

    // type and urgency
    const typeText = text(r.type);
    const kind = TYPES[norm(typeText)];
    if (!typeText) problems.push("Type is required (physical or digital)");
    else if (!kind) problems.push(`Type "${typeText}" must be physical or digital`);
    const urgText = text(r.urgency);
    const loanType = URGENCY[norm(urgText)];
    if (!urgText) problems.push("Urgency is required (standard or urgent)");
    else if (!loanType) problems.push(`Urgency "${urgText}" must be standard or urgent`);

    // who asked: a real contact of THIS client, not switched off for loans
    const who = text(r.requestedBy).toLowerCase();
    if (!who) problems.push("Requested by is required (the contact's email)");
    else if (!EMAIL.test(who)) problems.push(`"${text(r.requestedBy)}" is not a valid email address`);
    else if (!contacts.has(who)) problems.push(`${who} is not a contact of this client`);
    else if (switchedOff.has(who)) problems.push(`${who} is not allowed to request (loan is switched off for this contact)`);

    if (problems.length) errors.push({ row: rowNo, message: problems.join("; ") });
    else good.push({ row: rowNo, record, kind, loanType, email: who });
  });
  return { errors, good };
}

// rows -> the requests to make: one per (kind, loan type, contact), at most MAX_RECORDS records each, in file order
function plan(good, contacts) {
  const groups = new Map();
  for (const g of good) {
    const key = `${g.kind}|${g.loanType}|${g.email}`;
    if (!groups.has(key)) groups.set(key, { kind: g.kind, loanType: g.loanType, contactEmail: g.email, contactName: contacts.get(g.email) || "", records: [] });
    groups.get(key).records.push(g.record);
  }
  const out = [];
  for (const g of groups.values()) {
    for (let i = 0; i < g.records.length; i += MAX_RECORDS) out.push({ ...g, records: g.records.slice(i, i + MAX_RECORDS) });
  }
  return out;
}

//   input { clientId, clientName?, dryRun?, contacts: [{ email, name? }], rows: [{ row?, internalCode, file?, customer?, type, urgency, requestedBy }] }
async function importRequests(input, actor) {
  const clientId = input.clientId == null ? "" : String(input.clientId); // exact: a stored id can have spaces
  if (!clientId.trim()) throw httpError(400, "clientId is required");
  if (!Array.isArray(input.rows) || input.rows.length === 0) throw httpError(400, "rows (non-empty array) is required");
  if (input.rows.length > MAX_ROWS) throw httpError(400, `At most ${MAX_ROWS} rows per file — split it`);
  const contacts = readContacts(input.contacts);

  const { errors, good } = await validateRows(input.rows, clientId, text(input.clientName), contacts);
  if (errors.length) {
    errors.sort((a, b) => a.row - b.row);
    const err = httpError(422, `${errors.length} row${errors.length === 1 ? " has" : "s have"} problems — nothing was requested`);
    err.errorCode = "IMPORT_INVALID";
    err.rowErrors = errors;
    throw err;
  }
  const requests = plan(good, contacts);
  const summary = (list) => list.map((q) => ({ kind: q.kind, loanType: q.loanType, contactEmail: q.contactEmail, contactName: q.contactName || undefined, recordCount: q.records.length }));
  if (input.dryRun) return { dryRun: true, count: good.length, requests: summary(requests) };

  // ONE transaction: every request (their numbers, the records going on loan, the history, the notifications) or none of it.
  const made = await prisma.$transaction(
    async (tx) => {
      const out = [];
      for (const q of requests) {
        const created = await createRequest(
          { clientId, recordIds: q.records.map((r) => r.id), kind: q.kind, loanType: q.loanType, contactEmail: q.contactEmail, contactName: q.contactName, notifyContact: true, via: "imported from a file" },
          actor,
          tx,
        );
        out.push({ id: created.id, requestNumber: created.requestNumber, kind: created.kind, loanType: created.loanType, contactEmail: created.contactEmail, contactName: created.contactName, recordCount: created.recordCount });
      }
      return out;
    },
    { maxWait: 10_000, timeout: 120_000 },
  );
  return { dryRun: false, count: good.length, requests: made };
}

module.exports = { importRequests, MAX_ROWS };
