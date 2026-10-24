// Warehouse -> (Zone -> Aisle, optional) -> Rack -> Slot business logic. rackCount/slotCount/usedCapacity/totalCapacity
// Warehouse aur Rack rows me store NAHI hote (prisma/schema.prisma dekho) -- yahan slot rows
// se on-read aggregate karke attach kiye jaate hain, taaki asli data se kabhi out-of-sync na ho.
const prisma = require("../config/prisma");
const { Prisma } = require("../config/prisma");
const { serializeSimple } = require("../utils/serialize");
const { pathFor } = require("../utils/locationPath");
const { toCentimetres } = require("../utils/dimensions");
const httpError = require("../utils/httpError");
const { appendAdminEvent } = require("./adminAuditService");

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

// Naya warehouse banata hai -- layout.manage (route me requirePermission se gate hota hai).
async function createWarehouse({ code, name, address }, actor) {
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
  const warehouse = await prisma.$transaction(async (tx) => {
    const created = await tx.warehouse.create({ data: { code: trimmedCode, name: cleanName, address } });
    await appendAdminEvent(
      "warehouse_created",
      actor,
      { entityType: "warehouse", entityId: created.id, summary: `Created warehouse ${trimmedCode} — ${cleanName}` },
      tx
    );
    return created;
  });
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
async function createRack(warehouseId, { code, label, rows, columns, cellLength, lengthUnit, zoneId, aisleId }, actor) {
  const warehouse = await prisma.warehouse.findUnique({ where: { id: warehouseId } });
  if (!warehouse) throw new Error(`Warehouse ${warehouseId} not found`);

  // Rack code ab SAARE warehouses me unique (Sprint 10) -- taaki "B04-3" akela hi shelf dhoondh le. DB sirf ek
  // warehouse ke andar enforce karta hai (purane racks me alag warehouses me same code ho sakta hai).
  const trimmedCode = code.trim();
  if (/^\d+$/.test(trimmedCode)) {
    throw httpError(400, "A rack code needs at least one letter (e.g. B04), so B04-3 can't be mistaken for a shelf");
  }
  const existingRack = await prisma.rack.findFirst({
    where: { code: { equals: trimmedCode, mode: "insensitive" } },
    include: { warehouse: { select: { code: true } } },
  });
  if (existingRack) {
    throw httpError(
      409,
      `Rack code "${existingRack.code}" is already used in ${existingRack.warehouse.code} — rack codes must be unique across warehouses`
    );
  }
  const placement = await rackPlacement(warehouseId, { zoneId: zoneId || null, aisleId: aisleId || null });
  const where = await placementText(placement);

  const cellLengthCm = toCentimetres(cellLength, lengthUnit); // galat unit/value par error (controller 400 deta hai)
  const rack = await prisma.$transaction(async (tx) => {
    const created = await tx.rack.create({
      data: { warehouseId, code: trimmedCode, label, rows, columns, cellLengthCm, ...placement },
    });
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
    await appendAdminEvent(
      "rack_created",
      actor,
      {
        entityType: "rack",
        entityId: created.id,
        summary: `Added rack ${trimmedCode} to ${warehouse.code}${where}: ${rows} × ${columns} cells of ${cellLengthCm} cm`,
      },
      tx
    );
    return created;
  });

  return withCapacity(rack, { usedCapacity: 0, totalCapacity: cellLengthCm * rows * columns });
}

// Rack ki cell length / label / zone / aisle badalta hai (jo bheja wahi). Cell length: rack.cellLengthCm aur uske SAARE
// slots ki capacity ek saath update (har cell ek hi length ka hai). Agar kisi cell me already utna saaman hai jo nayi
// length me nahi aayega to 409 -- pehle wo boxes hatao. Status (available/full) used/capacity se recompute hota hai,
// blocked cells blocked hi rehte hain. Zone / aisle badle to rack ke boxes ki stored location bhi (updateRackDetails).
async function updateRack(rackId, { cellLength, lengthUnit, label, zoneId, aisleId }, actor) {
  const rack = await prisma.rack.findUnique({ where: { id: rackId } });
  if (!rack) return null;
  await updateRackDetails(rack, { label, zoneId, aisleId }, actor);
  if (cellLength === undefined) return getRackById(rackId);
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
    if (rack.cellLengthCm !== cellLengthCm) {
      await appendAdminEvent(
        "rack_updated",
        actor,
        {
          entityType: "rack",
          entityId: rackId,
          summary: `Changed cell length of rack ${rack.code} from ${rack.cellLengthCm} cm to ${cellLengthCm} cm`,
          changes: [{ field: "cellLengthCm", from: rack.cellLengthCm, to: cellLengthCm }],
        },
        tx
      );
    }
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
  const rack = await prisma.rack.findUnique({ where: { id }, include: { zone: true, aisle: true } });
  if (!rack) return null;
  const { zone, aisle, ...row } = rack;
  return {
    ...withCapacity(row, await capacityForRack(rack.id)),
    ...(zone && { zone: serializeSimple(zone) }),
    ...(aisle && { aisle: serializeSimple(aisle) }),
  };
}

async function listSlotsForRack(rackId) {
  const slots = await prisma.slot.findMany({ where: { rackId }, orderBy: [{ row: "asc" }, { column: "asc" }] });
  return slots.map(serializeSimple);
}

// Slot states: available / full = ACTIVE (full is worked out from used vs capacity, never set by hand).
// blocked / quarantined / inactive = LOCKED: no new boxes; the boxes already inside stay and keep counting.
// The staff UI sends "available" or "full" to unlock -- both just mean "active again".
const LOCK_STATES = ["blocked", "quarantined", "inactive"];
const SLOT_STATUS_INPUT = [...LOCK_STATES, "available", "full"];

// `used` is NEVER touched here (it used to be zeroed on block, so the cell looked empty). Capacity can't go below what
// is stored. Check + update in one SQL statement, so a box allocated at the same moment can't over-fill the cell.
async function updateSlot(slotId, patch, actor) {
  const slot = await prisma.slot.findUnique({ where: { id: slotId } });
  if (!slot) throw httpError(404, "Slot not found");
  if (patch.status !== undefined && !SLOT_STATUS_INPUT.includes(patch.status)) {
    throw httpError(400, `status must be one of: ${SLOT_STATUS_INPUT.join(", ")}`);
  }
  if (patch.capacity !== undefined && !(Number.isInteger(patch.capacity) && patch.capacity > 0)) {
    throw httpError(400, "capacity must be a positive whole number of centimetres");
  }

  const capacity = patch.capacity ?? slot.capacity;
  const wasLock = LOCK_STATES.includes(slot.status) ? slot.status : null;
  const lock = patch.status === undefined ? wasLock : LOCK_STATES.includes(patch.status) ? patch.status : null;
  const changed = await prisma.$executeRaw`
    UPDATE "slot"
    SET "capacity" = ${capacity},
        "status" = CASE
          WHEN ${lock}::text IS NOT NULL THEN CAST(${lock}::text AS "SlotStatus")
          WHEN "used" >= ${capacity} THEN 'full'::"SlotStatus"
          ELSE 'available'::"SlotStatus" END,
        "updatedAt" = NOW()
    WHERE "id" = ${slotId} AND "used" <= ${capacity}`;
  if (changed !== 1) {
    const current = await prisma.slot.findUnique({ where: { id: slotId } });
    throw httpError(409, `Slot ${slot.code} already holds ${current?.used ?? slot.used} cm, which is more than ${capacity} cm -- move boxes out first`);
  }
  const updated = await prisma.slot.findUnique({ where: { id: slotId } });

  // History me sirf asli badlav (state, capacity) -- available <-> full apne aap hota hai, wo nahi.
  const changes = [];
  const said = [];
  if (wasLock !== lock) {
    changes.push({ field: "state", from: wasLock ?? "active", to: lock ?? "active" });
    said.push(lock ? `set to ${lock}` : `made active again (was ${wasLock})`);
  }
  if (slot.capacity !== updated.capacity) {
    changes.push({ field: "capacity", from: slot.capacity, to: updated.capacity });
    said.push(`changed capacity from ${slot.capacity} cm to ${updated.capacity} cm`);
  }
  if (changes.length) {
    await appendAdminEvent("slot_updated", actor, { entityType: "slot", entityId: slotId, summary: `Slot ${slot.barcode}: ${said.join(", ")}`, changes });
  }
  return serializeSimple(updated);
}

module.exports = {
  listWarehouses,
  createWarehouse,
  getWarehouseById,
  warehouseLayout,
  createZone,
  updateZone,
  deleteZone,
  createAisle,
  updateAisle,
  deleteAisle,
  resolveLocation,
  searchRacks,
  refreshBoxLocations,
  createRack,
  listRacksForWarehouse,
  getRackById,
  updateRack,
  rackRowStats,
  listSlotsForRack,
  updateSlot,
};

// --- Zones and aisles (Sprint 10) -----------------------------------------------------------------------------------
// Optional levels above the rack. Shelf = the rack's row and position = the cell, so slots never change here.

const LAYOUT_TX = { maxWait: 10000, timeout: 60000 };

const cleanCode = (code, what) => {
  const c = String(code ?? "").trim();
  if (!c) throw httpError(400, `${what} code is required`);
  if (c.length > 20) throw httpError(400, `${what} code is at most 20 characters`);
  return c;
};
const cleanName = (name) => (name === undefined ? undefined : String(name ?? "").trim().replace(/\s+/g, " ") || null);

// One call for the browse picker and the warehouse page: zones, aisles and racks (each with capacity totals), flat --
// the browser groups them. Capacity comes from the one grouped slot query in listRacksForWarehouse.
async function warehouseLayout(warehouseId) {
  const [zones, aisles, racks] = await Promise.all([
    prisma.zone.findMany({ where: { warehouseId }, orderBy: { code: "asc" } }),
    prisma.aisle.findMany({ where: { warehouseId }, orderBy: { code: "asc" } }),
    listRacksForWarehouse(warehouseId),
  ]);
  const add = (map, key, rack) => {
    if (!key) return;
    const t = map.get(key) ?? { rackCount: 0, usedCapacity: 0, totalCapacity: 0 };
    t.rackCount += 1;
    t.usedCapacity += rack.usedCapacity;
    t.totalCapacity += rack.totalCapacity;
    map.set(key, t);
  };
  const byZone = new Map();
  const byAisle = new Map();
  for (const r of racks) {
    add(byZone, r.zoneId, r);
    add(byAisle, r.aisleId, r);
  }
  const empty = { rackCount: 0, usedCapacity: 0, totalCapacity: 0 };
  return {
    zones: zones.map((z) => withCapacity(z, byZone.get(z.id) ?? empty)),
    aisles: aisles.map((a) => withCapacity(a, byAisle.get(a.id) ?? empty)),
    racks,
  };
}

async function assertCodeFree(model, warehouseId, code, exceptId, what) {
  const clash = await prisma[model].findFirst({
    where: { warehouseId, code: { equals: code, mode: "insensitive" }, ...(exceptId && { id: { not: exceptId } }) },
  });
  if (clash) throw httpError(409, `${what} "${clash.code}" already exists in this warehouse`);
}

async function getZoneOrThrow(zoneId, warehouseId, db = prisma) {
  const zone = zoneId ? await db.zone.findUnique({ where: { id: zoneId } }) : null;
  if (!zone || (warehouseId && zone.warehouseId !== warehouseId)) throw httpError(404, "Zone not found in this warehouse");
  return zone;
}

async function getAisleOrThrow(aisleId, warehouseId, db = prisma) {
  const aisle = aisleId ? await db.aisle.findUnique({ where: { id: aisleId } }) : null;
  if (!aisle || (warehouseId && aisle.warehouseId !== warehouseId)) throw httpError(404, "Aisle not found in this warehouse");
  return aisle;
}

// Where a rack sits. An aisle decides the zone (its own, or none); a zone alone is fine too.
async function rackPlacement(warehouseId, { zoneId, aisleId }, db = prisma) {
  if (aisleId) {
    const aisle = await getAisleOrThrow(aisleId, warehouseId, db);
    return { zoneId: aisle.zoneId ?? null, aisleId: aisle.id };
  }
  if (zoneId) return { zoneId: (await getZoneOrThrow(zoneId, warehouseId, db)).id, aisleId: null };
  return { zoneId: null, aisleId: null };
}

// " zone A, aisle 3" (or "") -- for the admin log.
async function placementText({ zoneId, aisleId }, db = prisma) {
  const [zone, aisle] = await Promise.all([
    zoneId ? db.zone.findUnique({ where: { id: zoneId } }) : null,
    aisleId ? db.aisle.findUnique({ where: { id: aisleId } }) : null,
  ]);
  return [zone && ` zone ${zone.code}`, aisle && ` aisle ${aisle.code}`].filter(Boolean).join(",");
}

// Rewrites the CURRENT location of the boxes on the racks matching `rackFilter` (raw SQL on rack "r") from the live
// layout -- after a zone / aisle / rack change, so a box shows where it really is. History (audit, movements, order
// lines) is never touched. One statement, however many boxes.
async function refreshBoxLocations(rackFilter, db = prisma) {
  return db.$executeRaw`
    UPDATE "box" b
    SET "locationPath" = jsonb_strip_nulls(jsonb_build_object(
      'warehouse', w."code", 'zone', z."code", 'aisle', a."code", 'rack', r."code",
      'slot', s."code", 'shelf', s."row", 'position', s."column"))
    FROM "slot" s
      JOIN "rack" r ON r."id" = s."rackId"
      JOIN "warehouse" w ON w."id" = r."warehouseId"
      LEFT JOIN "zone" z ON z."id" = r."zoneId"
      LEFT JOIN "aisle" a ON a."id" = r."aisleId"
    WHERE s."id" = b."slotId" AND ${rackFilter}`;
}

// Label and / or zone + aisle of a rack. Only the zone sent: the rack keeps its aisle if that aisle is in the zone.
async function updateRackDetails(rack, { label, zoneId, aisleId }, actor) {
  const changes = [];
  const said = [];
  const data = {};
  if (label !== undefined) {
    const clean = String(label ?? "").trim();
    if (!clean) throw httpError(400, "label can't be empty");
    if (clean !== rack.label) {
      data.label = clean;
      changes.push({ field: "label", from: rack.label, to: clean });
      said.push(`label "${rack.label}" → "${clean}"`);
    }
  }
  let placement = null;
  if (zoneId !== undefined || aisleId !== undefined) {
    let nextAisle = aisleId !== undefined ? aisleId || null : rack.aisleId;
    if (aisleId === undefined && nextAisle) {
      const current = await prisma.aisle.findUnique({ where: { id: nextAisle } });
      if ((current?.zoneId ?? null) !== (zoneId || null)) nextAisle = null;
    }
    placement = await rackPlacement(rack.warehouseId, {
      zoneId: zoneId === undefined ? rack.zoneId : zoneId || null,
      aisleId: nextAisle,
    });
    if (placement.zoneId === rack.zoneId && placement.aisleId === rack.aisleId) placement = null;
  }
  if (!changes.length && !placement) return;
  await prisma.$transaction(async (tx) => {
    if (placement) {
      Object.assign(data, placement);
      const before = (await placementText(rack, tx)).trim() || "no zone / aisle";
      const after = (await placementText(placement, tx)).trim() || "no zone / aisle";
      changes.push({ field: "placement", from: before, to: after });
      said.push(`moved from ${before} to ${after}`);
    }
    await tx.rack.update({ where: { id: rack.id }, data });
    if (placement) await refreshBoxLocations(Prisma.sql`r."id" = ${rack.id}`, tx);
    await appendAdminEvent(
      "rack_updated",
      actor,
      { entityType: "rack", entityId: rack.id, summary: `Rack ${rack.code}: ${said.join(", ")}`, changes },
      tx
    );
  }, LAYOUT_TX);
}

const changeText = (changes) => changes.map((c) => `${c.field} "${c.from ?? ""}" → "${c.to ?? ""}"`).join(", ");

async function createZone(warehouseId, { code, name }, actor) {
  const warehouse = await prisma.warehouse.findUnique({ where: { id: warehouseId } });
  if (!warehouse) throw httpError(404, "Warehouse not found");
  const c = cleanCode(code, "Zone");
  await assertCodeFree("zone", warehouseId, c, null, "Zone");
  return prisma.$transaction(async (tx) => {
    const zone = await tx.zone.create({ data: { warehouseId, code: c, name: cleanName(name) ?? null } });
    await appendAdminEvent(
      "zone_created",
      actor,
      { entityType: "zone", entityId: zone.id, summary: `Added zone ${c} to ${warehouse.code}${zone.name ? ` — ${zone.name}` : ""}` },
      tx
    );
    return serializeSimple(zone);
  });
}

async function updateZone(zoneId, { code, name }, actor) {
  const zone = await getZoneOrThrow(zoneId);
  const data = {};
  if (code !== undefined) {
    const c = cleanCode(code, "Zone");
    if (c !== zone.code) {
      await assertCodeFree("zone", zone.warehouseId, c, zone.id, "Zone");
      data.code = c;
    }
  }
  if (name !== undefined && cleanName(name) !== zone.name) data.name = cleanName(name);
  if (!Object.keys(data).length) return serializeSimple(zone);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.zone.update({ where: { id: zone.id }, data });
    if (data.code) await refreshBoxLocations(Prisma.sql`r."zoneId" = ${zone.id}`, tx);
    const changes = Object.keys(data).map((field) => ({ field, from: zone[field], to: updated[field] }));
    await appendAdminEvent(
      "zone_updated",
      actor,
      { entityType: "zone", entityId: zone.id, summary: `Zone ${zone.code}: ${changeText(changes)}`, changes },
      tx
    );
    return serializeSimple(updated);
  }, LAYOUT_TX);
}

