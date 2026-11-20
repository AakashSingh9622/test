// Readable location snapshot stored on box.locationPath, audit events, movements and order lines (Sprint 10):
// { warehouse, zone?, aisle?, rack, slot, shelf?, position? } -- codes, not ids. Shelf = the rack's row, position = the
// cell's column; `slot` ("3-2") stays so older readers keep working. Older rows only have { warehouse, rack, slot } and
// are never rewritten (history is append-only) -- locationText() reads both.

// `rack` with its warehouse / zone / aisle loaded (codes are enough).
function pathFor(rack, slot) {
  return {
    warehouse: rack.warehouse?.code ?? slot.warehouseId,
    ...(rack.warehouse?.site && { site: rack.warehouse.site }),
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
  warehouse: { select: { code: true, site: true } },
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
    p.zone && `Floor ${p.zone}`,
    p.aisle && `Aisle ${p.aisle}`,
    `Module ${p.rack}`,
    shelf != null ? `Shelf ${shelf} · Position ${position}` : `Slot ${p.slot}`,
  ]
    .filter(Boolean)
    .join(" › ");
}


// The parts of a stored location as plain strings, for spreadsheets: { site, warehouse, zone, aisle, rack, shelf, position }.
// A part that isn't there is "" -- never 0 and never a date (the Docbox sample showed 01/01/1900 in Row/Shelf). Older rows
// ({ warehouse, rack, slot: "3-2" }) give shelf 3 / position 2 from the slot code. Goods-In has no shelf or position.
function locationColumns(p) {
  const str = (v) => (v === undefined || v === null ? "" : String(v));
  if (!p || typeof p !== "object") return { site: "", warehouse: "", zone: "", aisle: "", rack: "", shelf: "", position: "" };
  const [row, column] = /^\d+-\d+$/.test(p.slot ?? "") ? p.slot.split("-") : [];
  const goodsIn = p.rack === "Goods-In";
  return {
    site: str(p.site),
    warehouse: str(p.warehouse),
    zone: str(p.zone),
    aisle: str(p.aisle),
    rack: str(p.rack),
    shelf: goodsIn ? "" : str(p.shelf ?? row),
    position: goodsIn ? "" : str(p.position ?? column),
  };
}

// THE walking order, the same one the pick list uses (orderService.getPickList, spec §6.2) and used by the Return Records list, the
// printed shelving list and the shelving Excel so all four agree:
//     warehouse -> zone -> aisle -> rack -> shelf (row) -> position (column) -> box number
// Site is NOT part of the order (it is only a label shown in the Excel). A box with NO location comes LAST.
// Rows and columns are compared as numbers (padded to 4 digits, exactly like the pick list). The parts come from the box's LIVE slot when it
// has one (what the pick list reads), else from its stored location snapshot -- current or older ({ warehouse, rack, slot: "3-2" }).
//   source = { slot?: { row, column, warehouse: { code }, rack: { code, zone?: { code }, aisle?: { code } } }, locationPath? }
const pad4 = (v) => String(v !== "" && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : 0).padStart(4, "0");
function placeParts(source) {
  const slot = source && source.slot;
  if (slot) {
    return [slot.warehouse?.code ?? "", slot.rack?.zone?.code ?? "", slot.rack?.aisle?.code ?? "", slot.rack?.code ?? "", pad4(slot.row), pad4(slot.column)];
  }
  const snap = source && source.locationPath;
  if (snap && typeof snap === "object") {
    const c = locationColumns(snap);
    return [c.warehouse, c.zone, c.aisle, c.rack, pad4(c.shelf), pad4(c.position)];
  }
  return null; // no location
}
// Compare two placeParts() results. Use as:  compareByPlace(pa, pb) || a.boxNumber.localeCompare(b.boxNumber) || a.internalCode - b.internalCode
function compareByPlace(a, b) {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1; // no location -> last
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    return String(a[i]).localeCompare(String(b[i]));
  }
  return 0;
}

// What to load with a box so placeParts() can read its live slot.
const BOX_ORDER_SELECT = {
  locationPath: true,
  slot: { select: { row: true, column: true, warehouse: { select: { code: true } }, rack: { select: { code: true, zone: { select: { code: true } }, aisle: { select: { code: true } } } } } },
};

module.exports = { pathFor, RACK_PATH_INCLUDE, locationText, locationColumns, placeParts, compareByPlace, BOX_ORDER_SELECT };
