// Bulk import of records (Docbox "Entradas a Almacén", Phase 2 item 4): one row = one record in an already registered box.
// Like the box import it is all or nothing -- every row is checked first (`dryRun` only checks), and if any row is wrong
// nothing is saved and each bad row is reported with its row number in the file.
const { randomUUID } = require("crypto");
const prisma = require("../config/prisma");
const httpError = require("../utils/httpError");
const { nextSequenceRange } = require("./counterService");
const { checkValues } = require("./customFieldService");
const { RECORD_CODE_BASE } = require("./archiveRecordService");

const MAX_ROWS = 500;
const MAX_COMMENT = 500;
const text = (v) => (v == null ? "" : String(v).trim());
const norm = (s) => text(s).toLowerCase().replace(/\s+/g, " ");

// Checks every row. Returns { errors: [{ row, message }], clean: [{ box, fields, comments }] }.
//   row.row  = the row number in the user's file (the header is row 1); falls back to index + 2
async function validateRows(rows, clientId, clientName, expediente) {
  const keys = [...new Set(rows.map((r) => text(r?.boxNo).toUpperCase()).filter(Boolean))];
  const boxes = keys.length
    ? await prisma.box.findMany({ where: { OR: [{ boxNumber: { in: keys } }, { barcode: { in: keys } }] } })
    : [];
  const byKey = new Map();
  for (const b of boxes) {
    byKey.set(b.boxNumber.toUpperCase(), b);
    byKey.set(b.barcode.toUpperCase(), b);
  }
  const defs = await prisma.customFieldDef.findMany({ where: { clientId, active: true }, orderBy: { position: "asc" } });

  const errors = [];
  const clean = [];
  rows.forEach((raw, i) => {
    const r = raw && typeof raw === "object" ? raw : {};
    const rowNo = Number.isInteger(r.row) && r.row > 1 ? r.row : i + 2;
    const problems = [];

    const key = text(r.boxNo).toUpperCase();
    let box = null;
    if (!key) problems.push("Box No. is required");
    else {
      box = byKey.get(key) || null;
      if (!box) problems.push(`Box ${text(r.boxNo)} is not registered`);
    }

    if (box) {
      if (box.clientId !== clientId) problems.push(`Box ${box.boxNumber} belongs to another client (${box.clientName || box.clientId})`);
      else if (expediente && box.expedienteId !== expediente.id) {
        problems.push(`Box ${box.boxNumber} belongs to file ${box.expedienteCode || "(none)"}, not ${expediente.code}`);
      } else if (box.status === "destroyed" || box.status === "permanently_withdrawn") {
        problems.push(`Box ${box.boxNumber} is ${box.status === "destroyed" ? "destroyed" : "permanently withdrawn"}`);
      }
      const file = text(r.file);
      if (file && norm(file) !== norm(box.expedienteCode || "")) {
        problems.push(box.expedienteCode ? `File "${file}" doesn't match box ${box.boxNumber}'s file "${box.expedienteCode}"` : `Box ${box.boxNumber} has no file, but the row says "${file}"`);
      }
    }
    const customer = text(r.customer);
    if (customer && norm(customer) !== norm(clientId) && norm(customer) !== norm(clientName)) {
      problems.push(`Customer "${customer}" is not this client`);
    }

    const comments = text(r.comments);
    if (comments.length > MAX_COMMENT) problems.push(`Comments are too long (${MAX_COMMENT} characters at most)`);

    // the client's own fields that apply to this box's file
    let fields = {};
    if (box && box.clientId === clientId) {
      const applicable = defs.filter((d) => d.expedienteId == null || d.expedienteId === box.expedienteId);
      const checked = checkValues(applicable, r.customFields);
      checked.problems.forEach((p) => problems.push(p));
      fields = checked.clean;
    }

    if (problems.length) errors.push({ row: rowNo, message: problems.join("; ") });
    else clean.push({ box, fields, comments: comments || null });
  });
  return { errors, clean };
}

//   input { clientId, clientName?, expedienteId?, rows: [{ row?, boxNo, file?, customer?, comments?, customFields?: { C1: "..." } }], dryRun? }
async function importRecords(input, actor) {
  const clientId = text(input.clientId);
  if (!clientId) throw httpError(400, "clientId is required");
  if (!Array.isArray(input.rows) || input.rows.length === 0) throw httpError(400, "rows (non-empty array) is required");
  if (input.rows.length > MAX_ROWS) throw httpError(400, `At most ${MAX_ROWS} rows per import — split the file`);

  let expediente = null;
  if (input.expedienteId) {
    expediente = await prisma.expediente.findUnique({ where: { id: String(input.expedienteId) } });
    if (!expediente || expediente.clientId !== clientId) throw httpError(400, "That file (expediente) doesn't belong to this client");
  }

  const { errors, clean } = await validateRows(input.rows, clientId, text(input.clientName), expediente);
  if (errors.length) {
    const err = httpError(422, `${errors.length} row${errors.length === 1 ? " has" : "s have"} problems — nothing was imported`);
    err.errorCode = "IMPORT_INVALID";
    err.rowErrors = errors;
    throw err;
  }
  if (input.dryRun) return { dryRun: true, count: clean.length };

  // One statement reserves all the internal codes (consecutive), then every record and its history row go in together.
  const last = await nextSequenceRange("recordSeq", clean.length);
  const first = last - clean.length + 1;
  const records = [];
  const events = [];
  clean.forEach(({ box, fields, comments }, i) => {
    const id = randomUUID();
    records.push({
      id,
      internalCode: RECORD_CODE_BASE + first + i,
      clientId: box.clientId,
      clientName: box.clientName,
      expedienteId: box.expedienteId ?? null,
      expedienteCode: box.expedienteCode ?? null,
      boxId: box.id,
      boxNumber: box.boxNumber,
      fields: Object.keys(fields).length ? fields : undefined,
      comments,
      createdBy: actor,
    });
    events.push({ recordId: id, type: "created", note: `Imported into ${box.boxNumber}`, actor });
  });
  await prisma.$transaction(
    async (tx) => {
      await tx.archiveRecord.createMany({ data: records });
      await tx.archiveRecordEvent.createMany({ data: events });
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
  return { dryRun: false, count: records.length, firstCode: records[0].internalCode, lastCode: records[records.length - 1].internalCode };
}

module.exports = { importRecords, MAX_ROWS };
