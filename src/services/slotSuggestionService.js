// Slot suggestion algorithm -- frontend/src/domain/slotSuggestion.ts se port kiya gaya, same
// scoring/reasons, bas ab real Postgres data (Slot/Rack/Warehouse/Box) se chalta hai.
const prisma = require("../config/prisma");
const { getBoxSizes } = require("./boxSizeService");
const { pathFor, RACK_PATH_INCLUDE } = require("../utils/locationPath");

// Total length (cm) jo ye boxes cell me gherenge.
function unitsFor(sizes, lengths) {
  return sizes.reduce((sum, size) => sum + (lengths[size] ?? lengths.standard ?? 40), 0);
}

async function suggestSlotsForBoxes({ clientId, boxSizes, warehouseId, preferSlotIds }) {
  const totalUnits = unitsFor(boxSizes, await getBoxSizes());
  if (totalUnits <= 0) return [];

  const where = { status: { in: ["available", "full"] } }; // only active slots (not blocked / quarantined / inactive)
  if (warehouseId) where.warehouseId = warehouseId;
  // rack + warehouse / zone / aisle ek hi query me -- locationPath banane ke liye alag lookups nahi chahiye.
  const candidateSlots = await prisma.slot.findMany({ where, include: { rack: { include: RACK_PATH_INCLUDE } } });
  const eligible = candidateSlots.filter((s) => s.capacity - s.used >= totalUnits);
  if (eligible.length === 0) return [];

  // Client ke existing boxes kis rack / aisle / zone me hain -- "same rack" (ya kam se kam same aisle / zone) bonus ke liye.
  const clientBoxes = await prisma.box.findMany({
    where: { clientId, slotId: { not: null } },
    select: { slot: { select: { rackId: true, rack: { select: { zoneId: true, aisleId: true } } } } },
  });
  const clientBoxCountByRack = new Map();
  const clientBoxCountByAisle = new Map();
  const clientBoxCountByZone = new Map();
  const bump = (map, key) => key && map.set(key, (map.get(key) || 0) + 1);
  for (const b of clientBoxes) {
    if (!b.slot) continue;
    bump(clientBoxCountByRack, b.slot.rackId);
    bump(clientBoxCountByAisle, b.slot.rack?.aisleId);
    bump(clientBoxCountByZone, b.slot.rack?.zoneId);
  }
  const boxes = (n) => `${n} other box${n === 1 ? "" : "es"} from this client`;

  const preferSet = new Set((preferSlotIds || []).map(String));

  const scored = eligible.map((slot) => {
    let score = 0;
    const reasons = [];
    const free = slot.capacity - slot.used;

    if (preferSet.has(slot.id)) {
      score += 100;
      reasons.push("Previous slot for this box");
    }

    const clientCount = clientBoxCountByRack.get(slot.rackId) || 0;
    const aisleCount = (slot.rack.aisleId && clientBoxCountByAisle.get(slot.rack.aisleId)) || 0;
    const zoneCount = (slot.rack.zoneId && clientBoxCountByZone.get(slot.rack.zoneId)) || 0;
    if (clientCount > 0) {
      score += 20;
      reasons.push(`Same rack as ${boxes(clientCount)}`);
    } else if (aisleCount > 0) {
      score += 10;
      reasons.push(`Same aisle as ${boxes(aisleCount)}`);
    } else if (zoneCount > 0) {
      score += 5;
      reasons.push(`Same zone as ${boxes(zoneCount)}`);
    }

    const wasted = free - totalUnits;
    if (wasted === 0) {
      score += 30;
      reasons.push("Fills slot to 100%");
    } else {
      score += Math.max(0, 15 - Math.floor(wasted / 40)); // 40 cm = pehle ki 1 unit
      if (slot.used > 0) reasons.push(`Partially filled (${slot.used}/${slot.capacity} cm used) — reduces fragmentation`);
    }

    if (reasons.length === 0) reasons.push("Has enough free space");

    return { slot, score, reasons, free };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, 5).map(({ slot, score, reasons, free }) => ({
    slotId: slot.id,
    locationPath: pathFor(slot.rack, slot),
    freeCapacity: free - totalUnits,
    score,
    reasons,
  }));
}

module.exports = { suggestSlotsForBoxes };
