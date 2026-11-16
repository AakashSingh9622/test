// Bulk operations driven by a list from a file (Docbox "Cambio de Ubicacion" and the box list of an "Expurgo"):
//   resolveBoxes  turns a list of scanned / typed codes into boxes, saying which ones can't be used and why
//   bulkMove      moves many boxes to new shelves / positions in ONE transaction (all or nothing)
// Nothing here bypasses the normal rules: moves go through allocateBoxes (capacity, status checks, movement ledger,
// history events) and the box lists are used with the normal order creation (legal holds, authorisation, approvals).
const prisma = require("../config/prisma");
const { allocateBoxes, isActiveSlot } = require("./boxAllocationService");
const { resolveLocation } = require("./locationService");
const { getBoxIneligibilityReason } = require("./boxEligibility");
const { boxLengthCm } = require("../utils/dimensions");
const { serializeBox } = require("../utils/serialize");
const httpError = require("../utils/httpError");

const MAX_ROWS = 500;
const ORDER_TYPES = ["collection", "dispatch", "destruction", "digitize"];
const text = (v) => (v === undefined || v === null ? "" : String(v).trim());

// Current barcode or box number (the number is also the code of the box's first label), any letter case.
async function findBoxesByCodes(codes) {
  const variants = new Set();
  for (const c of codes) {
    variants.add(c);
    variants.add(c.toUpperCase());
  }
  const rows = await prisma.box.findMany({
    where: { OR: [{ barcode: { in: [...variants] } }, { boxNumber: { in: [...variants] } }] },
  });
  const byCode = new Map();
  for (const b of rows) {
    byCode.set(b.barcode.toUpperCase(), b);
    byCode.set(b.boxNumber.toUpperCase(), b);
  }
  return byCode;
}

// POST /boxes/resolve { codes, clientId?, orderType? }
//   -> { items: [{ code, box?, problem? }] }  (same order as the codes; a repeated code only counts once)
// With clientId, a box of another client is a problem; with orderType, so is a box that can't go on that order.
async function resolveBoxes({ codes, clientId, orderType }) {
  if (!Array.isArray(codes) || codes.length === 0) throw httpError(400, "codes (non-empty array) is required");
  if (codes.length > MAX_ROWS) throw httpError(400, `At most ${MAX_ROWS} boxes per file — split it`);
  if (orderType && !ORDER_TYPES.includes(orderType)) throw httpError(400, "Unknown orderType");
  const clean = codes.map(text);
  const byCode = await findBoxesByCodes([...new Set(clean.filter(Boolean))]);
  const seen = new Set();
  const items = clean.map((code) => {
    if (!code) return { code, problem: "empty code" };
    const box = byCode.get(code.toUpperCase());
    if (!box) return { code, problem: "no box has this code" };
    if (seen.has(box.id)) return { code, problem: "listed twice" };
    seen.add(box.id);
    if (clientId && box.clientId !== clientId) return { code, box: serializeBox(box), problem: "belongs to a different client" };
    const reason = orderType ? getBoxIneligibilityReason(box, orderType) : null;
    if (reason) return { code, box: serializeBox(box), problem: reason };
    return { code, box: serializeBox(box) };
  });
  return { items };
}

// POST /boxes/bulk-move { rows: [{ box, location }], dryRun?, reason? }
//   box       barcode or box number
//   location  a shelf or position code, e.g. "A-1" (rack A, shelf 1) or "A-1-3" (also position 3) or a position barcode
// Every row is checked first, counting the space the earlier rows of the same file take; any problem -> 422 with
// [{ row, message }] and nothing moves.
async function bulkMove({ rows, dryRun, reason }, actor) {
  if (!Array.isArray(rows) || rows.length === 0) throw httpError(400, "rows (non-empty array) is required");
  if (rows.length > MAX_ROWS) throw httpError(400, `At most ${MAX_ROWS} rows per file — split it`);

  const codes = rows.map((r) => text(r?.box));
  const byCode = await findBoxesByCodes([...new Set(codes.filter(Boolean))]);
  const errors = [];
  const allocations = [];
  const used = new Map(); // slotId -> cm taken (+) / freed (-) by earlier rows of this file
  const slotCache = new Map();
  const movedBoxes = new Set();

  for (let i = 0; i < rows.length; i++) {
    const rowNo = i + 2; // row 1 of the sheet is the header
    const fail = (message) => errors.push({ row: rowNo, message });
    const code = codes[i];
    const where = text(rows[i]?.location);
    if (!code) {
      fail("box is empty");
      continue;
    }
    if (!where) {
      fail("location is empty");
      continue;
    }
    const box = byCode.get(code.toUpperCase());
    if (!box) {
      fail(`no box has the code ${code}`);
      continue;
    }
    if (movedBoxes.has(box.id)) {
      fail(`${box.boxNumber} is listed twice`);
      continue;
    }
    if (["destroyed", "permanently_withdrawn", "return_pending"].includes(box.status)) {
      fail(`${box.boxNumber} is ${box.status.replace(/_/g, " ")} and can't be moved`);
      continue;
    }
    const need = box.lengthCm ?? boxLengthCm(box);

    let found;
    try {
      found = await resolveLocation(where, { needCm: need });
    } catch (e) {
      fail(e.message);
      continue;
    }
    if (found.kind === "ambiguous" || found.kind === "not_found" || found.kind === "rack") {
      fail(found.kind === "rack" ? `${where}: give a shelf too, e.g. ${where}-1` : (found.message ?? `no location ${where}`));
      continue;
    }
    // A position is used as it is; a shelf takes the first of its positions with enough room (counting this file's earlier rows).
    const free = (slot) => {
      const cached = slotCache.get(slot.id) ?? slot;
      slotCache.set(slot.id, cached);
      return cached.capacity - cached.used - (used.get(slot.id) ?? 0);
    };
    const candidates = found.positions ?? [];
    const slot = candidates.find((s) => isActiveSlot(s) && (box.slotId === s.id || free(s) >= need));
    if (!slot) {
      fail(candidates.length && candidates.every((s) => !isActiveSlot(s)) ? `${where} is not available` : `${where} has no room for ${box.boxNumber} (${need} cm)`);
      continue;
    }
    if (box.slotId !== slot.id) {
      used.set(slot.id, (used.get(slot.id) ?? 0) + need);
      if (box.slotId) used.set(box.slotId, (used.get(box.slotId) ?? 0) - need);
    }
    movedBoxes.add(box.id);
    allocations.push({ boxId: box.id, slotId: slot.id });
  }

  if (errors.length) {
    const err = httpError(422, `${errors.length} row${errors.length === 1 ? " has" : "s have"} problems — nothing was moved`);
    err.errorCode = "IMPORT_INVALID";
    err.rowErrors = errors;
    throw err;
  }
  if (dryRun) return { dryRun: true, count: allocations.length };

  const moved = await allocateBoxes({ allocations, reason: text(reason) || "Bulk location change" }, actor);
  return { dryRun: false, count: moved.length };
}

module.exports = { resolveBoxes, bulkMove, MAX_ROWS };