async function deleteZone(zoneId, actor) {
  const zone = await getZoneOrThrow(zoneId);
  const [racks, aisles] = await Promise.all([
    prisma.rack.count({ where: { zoneId } }),
    prisma.aisle.count({ where: { zoneId } }),
  ]);
  if (racks || aisles) {
    const what = [racks && `${racks} rack${racks === 1 ? "" : "s"}`, aisles && `${aisles} aisle${aisles === 1 ? "" : "s"}`]
      .filter(Boolean)
      .join(" and ");
    throw httpError(409, `Zone ${zone.code} still has ${what} — move them out first`);
  }
  await prisma.$transaction(async (tx) => {
    await tx.zone.delete({ where: { id: zone.id } });
    await appendAdminEvent("zone_deleted", actor, { entityType: "zone", entityId: zone.id, summary: `Removed zone ${zone.code}` }, tx);
  });
}

async function createAisle(warehouseId, { code, name, zoneId }, actor) {
  const warehouse = await prisma.warehouse.findUnique({ where: { id: warehouseId } });
  if (!warehouse) throw httpError(404, "Warehouse not found");
  const c = cleanCode(code, "Aisle");
  await assertCodeFree("aisle", warehouseId, c, null, "Aisle");
  const zone = zoneId ? await getZoneOrThrow(zoneId, warehouseId) : null;
  return prisma.$transaction(async (tx) => {
    const aisle = await tx.aisle.create({
      data: { warehouseId, zoneId: zone?.id ?? null, code: c, name: cleanName(name) ?? null },
    });
    await appendAdminEvent(
      "aisle_created",
      actor,
      { entityType: "aisle", entityId: aisle.id, summary: `Added aisle ${c} to ${warehouse.code}${zone ? ` zone ${zone.code}` : ""}` },
      tx
    );
    return serializeSimple(aisle);
  });
}

