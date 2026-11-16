// Bulk box import (Docbox "Entradas a Almacen"): a client's boxes arrive as rows of a spreadsheet (CSV) instead of being
// registered through the wizard one batch at a time. Every row is checked first; if ANY row is wrong nothing is saved and
// the caller gets the list of problems per row (like Docbox's "errores de entradas" file). With dryRun the rows are only
// checked. Boxes are created "unallocated" -- put them on shelves afterwards with the normal allocate / put-away flow.
const prisma = require("../config/prisma");
const { nextSequence } = require("./counterService");
const { appendAuditEvent } = require("./auditService");
const { listBoxSizes } = require("./boxSizeService");
const { checkValues } = require("./customFieldService");
const { TX_OPTIONS } = require("./boxAllocationService");
const { serializeBox, toDate } = require("../utils/serialize");
const httpError = require("../utils/httpError");

const MAX_ROWS = 500;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const text = (v) => (v === undefined || v === null ? "" : String(v).trim());

// Accepts 2026-10-28 or 28/10/2026 (what Excel in Spain / the UK writes); returns YYYY-MM-DD or null.
function parseDate(value) {
  const v = text(value);
  if (!v) return null;
  let iso = null;
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
  if (ISO_DATE.test(v)) iso = v;
  else if (dmy) iso = `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  if (!iso) return undefined; // present but not a date
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? undefined : iso;
}

async function validateRows(rows, clientId) {
  const [sizeList, rules, fieldDefs] = await Promise.all([
    listBoxSizes(),
    prisma.retentionRule.findMany({ where: { isCurrent: true }, select: { code: true } }),
    prisma.customFieldDef.findMany({ where: { clientId, active: true }, orderBy: { position: "asc" } }),
  ]);
  const sizes = new Map();
  for (const s of sizeList.items) {
    sizes.set(s.code.toLowerCase(), s);
    sizes.set(s.name.toLowerCase(), s);
  }
  const retention = new Set(rules.map((r) => r.code));

  const errors = [];
  const clean = [];
  rows.forEach((raw, i) => {
    const rowNo = i + 2; // row 1 of the sheet is the header
    const problems = [];
    const r = raw && typeof raw === "object" ? raw : {};

    const description = text(r.description);
    if (!description) problems.push("description is required");
    else if (description.length > 500) problems.push("description is too long (500 characters at most)");

    const palletNo = text(r.palletNo);
    if (palletNo.length > 40) problems.push("pallet number is too long (40 characters at most)");

    const filingDateFrom = parseDate(r.filingDateFrom);
    if (filingDateFrom === null) problems.push("filingDateFrom is required");
    else if (filingDateFrom === undefined) problems.push("filingDateFrom is not a date (use YYYY-MM-DD or DD/MM/YYYY)");

    const filingDateTo = parseDate(r.filingDateTo);
    if (filingDateTo === undefined) problems.push("filingDateTo is not a date");
    const destroyAfter = parseDate(r.destroyAfter);
    if (destroyAfter === undefined) problems.push("destroyAfter is not a date");
    if (filingDateFrom && filingDateTo && filingDateTo < filingDateFrom) problems.push("filingDateTo is before filingDateFrom");

    let size = sizes.get(text(r.size).toLowerCase() || "standard");
    if (!size) problems.push(`unknown box size "${text(r.size)}"`);
    else if (!size.active) problems.push(`box size ${size.name} is retired`);

    const retentionCategory = text(r.retentionCategory).toUpperCase();
    if (retentionCategory && !retention.has(retentionCategory)) problems.push(`unknown retention category "${retentionCategory}"`);

    // The client's own fields: { C1: "...", ... } -- types and mandatory flags come from the field definitions.
    const custom = checkValues(fieldDefs, r.customFields);
    problems.push(...custom.problems);

    if (problems.length) {
      errors.push({ row: rowNo, message: problems.join("; ") });
      return;
    }
    clean.push({
      description,
      department: text(r.department) || undefined,
      reference: text(r.reference) || undefined,
      palletNo: palletNo || undefined,
      filingDateFrom,
      filingDateTo: filingDateTo || undefined,
      destroyAfter: destroyAfter || undefined,
      retentionCategory: retentionCategory || undefined,
      customFields: Object.keys(custom.clean).length ? custom.clean : undefined,
      size: size.code,
      lengthCm: size.lengthCm,
    });
  });
  return { errors, clean };
}

async function importBoxes(input, actor) {
  const clientId = text(input.clientId);
  const clientName = text(input.clientName);
  if (!clientId || !clientName) throw httpError(400, "clientId and clientName are required");
  if (!Array.isArray(input.rows) || input.rows.length === 0) throw httpError(400, "rows (non-empty array) is required");
  if (input.rows.length > MAX_ROWS) throw httpError(400, `At most ${MAX_ROWS} rows per import — split the file`);

  const { errors, clean } = await validateRows(input.rows, clientId);
  if (errors.length) {
    const err = httpError(422, `${errors.length} row${errors.length === 1 ? " has" : "s have"} problems — nothing was imported`);
    err.errorCode = "IMPORT_INVALID";
    err.rowErrors = errors;
    throw err;
  }
  if (input.dryRun) return { dryRun: true, count: clean.length, boxes: [] };

  const boxes = await prisma.$transaction(async (tx) => {
    const created = [];
    for (const row of clean) {
      const seq = await nextSequence("boxSeq", tx);
      const barcode = `BX${String(seq).padStart(8, "0")}`;
      const box = await tx.box.create({
        data: {
          boxNumber: barcode,
          barcode,
          clientId,
          clientName,
          description: row.description,
          department: row.department,
          reference: row.reference,
          palletNo: row.palletNo,
          filingDateFrom: toDate(row.filingDateFrom),
          filingDateTo: row.filingDateTo ? toDate(row.filingDateTo) : undefined,
          destroyAfter: row.destroyAfter ? toDate(row.destroyAfter) : undefined,
          retentionCategory: row.retentionCategory,
          customFields: row.customFields,
          size: row.size,
          lengthCm: row.lengthCm,
          status: "unallocated",
          onHold: false,
          labelPrinted: false,
          createdBy: actor,
        },
      });
      await appendAuditEvent(box, "registered", actor, { note: "Bulk import" }, tx);
      created.push(serializeBox(box));
    }
    return created;
  }, { ...TX_OPTIONS, timeout: 60_000 });
  return { dryRun: false, count: boxes.length, boxes };
}

module.exports = { importBoxes, MAX_ROWS };
