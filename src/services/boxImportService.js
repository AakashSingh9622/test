// Bulk box import (Docbox "Entradas a Almacen"): a client's boxes arrive as rows of a spreadsheet (CSV) instead of being
// registered through the wizard one batch at a time. Every row is checked first; if ANY row is wrong nothing is saved and
// the caller gets the list of problems per row (like Docbox's "errores de entradas" file). With dryRun the rows are only
// checked. Boxes are created "unallocated" -- put them on shelves afterwards with the normal allocate / put-away flow.
const prisma = require("../config/prisma");
const { nextSequence } = require("./counterService");
const { appendAuditEvent } = require("./auditService");
const { listBoxSizes } = require("./boxSizeService");
const { checkValues, appliesTo } = require("./customFieldService");
const { resolveForBox } = require("./expedienteService");
const { TX_OPTIONS, allocateBoxes, isActiveSlot } = require("./boxAllocationService");
const { resolveParts, hasLocationParts } = require("./locationParts");
const { serializeBox, toDate } = require("../utils/serialize");
const httpError = require("../utils/httpError");
const { formatVolume } = require("../utils/dimensions");

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

async function validateRows(rows, clientId, expedienteId) {
  const [sizeList, rules, fieldDefs] = await Promise.all([
    listBoxSizes(),
    prisma.retentionRule.findMany({ where: { isCurrent: true }, select: { code: true } }),
    prisma.customFieldDef.findMany({ where: { clientId, active: true, ...appliesTo(expedienteId) }, orderBy: { position: "asc" } }),
  ]);
  const sizes = new Map();
  for (const s of sizeList.items) {
    sizes.set(s.code.toLowerCase(), s);
    sizes.set(s.name.toLowerCase(), s);
  }
  const retention = new Set(rules.map((r) => r.code));

  const errors = [];
  const clean = [];
  const used = new Map(); // slotId -> cm taken by earlier rows of this same file
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const rowNo = i + 2; // row 1 of the sheet is the header
    const problems = [];
    const r = raw && typeof raw === "object" ? raw : {};

    const description = text(r.description);
    if (!description) problems.push("description is required");
    else if (description.length > 500) problems.push("description is too long (500 characters at most)");

    const comments = text(r.comments);
    if (comments.length > 1000) problems.push("comments are too long (1000 characters at most)");
    const entryDate = parseDate(r.entryDate);
    if (entryDate === undefined) problems.push("entryDate is not a date (use YYYY-MM-DD or DD/MM/YYYY)");

    const containerNo = text(r.containerNo);
    if (containerNo.length > 40) problems.push("container number is too long (40 characters at most)");
    const containerType = text(r.containerType);
    if (containerType.length > 40) problems.push("container type is too long (40 characters at most)");
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

    // Optional location columns (Warehouse, Floor, Aisle, Module, Shelf): when present the box is put on that shelf.
    let slotId;
    if (hasLocationParts(r) && size) {
      const placed = await resolveParts({ site: r.site, warehouse: r.warehouse, floor: r.floor, aisle: r.aisle, module: r.module, shelf: r.shelf }, { needCm: size.volumeCm3 });
      if (placed.error) problems.push(placed.error);
      else {
        // The first position of the shelf with room, counting the boxes the earlier rows already claimed.
        const slot = (placed.found.positions ?? []).find((s) => isActiveSlot(s) && s.capacity - s.used - (used.get(s.id) ?? 0) >= size.volumeCm3);
        if (!slot) problems.push(`shelf ${text(r.shelf)} of module ${text(r.module)} has no room for a ${size.name} box (${formatVolume(size.volumeCm3)})`);
        else {
          slotId = slot.id;
          used.set(slot.id, (used.get(slot.id) ?? 0) + size.volumeCm3);
        }
      }
    }

    if (problems.length) {
      errors.push({ row: rowNo, message: problems.join("; ") });
      continue;
    }
    clean.push({
      slotId,
      description,
      department: text(r.department) || undefined,
      reference: text(r.reference) || undefined,
      palletNo: palletNo || undefined,
      containerNo: containerNo || undefined,
      containerType: containerType || undefined,
      comments: comments || undefined,
      entryDate: entryDate || undefined,
      filingDateFrom,
      filingDateTo: filingDateTo || undefined,
      destroyAfter: destroyAfter || undefined,
      retentionCategory: retentionCategory || undefined,
      customFields: Object.keys(custom.clean).length ? custom.clean : undefined,
      size: size.code,
      lengthCm: size.lengthCm,
      heightCm: size.heightCm,
      depthCm: size.depthCm,
      volumeCm3: size.volumeCm3,
    });
  }
  return { errors, clean };
}