// Moving an aisle to another zone takes its racks with it (a rack in an aisle always carries the aisle's zone).
async function updateAisle(aisleId, { code, name, zoneId }, actor) {
  const aisle = await getAisleOrThrow(aisleId);
  const data = {};
  if (code !== undefined) {
    const c = cleanCode(code, "Aisle");
    if (c !== aisle.code) {
      await assertCodeFree("aisle", aisle.warehouseId, c, aisle.id, "Aisle");
      data.code = c;
    }
  }
  if (name !== undefined && cleanName(name) !== aisle.name) data.name = cleanName(name);
  if (zoneId !== undefined && (zoneId || null) !== aisle.zoneId) {
    data.zoneId = zoneId ? (await getZoneOrThrow(zoneId, aisle.warehouseId)).id : null;
  }
  if (!Object.keys(data).length) return serializeSimple(aisle);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.aisle.update({ where: { id: aisle.id }, data });
    if ("zoneId" in data) await tx.rack.updateMany({ where: { aisleId: aisle.id }, data: { zoneId: data.zoneId } });
    if (data.code || "zoneId" in data) await refreshBoxLocations(Prisma.sql`r."aisleId" = ${aisle.id}`, tx);
    const zoneCode = async (id) => (id ? (await tx.zone.findUnique({ where: { id } }))?.code : "none");
    const changes = [];
    for (const field of Object.keys(data)) {
      changes.push(
        field === "zoneId"
          ? { field: "zone", from: await zoneCode(aisle.zoneId), to: await zoneCode(updated.zoneId) }
          : { field, from: aisle[field], to: updated[field] }
      );
    }
    await appendAdminEvent(
      "aisle_updated",
      actor,
      { entityType: "aisle", entityId: aisle.id, summary: `Aisle ${aisle.code}: ${changeText(changes)}`, changes },
      tx
    );
    return serializeSimple(updated);
  }, LAYOUT_TX);
}

