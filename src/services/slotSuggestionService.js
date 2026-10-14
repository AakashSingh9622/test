// Slot suggestion algorithm -- frontend/src/domain/slotSuggestion.ts se port kiya gaya, same
// scoring/reasons, bas ab real Postgres data (Slot/Rack/Warehouse/Box) se chalta hai.
const prisma = require("../config/prisma");
const { rackLabelFor } = require("./boxAllocationService");
const { getBoxSizes } = require("./boxSizeService");

// Total length (cm) jo ye boxes cell me gherenge.
function unitsFor(sizes, lengths) {
  return sizes.reduce((sum, size) => sum + (lengths[size] ?? lengths.standard), 0);
}

async function suggestSlotsForBoxes({ clientId, boxSizes, warehouseId, preferSlotIds }) {
  const totalUnits = unitsFor(boxSizes, await getBoxSizes());
  if (totalUnits <= 0) return [];

  const where = { status: { not: "blocked" } };
  if (warehouseId) where.warehouseId = warehouseId;
  // rack + warehouse ek hi query me -- locationPath banane ke liye alag lookups nahi chahiye.
  const candidateSlots = await prisma.slot.findMany({ where, include: { rack: true, warehouse: true } });
  const eligible = candidateSlots.filter((s) => s.capacity - s.used >= totalUnits);
  if (eligible.length === 0) return [];

  // Client ke existing boxes kis rack me hain -- "same rack" bonus dene ke liye.
  const clientBoxes = await prisma.box.findMany({
    where: { clientId, slotId: { not: null } },
    select: { slot: { select: { rackId: true } } },
  });
  const clientBoxCountByRack = new Map();
  for (const b of clientBoxes) {
    if (!b.slot) continue;
    clientBoxCountByRack.set(b.slot.rackId, (clientBoxCountByRack.get(b.slot.rackId) || 0) + 1);
  }

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
    if (clientCount > 0) {
      score += 20;
      reasons.push(`Same rack as ${clientCount} other box${clientCount === 1 ? "" : "es"} from this client`);
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
    locationPath: {
      warehouse: slot.warehouse.code,
      rack: rackLabelFor(slot.rack),
      slot: slot.code,
    },
    freeCapacity: free - totalUnits,
    score,
    reasons,
  }));
}

module.exports = { suggestSlotsForBoxes };