async function importBoxes(input, actor) {
  const clientId = text(input.clientId);
  const clientName = text(input.clientName);
  if (!clientId || !clientName) throw httpError(400, "clientId and clientName are required");
  if (!Array.isArray(input.rows) || input.rows.length === 0) throw httpError(400, "rows (non-empty array) is required");
  if (input.rows.length > MAX_ROWS) throw httpError(400, `At most ${MAX_ROWS} rows per import — split the file`);

  // Docbox "Fecha Entrada": one entry date for the whole file (today when left out); a row can carry its own.
  const fileEntry = input.entryDate ? parseDate(input.entryDate) : null;
  if (input.entryDate && !fileEntry) throw httpError(400, "entryDate is not a date (use YYYY-MM-DD)");
  const entryFallback = fileEntry || new Date().toISOString().slice(0, 10);

  // Docbox: the file is imported into one expediente of the client (needed when the client has any).
  const expediente = await resolveForBox(clientId, input.expedienteId);

  const { errors, clean } = await validateRows(input.rows, clientId, expediente.id);
  if (errors.length) {
    const err = httpError(422, `${errors.length} row${errors.length === 1 ? " has" : "s have"} problems — nothing was imported`);
    err.errorCode = "IMPORT_INVALID";
    err.rowErrors = errors;
    throw err;
  }
  const toPlace = clean.filter((c) => c.slotId).length;
  if (input.dryRun) return { dryRun: true, count: clean.length, placed: toPlace, boxes: [] };

  const planned = []; // { boxId, slotId } for the rows that came with a location
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
          containerNo: row.containerNo,
          containerType: row.containerType,
          expedienteId: expediente.id ?? undefined,
          expedienteCode: expediente.code ?? undefined,
          comments: row.comments,
          entryDate: toDate(row.entryDate || entryFallback),
          filingDateFrom: toDate(row.filingDateFrom),
          filingDateTo: row.filingDateTo ? toDate(row.filingDateTo) : undefined,
          destroyAfter: row.destroyAfter ? toDate(row.destroyAfter) : undefined,
          retentionCategory: row.retentionCategory,
          customFields: row.customFields,
          size: row.size,
          lengthCm: row.lengthCm,
          heightCm: row.heightCm,
          depthCm: row.depthCm,
          volumeCm3: row.volumeCm3,
          status: "unallocated",
          onHold: false,
          labelPrinted: false,
          createdBy: actor,
        },
      });
      await appendAuditEvent(box, "registered", actor, { note: "Bulk import" }, tx);
      if (row.slotId) planned.push({ boxId: box.id, slotId: row.slotId });
      created.push(serializeBox(box));
    }
    return created;
  }, { ...TX_OPTIONS, timeout: 60_000 });

  // Put the boxes that came with a location on their shelves (the normal allocation: capacity, ledger, history).
  let placed = 0;
  let placeProblem;
  if (planned.length) {
    try {
      const moved = await allocateBoxes({ allocations: planned, reason: "Bulk import" }, actor);
      placed = moved.length;
    } catch (e) {
      // The boxes ARE registered; only the shelving failed (e.g. someone filled the shelf a moment ago).
      placeProblem = e.message;
    }
  }
  return { dryRun: false, count: boxes.length, placed, ...(placeProblem && { placeProblem }), boxes };
}

module.exports = { importBoxes, MAX_ROWS };