async function deleteAisle(aisleId, actor) {
  const aisle = await getAisleOrThrow(aisleId);
  const racks = await prisma.rack.count({ where: { aisleId } });
  if (racks) throw httpError(409, `Aisle ${aisle.code} still has ${racks} rack${racks === 1 ? "" : "s"} — move them out first`);
  await prisma.$transaction(async (tx) => {
    await tx.aisle.delete({ where: { id: aisle.id } });
    await appendAdminEvent("aisle_deleted", actor, { entityType: "aisle", entityId: aisle.id, summary: `Removed aisle ${aisle.code}` }, tx);
  });
}

// --- Find a location by typing / scanning its code -------------------------------------------------------------------
// "SL-WH1-B04-3-2" (a position's barcode), "B04-3-2" (rack B04, shelf 3, position 2), "B04-3" (shelf: the app picks
// the best-fitting position), "B04" (just the rack). The rack part is the rack's CODE or its NAME (label, what the
// dropdowns show — "Rack A-01 3" works too). Numbers are read from the right, split by "-", space, "/" or ".", so
// rack codes / names with dashes still resolve. Several racks match (a code in two warehouses, or a repeated name) ->
// "ambiguous" with the choices, never a guess; the UI asks again with the chosen rackId.

const ACTIVE_SLOT = ["available", "full"];

