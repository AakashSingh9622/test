// Docbox spreadsheets give a location as separate columns: Warehouse, Floor (Block), Aisle (Corridor), Module (Rack /
// shelving unit) and Shelf (Row). This turns those columns into a shelf we can put boxes on, using the real layout
// (Settings -> Import layout creates a floor as a zone, an aisle as "<floor>-<aisle>" and a module as a rack "M<module>").
// Warehouse, Floor and Aisle are optional but, when given, must agree with where the module really is.
const prisma = require("../config/prisma");
const { resolveLocation } = require("./locationService");

const text = (v) => (v === undefined || v === null ? "" : String(v).trim());
const same = (a, b) => text(a).toLowerCase() === text(b).toLowerCase();

/** True if the row carries any location column at all. */
function hasLocationParts(parts) {
  return !!(text(parts?.warehouse) || text(parts?.floor) || text(parts?.aisle) || text(parts?.module) || text(parts?.shelf));
}

/**
 * Resolve the columns to a shelf (or position, if `position` is given).
 * Returns { found } (the shelf, as resolveLocation gives it) or { error } with a message fit for a row problem.
 */
async function resolveParts(parts, { needCm } = {}) {
  const moduleCode = text(parts.module);
  const shelf = text(parts.shelf);
  const position = text(parts.position);
  if (!moduleCode) return { error: "module is required to place the box on a shelf" };
  if (!/^\d+$/.test(shelf)) return { error: "shelf must be a number (1, 2, 3 …)" };
  if (position && !/^\d+$/.test(position)) return { error: "position must be a number" };

  let warehouseId;
  const warehouseText = text(parts.warehouse);
  if (warehouseText) {
    const warehouses = await prisma.warehouse.findMany({ select: { id: true, code: true, name: true, site: true } });
    const w = warehouses.find((x) => same(x.code, warehouseText) || same(x.name, warehouseText));
    if (!w) return { error: `no warehouse called "${warehouseText}"` };
    const siteText = text(parts.site);
    if (siteText && w.site && !same(w.site, siteText)) return { error: `warehouse ${w.name} is in site "${w.site}", not "${siteText}"` };
    if (siteText && !w.site) return { error: `warehouse ${w.name} has no site set, so "${siteText}" can't be checked — leave the site empty or set it on the warehouse` };
    warehouseId = w.id;
  }

  // The module as written, or the "M…" name that Import layout gives a rack.
  const names = [...new Set([moduleCode, /^m/i.test(moduleCode) ? moduleCode : `M${moduleCode}`])];
  let racks = [];
  for (const name of names) {
    racks = await prisma.rack.findMany({
      where: { code: { equals: name, mode: "insensitive" }, ...(warehouseId && { warehouseId }) },
      select: { id: true, code: true, warehouseId: true },
    });
    if (racks.length) break;
  }
  if (racks.length === 0) return { error: `no module ${moduleCode}${warehouseText ? ` in ${warehouseText}` : ""}` };
  if (racks.length > 1) return { error: `module ${moduleCode} exists in more than one warehouse — fill in the Warehouse column` };
  const rack = racks[0];

  const code = `${rack.code}-${shelf}${position ? `-${position}` : ""}`;
  let found;
  try {
    found = await resolveLocation(code, { rackId: rack.id, warehouseId: rack.warehouseId, needCm });
  } catch (e) {
    return { error: e.message };
  }
  if (found.kind !== "shelf" && found.kind !== "position") return { error: found.message ?? `no shelf ${shelf} in module ${moduleCode}` };

  // What was written must match where the module really is.
  const floor = text(parts.floor);
  if (floor && !(found.zone && (same(found.zone.code, floor) || same(found.zone.name, floor)))) {
    return { error: `module ${moduleCode} is not on floor ${floor}${found.zone ? ` (it is on ${found.zone.code})` : ""}` };
  }
  const aisle = text(parts.aisle);
  if (aisle) {
    const a = found.aisle;
    const ok = a && (same(a.code, aisle) || same(a.name, aisle) || (floor && same(a.code, `${floor}-${aisle}`)) || a.code.toLowerCase().endsWith(`-${aisle.toLowerCase()}`));
    if (!ok) return { error: `module ${moduleCode} is not in aisle ${aisle}${a ? ` (it is in ${a.code})` : ""}` };
  }
  return { found };
}

module.exports = { resolveParts, hasLocationParts };
