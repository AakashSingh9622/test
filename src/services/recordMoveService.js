// Docbox "Cambio de ubicación" for RECORDS (Phase 2, stage 9): move records from one box to another by file. A record has
// no shelf of its own -- it is in a box, so its place is always its box's place; moving it to another box changes that.
// (Moving whole BOXES to another shelf is the box bulk move, boxBulkService.js -- untouched.)
// All or nothing: every row is checked first (`dryRun` only checks) and each bad row is named by its row in the file.
// The record's whole history stays; each move adds one "moved" row: "BX..149 → BX..150".
const prisma = require("../config/prisma");
const httpError = require("../utils/httpError");
const { activeHoldsForBoxes } = require("./legalHoldService");

const MAX_ROWS = 500;
const text = (v) => (v == null ? "" : String(v).trim());
const norm = (s) => text(s).toLowerCase().replace(/\s+/g, " ");
const GONE = ["destroyed", "permanently_withdrawn"];
const goneWord = (s) => (s === "destroyed" ? "destroyed" : "permanently withdrawn");

// Checks every row. Returns { errors: [{ row, message }], moves: [{ record, from, to }] }.
async function validateRows(rows, clientId, clientName) {
  const codes = [];
  for (const r of rows) {
    const s = text(r?.internalCode);
    if (/^\d{1,9}$/.test(s)) codes.push(Number(s));
  }
  const records = codes.length ? await prisma.archiveRecord.findMany({ where: { internalCode: { in: codes } } }) : [];
  const byCode = new Map(records.map((r) => [r.internalCode, r]));

  const keys = [...new Set(rows.map((r) => text(r?.newBox).toUpperCase()).filter(Boolean))];
  const destBoxes = keys.length ? await prisma.box.findMany({ where: { OR: [{ boxNumber: { in: keys } }, { barcode: { in: keys } }] } }) : [];
  const byKey = new Map();
  for (const b of destBoxes) {
    byKey.set(b.boxNumber.toUpperCase(), b);
    byKey.set(b.barcode.toUpperCase(), b);
  }
  const srcIds = [...new Set(records.map((r) => r.boxId))];
  const srcBoxes = srcIds.length ? await prisma.box.findMany({ where: { id: { in: srcIds } } }) : [];
  const srcById = new Map(srcBoxes.map((b) => [b.id, b]));
  const held = await activeHoldsForBoxes([...new Map([...srcBoxes, ...destBoxes].map((b) => [b.id, b])).values()]);

  const errors = [];
  const moves = [];
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
    const customer = text(r.customer);
    if (customer && norm(customer) !== norm(clientId) && norm(customer) !== norm(clientName)) problems.push(`Customer "${customer}" is not this client`);

    // the destination box
    const key = text(r.newBox).toUpperCase();
    let dest = null;
    if (!key) problems.push("New box no. is required");
    else {
      dest = byKey.get(key) || null;
      if (!dest) problems.push(`Box ${text(r.newBox)} is not registered`);
    }

    if (record) {
      const from = srcById.get(record.boxId);
      if (record.clientId !== clientId) problems.push(`Record ${record.internalCode} belongs to another client (${record.clientName})`);
      else {
        const file = text(r.file);
        if (file && norm(file) !== norm(record.expedienteCode || "")) {
          problems.push(record.expedienteCode ? `File "${file}" doesn't match the record's file "${record.expedienteCode}"` : `Record ${record.internalCode} has no file, but the row says "${file}"`);
        }
        if (record.status !== "archived") problems.push(`Record ${record.internalCode} is ${record.status.replace("_", " ")} — only archived records can be moved`);
        // source box
        if (from && GONE.includes(from.status)) problems.push(`Its current box ${from.boxNumber} is ${goneWord(from.status)}`);
        if (from && held.has(from.id)) problems.push(`Its current box ${from.boxNumber} is under legal hold (${held.get(from.id)[0].authority}) — records can't leave it`);
        // destination box
        if (dest) {
          if (dest.clientId !== record.clientId) problems.push(`Box ${dest.boxNumber} belongs to another client (${dest.clientName || dest.clientId}) — a record can only go to a box of the same client`);
          else if ((dest.expedienteId ?? null) !== (record.expedienteId ?? null)) {
            problems.push(`Box ${dest.boxNumber} is in file ${dest.expedienteCode || "(none)"}, the record is in file ${record.expedienteCode || "(none)"} — a record can only go to a box of the same file`);
          }
          if (GONE.includes(dest.status)) problems.push(`Box ${dest.boxNumber} is ${goneWord(dest.status)}`);
          if (held.has(dest.id)) problems.push(`Box ${dest.boxNumber} is under legal hold (${held.get(dest.id)[0].authority})`);
          if (dest.id === record.boxId) problems.push(`Record ${record.internalCode} is already in box ${dest.boxNumber}`);
        }
      }
    }

    if (problems.length) errors.push({ row: rowNo, message: problems.join("; ") });
    else moves.push({ record, from: srcById.get(record.boxId), to: dest });
  });
  return { errors, moves };
}

//   input { clientId, clientName?, dryRun?, rows: [{ row?, internalCode, file?, customer?, newBox }] }
async function moveRecords(input, actor) {
  const clientId = input.clientId == null ? "" : String(input.clientId); // exact: a stored id can have spaces
  if (!clientId.trim()) throw httpError(400, "clientId is required");
  if (!Array.isArray(input.rows) || input.rows.length === 0) throw httpError(400, "rows (non-empty array) is required");
  if (input.rows.length > MAX_ROWS) throw httpError(400, `At most ${MAX_ROWS} rows per file — split it`);

  const { errors, moves } = await validateRows(input.rows, clientId, text(input.clientName));
  if (errors.length) {
    errors.sort((a, b) => a.row - b.row);
    const err = httpError(422, `${errors.length} row${errors.length === 1 ? " has" : "s have"} problems — nothing was moved`);
    err.errorCode = "MOVE_INVALID";
    err.rowErrors = errors;
    throw err;
  }
  if (input.dryRun) return { dryRun: true, count: moves.length };

  // One update per (from box -> to box) pair, then every history row at once, all in one transaction. The status and box
  // filters are the real guard against someone else changing a record at the same moment: if one changed, the count is short.
  const groups = new Map();
  for (const m of moves) {
    const k = `${m.record.boxId}>${m.to.id}`;
    if (!groups.has(k)) groups.set(k, { from: m.from, to: m.to, ids: [] });
    groups.get(k).ids.push(m.record.id);
  }
  await prisma.$transaction(
    async (tx) => {
      for (const g of groups.values()) {
        const done = await tx.archiveRecord.updateMany({ where: { id: { in: g.ids }, status: "archived", boxId: g.from.id }, data: { boxId: g.to.id, boxNumber: g.to.boxNumber } });
        if (done.count !== g.ids.length) throw httpError(409, "Some records were changed by someone else while moving — check the file again");
      }
      await tx.archiveRecordEvent.createMany({
        data: moves.map((m) => ({ recordId: m.record.id, type: "moved", note: `${m.from.boxNumber} → ${m.to.boxNumber}`, actor })),
      });
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
  return { dryRun: false, count: moves.length };
}

module.exports = { moveRecords, MAX_ROWS };