// Smallest free space that still takes `needCm` (fills gaps first, like the suggestions); null if none fits.
function bestFit(slots, needCm) {
  const need = Math.max(Number(needCm) || 0, 1);
  const fits = slots.filter((s) => ACTIVE_SLOT.includes(s.status) && s.capacity - s.used >= need);
  fits.sort((a, b) => a.capacity - a.used - (b.capacity - b.used) || a.column - b.column);
  return fits[0] ?? null;
}

const RACK_FULL_INCLUDE = { warehouse: true, zone: true, aisle: true };

function resolved(kind, code, rack, { shelf = null, positions = [], suggested = null } = {}) {
  const { warehouse, zone, aisle, ...rackRow } = rack;
  const slot = kind === "position" ? positions[0] : suggested;
  return {
    kind,
    code,
    warehouse: { id: warehouse.id, code: warehouse.code, name: warehouse.name },
    zone: zone ? serializeSimple(zone) : null,
    aisle: aisle ? serializeSimple(aisle) : null,
    rack: serializeSimple(rackRow),
    shelf,
    positions: positions.map(serializeSimple),
    suggestedSlotId: suggested?.id ?? null,
    locationPath: slot ? pathFor(rack, slot) : null,
  };
}

const RACK_SEARCH_INCLUDE = { warehouse: { select: { id: true, code: true, name: true } }, zone: true, aisle: true };

