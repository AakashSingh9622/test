// Warehouse -> Rack -> Slot business logic. rackCount/slotCount/usedCapacity/totalCapacity
// Warehouse aur Rack rows me store NAHI hote (prisma/schema.prisma dekho) -- yahan slot rows
// se on-read aggregate karke attach kiye jaate hain, taaki asli data se kabhi out-of-sync na ho.
const prisma = require("../config/prisma");
const { serializeSimple } = require("../utils/serialize");
const { toCentimetres } = require("../utils/dimensions");

const SUM_FIELDS = { _count: { _all: true }, _sum: { used: true, capacity: true } };

// Ek warehouse ke saare racks/slots se capacity numbers nikalta hai.
async function capacityForWarehouse(warehouseId) {
  const [rackCount, totals] = await Promise.all([
    prisma.rack.count({ where: { warehouseId } }),
    prisma.slot.aggregate({ where: { warehouseId }, ...SUM_FIELDS }),
  ]);
  return {
    rackCount,
    slotCount: totals._count._all,
    usedCapacity: totals._sum.used || 0,
    totalCapacity: totals._sum.capacity || 0,
  };
}

// Ek rack ke saare slots se capacity numbers nikalta hai.
async function capacityForRack(rackId) {
  const totals = await prisma.slot.aggregate({ where: { rackId }, ...SUM_FIELDS });
  return { usedCapacity: totals._sum.used || 0, totalCapacity: totals._sum.capacity || 0 };
}

function withCapacity(row, capacity) {
  return { ...serializeSimple(row), ...capacity };
}

async function listWarehouses() {
  const warehouses = await prisma.warehouse.findMany({ orderBy: { code: "asc" } });
  return Promise.all(warehouses.map(async (w) => withCapacity(w, await capacityForWarehouse(w.id))));
}

// Naya warehouse banata hai -- staff_admin-only (route me requireRole se gate hota hai).
async function createWarehouse({ code, name, address }) {
  const trimmedCode = code.trim();
  const existing = await prisma.warehouse.findUnique({ where: { code: trimmedCode } });
  if (existing) {
    const err = new Error(`Warehouse code "${trimmedCode}" already exists`);
    err.status = 409; // errorMiddleware isi status ko use karke response bhejta hai
    throw err;
  }
  // Naam bhi unique hona chahiye -- case aur extra spaces ignore karke ("north warehouse" == "North  Warehouse").
  const cleanName = String(name).trim().replace(/\s+/g, " ");
  const sameName = await prisma.warehouse.findFirst({
    where: { name: { equals: cleanName, mode: "insensitive" } },
    select: { name: true },
  });
  if (sameName) {
    const err = new Error(`A warehouse named "${sameName.name}" already exists`);
    err.status = 409;
    throw err;
  }
  const warehouse = await prisma.warehouse.create({ data: { code: trimmedCode, name: cleanName, address } });
  return withCapacity(warehouse, { rackCount: 0, slotCount: 0, usedCapacity: 0, totalCapacity: 0 });
}

async function getWarehouseById(id) {
  const warehouse = await prisma.warehouse.findUnique({ where: { id } });
  if (!warehouse) return null;
  return withCapacity(warehouse, await capacityForWarehouse(warehouse.id));
}

// Naya rack banata hai AUR uska grid (rows x columns) auto-generate karta hai -- staff_admin-only.
// Har cell (row x column) khud ek storage location (slot) hai, uske andar koi sub-slot nahi. User har
// cell ki length cm ya feet me deta hai (cellLength + lengthUnit); DB me whole centimetres store hote hain
// aur wahi us cell ki capacity hai. Seed script (src/scripts/seed.js) jaisa hi slot code/barcode convention.
async function createRack(warehouseId, { code, label, rows, columns, cellLength, lengthUnit }) {
  const warehouse = await prisma.warehouse.findUnique({ where: { id: warehouseId } });
  if (!warehouse) throw new Error(`Warehouse ${warehouseId} not found`);

  // Same warehouse ke andar ek jaisa rack code dobara allow nahi -- DB me bhi unique constraint
  // hai (safety net), par ye pehle hi check karke ek clear, specific error deta hai.
  const trimmedCode = code.trim();
  const existingRack = await prisma.rack.findUnique({
    where: { warehouseId_code: { warehouseId, code: trimmedCode } },
  });
  if (existingRack) {
    const err = new Error(`Rack code "${trimmedCode}" already exists in this warehouse`);
    err.status = 409;
    throw err;
  }

  const cellLengthCm = toCentimetres(cellLength, lengthUnit); // galat unit/value par error (controller 400 deta hai)
  const rack = await prisma.$transaction(async (tx) => {
    const created = await tx.rack.create({ data: { warehouseId, code: trimmedCode, label, rows, columns, cellLengthCm } });
    const slots = [];
    for (let row = 1; row <= rows; row++) {
      for (let col = 1; col <= columns; col++) {
        slots.push({
          rackId: created.id,
          warehouseId,
          code: `${row}-${col}`,
          barcode: `SL-${warehouse.code}-${trimmedCode}-${row}-${col}`,
          row,
          column: col,
          capacity: cellLengthCm,
          used: 0,
          status: "available",
        });
      }
    }
    await tx.slot.createMany({ data: slots });
    return created;
  });

  return withCapacity(rack, { usedCapacity: 0, totalCapacity: cellLengthCm * rows * columns });
}

