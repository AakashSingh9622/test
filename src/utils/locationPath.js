// Readable location snapshot stored on box.locationPath, audit events, movements and order lines (Sprint 10):
// { warehouse, zone?, aisle?, rack, slot, shelf?, position? } -- codes, not ids. Shelf = the rack's row, position = the
// cell's column; `slot` ("3-2") stays so older readers keep working. Older rows only have { warehouse, rack, slot } and
// are never rewritten (history is append-only) -- locationText() reads both.

// `rack` with its warehouse / zone / aisle loaded (codes are enough).
function pathFor(rack, slot) {
  return {
    warehouse: rack.warehouse?.code ?? slot.warehouseId,
    ...(rack.zone && { zone: rack.zone.code }),
    ...(rack.aisle && { aisle: rack.aisle.code }),
    rack: rack.code,
    slot: slot.code,
    shelf: slot.row,
    position: slot.column,
  };
}

// The include that loads what pathFor needs.
const RACK_PATH_INCLUDE = {
  warehouse: { select: { code: true } },
  zone: { select: { code: true } },
  aisle: { select: { code: true } },
};

// "WH1 › Zone A › Aisle 3 › Rack B04 › Shelf 3 · Position 2" (old rows: shelf / position read from the "3-2" code).
function locationText(p) {
  if (!p) return "";
  if (p.rack === "Goods-In") return `${p.warehouse} › Goods-In`;
  const [row, column] = /^\d+-\d+$/.test(p.slot ?? "") ? p.slot.split("-") : [];
  const shelf = p.shelf ?? row;
  const position = p.position ?? column;
  return [
    p.warehouse,
    p.zone && `Zone ${p.zone}`,
    p.aisle && `Aisle ${p.aisle}`,
    `Rack ${p.rack}`,
    shelf != null ? `Shelf ${shelf} · Position ${position}` : `Slot ${p.slot}`,
  ]
    .filter(Boolean)
    .join(" › ");
}

module.exports = { pathFor, RACK_PATH_INCLUDE, locationText };