// Racks whose code or name is exactly `text` (ignoring case and extra spaces): codes first, names only if no code matched.
async function racksNamed(text, { warehouseId, rackId } = {}) {
  const scope = { ...(warehouseId && { warehouseId }), ...(rackId && { id: rackId }) };
  const byCode = await prisma.rack.findMany({
    where: { code: { equals: text, mode: "insensitive" }, ...scope },
    include: RACK_FULL_INCLUDE,
    orderBy: { warehouse: { code: "asc" } },
  });
  if (byCode.length) return byCode;
  const clean = text.replace(/\s+/g, " ");
  return prisma.rack.findMany({
    where: { label: { equals: clean, mode: "insensitive" }, ...scope },
    include: RACK_FULL_INCLUDE,
    orderBy: [{ warehouse: { code: "asc" } }, { code: "asc" }],
  });
}

const rackChoice = (r) => ({
  rackId: r.id,
  rackCode: r.code,
  rackLabel: r.label,
  warehouseId: r.warehouseId,
  warehouseCode: r.warehouse.code,
  warehouseName: r.warehouse.name,
  zone: r.zone?.code,
  aisle: r.aisle?.code,
});

// The rack part of what was typed: "Rack A-01 3-2" -> "Rack A-01" (for search-as-you-type).
function rackPart(text) {
  return text.replace(/([\s\-/.]+\d+){1,2}$/, "").trim() || text;
}