// Rack ki cell length badalta hai: rack.cellLengthCm aur uske SAARE slots ki capacity ek saath update
// (har cell ek hi length ka hai). Agar kisi cell me already utna saaman hai jo nayi length me nahi
// aayega to 409 -- pehle wo boxes hatao. Status (available/full) used/capacity se recompute hota hai,
// blocked cells blocked hi rehte hain.
async function updateRack(rackId, { cellLength, lengthUnit }) {
  const rack = await prisma.rack.findUnique({ where: { id: rackId } });
  if (!rack) return null;
  const cellLengthCm = toCentimetres(cellLength, lengthUnit);

  await prisma.$transaction(async (tx) => {
    const overfull = await tx.slot.findFirst({ where: { rackId, used: { gt: cellLengthCm } }, orderBy: { used: "desc" } });
    if (overfull) {
      const err = new Error(`Slot ${overfull.code} already holds ${overfull.used} cm, which is more than ${cellLengthCm} cm`);
      err.status = 409;
      throw err;
    }
    await tx.rack.update({ where: { id: rackId }, data: { cellLengthCm } });
    await tx.slot.updateMany({ where: { rackId }, data: { capacity: cellLengthCm } });
    // "full" sirf wahi jo ab poora bhar gaya hai; baaki (blocked chhodkar) available.
    await tx.slot.updateMany({ where: { rackId, status: "full", used: { lt: cellLengthCm } }, data: { status: "available" } });
    await tx.slot.updateMany({ where: { rackId, status: "available", used: cellLengthCm } , data: { status: "full" } });
  });

  return getRackById(rackId);
}

async function listRacksForWarehouse(warehouseId) {
  // Ek hi groupBy query saare racks ki capacity ke liye (har rack ke liye alag query nahi -- N+1 se bachne ko).
  const [racks, totals] = await Promise.all([
    prisma.rack.findMany({ where: { warehouseId }, orderBy: { code: "asc" } }),
    prisma.slot.groupBy({ by: ["rackId"], where: { warehouseId }, _sum: { used: true, capacity: true } }),
  ]);
  const byRack = new Map(totals.map((t) => [t.rackId, t._sum]));
  return racks.map((r) =>
    withCapacity(r, { usedCapacity: byRack.get(r.id)?.used || 0, totalCapacity: byRack.get(r.id)?.capacity || 0 })
  );
}

// Per row of a rack: how many boxes are stored and how many of them are on an open order. One SQL
// aggregate (boxes can't be grouped by a related column in Prisma) so the rack page never has to
// download every box just to count them.
async function rackRowStats(rackId) {
  const rows = await prisma.$queryRaw`
    SELECT s."row" AS "row", COUNT(b."id")::int AS "boxCount", COUNT(b."openOrderId")::int AS "onOrderCount"
    FROM "box" b JOIN "slot" s ON s."id" = b."slotId"
    WHERE s."rackId" = ${rackId} AND b."status" <> 'destroyed'
    GROUP BY s."row" ORDER BY s."row"`;
  return rows;
}

async function getRackById(id) {
  const rack = await prisma.rack.findUnique({ where: { id } });
  if (!rack) return null;
  return withCapacity(rack, await capacityForRack(rack.id));
}

async function listSlotsForRack(rackId) {
  const slots = await prisma.slot.findMany({ where: { rackId }, orderBy: [{ row: "asc" }, { column: "asc" }] });
  return slots.map(serializeSimple);
}

// Block karne par used zero ho jaata hai, aur (blocked na ho to) status hamesha used/capacity se
// recompute hota hai, freely set nahi hota.
async function updateSlot(slotId, patch) {
  const slot = await prisma.slot.findUnique({ where: { id: slotId } });
  if (!slot) throw new Error(`Slot ${slotId} not found`);

  let { capacity, used, status } = slot;
  if (typeof patch.capacity === "number") capacity = patch.capacity;
  if (patch.status === "blocked") {
    status = "blocked";
    used = 0; // blocked slot me koi box nahi reh sakta
  }
  if (status !== "blocked") {
    status = used >= capacity ? "full" : "available";
  }

  const updated = await prisma.slot.update({ where: { id: slotId }, data: { capacity, used, status } });
  return serializeSimple(updated);
}

module.exports = {
  listWarehouses,
  createWarehouse,
  getWarehouseById,
  createRack,
  listRacksForWarehouse,
  getRackById,
  updateRack,
  rackRowStats,
  listSlotsForRack,
  updateSlot,
};