// Search-as-you-type for the "find a location" box: racks whose code or name contains the text (up to 8).
async function searchRacks(rawQuery, { warehouseId } = {}) {
  const q = String(rawQuery ?? "").trim();
  if (!q) return [];
  const term = rackPart(q);
  const racks = await prisma.rack.findMany({
    where: {
      OR: [{ code: { contains: term, mode: "insensitive" } }, { label: { contains: term, mode: "insensitive" } }],
      ...(warehouseId && { warehouseId }),
    },
    include: RACK_SEARCH_INCLUDE,
    orderBy: [{ code: "asc" }],
    take: 8,
  });
  return racks.map((r) => ({ ...rackChoice(r), rows: r.rows, columns: r.columns }));
}

async function resolveLocation(rawCode, { warehouseId, rackId, needCm } = {}) {
  const code = String(rawCode ?? "").trim();
  if (!code) throw httpError(400, "Type or scan a location code");

  const bySlot =
    (await prisma.slot.findUnique({ where: { barcode: code } })) ??
    (await prisma.slot.findFirst({ where: { barcode: { equals: code, mode: "insensitive" } } }));
  if (bySlot && (!warehouseId || bySlot.warehouseId === warehouseId)) {
    const rack = await prisma.rack.findUnique({ where: { id: bySlot.rackId }, include: RACK_FULL_INCLUDE });
    return resolved("position", code, rack, { shelf: bySlot.row, positions: [bySlot], suggested: bestFit([bySlot], needCm) });
  }

  const tries = [];
  const two = code.match(/^(.*?)[\s\-/.]+(\d+)[\s\-/.]+(\d+)$/);
  if (two && two[1].trim()) tries.push({ rackCode: two[1].trim(), row: Number(two[2]), column: Number(two[3]) });
  const one = code.match(/^(.*?)[\s\-/.]+(\d+)$/);
  if (one && one[1].trim()) tries.push({ rackCode: one[1].trim(), row: Number(one[2]) });
  tries.push({ rackCode: code });

  for (const t of tries) {
    const racks = await racksNamed(t.rackCode, { warehouseId, rackId });
    if (!racks.length) continue;
    if (racks.length > 1) {
      const sameCode = racks.every((r) => r.code.toLowerCase() === racks[0].code.toLowerCase());
      return {
        kind: "ambiguous",
        code,
        message: sameCode
          ? `Rack ${racks[0].code} is in more than one warehouse — choose one`
          : `${racks.length} racks are called "${racks[0].label}" — choose one`,
        choices: racks.map(rackChoice),
      };
    }
    const rack = racks[0];
    if (t.row === undefined) return resolved("rack", code, rack);
    if (t.row < 1 || t.row > rack.rows) {
      return { kind: "not_found", code, message: `Rack ${rack.code} has shelves 1–${rack.rows}`, suggestions: [] };
    }
    if (t.column !== undefined) {
      const slot = await prisma.slot.findFirst({ where: { rackId: rack.id, row: t.row, column: t.column } });
      if (!slot) {
        return { kind: "not_found", code, message: `Shelf ${t.row} of rack ${rack.code} has positions 1–${rack.columns}`, suggestions: [] };
      }
      return resolved("position", code, rack, { shelf: t.row, positions: [slot], suggested: bestFit([slot], needCm) });
    }
    const shelf = await prisma.slot.findMany({ where: { rackId: rack.id, row: t.row }, orderBy: { column: "asc" } });
    return resolved("shelf", code, rack, { shelf: t.row, positions: shelf, suggested: bestFit(shelf, needCm) });
  }

  // Nothing matched: racks whose code or name contains (the start of) what was typed.
  let similar = await searchRacks(code, { warehouseId });
  if (!similar.length) similar = await searchRacks(rackPart(code).slice(0, 3), { warehouseId });
  return {
    kind: "not_found",
    code,
    message: `No rack, shelf or position matches "${code}"`,
    suggestions: [...new Set(similar.map((r) => r.rackCode))].slice(0, 5),
  };
}
