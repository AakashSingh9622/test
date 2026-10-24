// Box <-> Slot allocation (register, move, dispatch/destroy release). Order service
// (dispatch/destroy) bhi releaseBoxSlot yahin se reuse karta hai.
//
// CONCURRENCY: Slot.used pehle "padho -> hisaab lagao -> likho" tarah update hota tha -- do staff ek hi slot me
// ek saath box rakhte to dono ek hi purani `used` padhte aur ek ka update kho jata (slot over-book ho sakta tha).
// Ab space ek hi atomic SQL UPDATE se reserve/release hota hai (check + update ek saath, row lock ke andar),
// isliye hazaaron parallel requests me bhi slot kabhi capacity se zyada nahi bharta.
const { Prisma } = require("../config/prisma");
const prisma = require("../config/prisma");
const { appendAuditEvent } = require("./auditService");
const { appendMovement } = require("./movementService");
const { serializeBox } = require("../utils/serialize");
const { boxLengthCm } = require("../utils/dimensions");
const { pathFor, RACK_PATH_INCLUDE } = require("../utils/locationPath");
const httpError = require("../utils/httpError");

// Interactive transactions ka default timeout 5s hai -- remote Supabase pooler ke saath
// multi-step flows (dispatch/allocate-batch) ke liye kam padta hai.
const TX_OPTIONS = { maxWait: 10000, timeout: 60000 };

// The length stored on the box when it was registered (admin may change the sizes later; boxes already
// in slots must keep the length they were counted with). Old rows without one use the default.
function unitsFor(box) {
  return box.lengthCm ?? boxLengthCm(box);
}

// Slot ka readable locationPath snapshot banata hai (Box.locationPath me store hota hai) -- warehouse, zone, aisle aur
// rack ek hi query me. Rack ka code jaisa hai waisa (pehle "B04" -> "B-04" banta tha, jo "new1" jaise codes bigaad deta tha).
async function locationPathForSlot(slot, db = prisma) {
  const rack = await db.rack.findUnique({ where: { id: slot.rackId }, include: RACK_PATH_INCLUDE });
  if (!rack) return { warehouse: slot.warehouseId, rack: slot.rackId, slot: slot.code };
  return pathFor(rack, slot);
}

// Slot me `cm` jagah atomically le leta hai. true = mil gayi; false = slot blocked hai ya jagah nahi bachi.
async function reserveSlotSpace(db, slotId, cm) {
  const changed = await db.$executeRaw`
    UPDATE "slot"
    SET "used" = "used" + ${cm},
        "status" = CASE WHEN "used" + ${cm} >= "capacity" THEN 'full'::"SlotStatus" ELSE 'available'::"SlotStatus" END
    WHERE "id" = ${slotId} AND "status"::text IN ('available', 'full') AND "capacity" - "used" >= ${cm}`;
  return changed === 1;
}

// Locked = no new boxes (blocked / quarantined / inactive). Status is compared as TEXT in SQL, not cast to the enum,
// so these statements also run on a database that doesn't have the newer enum values yet.
const LOCKED_SLOT_STATUSES = ["blocked", "quarantined", "inactive"];
const isActiveSlot = (slot) => !LOCKED_SLOT_STATUSES.includes(slot.status);

// Slot ki `cm` jagah atomically wapas karta hai (kabhi 0 se neeche nahi jaata; locked slot locked hi rehta hai).
async function releaseSlotSpace(db, slotId, cm) {
  await db.$executeRaw`
    UPDATE "slot"
    SET "used" = GREATEST("used" - ${cm}, 0),
        "status" = CASE
          WHEN "status"::text IN ('blocked', 'quarantined', 'inactive') THEN "status"
          WHEN GREATEST("used" - ${cm}, 0) >= "capacity" THEN 'full'::"SlotStatus"
          ELSE 'available'::"SlotStatus" END
    WHERE "id" = ${slotId}`;
}

// Box ka slot capacity free karta hai (dispatch/destroy/move ke pehle step). Box row ko
// update NAHI karta -- caller RELEASED_BOX_FIELDS ko apne box update me merge karta hai.
async function releaseBoxSlot(box, db = prisma) {
  if (!box.slotId) return;
  await releaseSlotSpace(db, box.slotId, unitsFor(box));
}

const RELEASED_BOX_FIELDS = { slotId: null, locationPath: Prisma.DbNull };

// Ek ya zyada boxes ko slots me allocate (ya re-allocate, i.e. Move) karta hai -- poora batch
// ek transaction me, taaki beech me fail hone par slot counters aadhe-adhure na rahein.
async function allocateBoxes({ allocations, reason }, actor) {
  return prisma.$transaction(async (tx) => {
    const results = [];

    for (const { boxId, slotId } of allocations) {
      const box = await tx.box.findUnique({ where: { id: boxId } });
      const slot = await tx.slot.findUnique({ where: { id: slotId } });
      if (!box) throw httpError(404, `Box ${boxId} not found`);
      if (!slot) throw httpError(404, `Slot ${slotId} not found`);
      if (box.status === "destroyed") throw httpError(400, `Box ${box.boxNumber} is destroyed`);
      if (box.status === "permanently_withdrawn") throw httpError(400, `Box ${box.boxNumber} was permanently withdrawn by the client`);
      if (box.status === "return_pending") {
        throw httpError(400, `Box ${box.boxNumber} is still with the client — receive it on its collection order first`);
      }
      if (!isActiveSlot(slot)) throw httpError(400, `Slot ${slot.code} is ${slot.status}`);

      const units = unitsFor(box);
      const alreadyHere = box.slotId === slot.id;
      const wasAllocatedElsewhere = !!box.slotId && !alreadyHere;
      const fromGoodsIn = box.status === "received";
      const fromLocation = box.locationPath;
      // Ledger ke liye purani jagah ka warehouse bhi chahiye: move par purana slot, Goods-In se aaye to wo warehouse.
      const fromSlot = wasAllocatedElsewhere
        ? await tx.slot.findUnique({ where: { id: box.slotId }, select: { id: true, warehouseId: true } })
        : fromGoodsIn && box.goodsInWarehouseId
          ? { id: undefined, warehouseId: box.goodsInWarehouseId }
          : null;

      if (!alreadyHere) {
        // Pehle nayi jagah lo (atomic) -- mili tabhi purani chhodo, warna box kahin ka na rahe.
        if (!(await reserveSlotSpace(tx, slot.id, units))) throw httpError(400, `Slot ${slot.code} doesn't have room`);
        if (wasAllocatedElsewhere) await releaseSlotSpace(tx, box.slotId, units);
      }

      const locationPath = await locationPathForSlot(slot, tx);
      // Reserved/picked/quarantined boxes move karne par apna status rakhte hain; unallocated/received/out -> stored.
      // A missing box that is placed in a slot has been found: it becomes stored again.
      const wasMissing = box.status === "missing";
      const comesIntoStorage = ["unallocated", "received", "out"].includes(box.status) || wasMissing;
      // (a box that had been digitized goes back to "digitized")
      const status = comesIntoStorage ? (box.digitizedAt ? "digitized" : "stored") : box.status;
      // Box ko sirf tab badlo jab wo abhi bhi wahi hai jo humne padha tha (kisi aur ne beech me move na kar diya ho).
      const moved = await tx.box.updateMany({
        where: { id: box.id, slotId: box.slotId, status: box.status },
        data: {
          slotId: slot.id,
          locationPath,
          status,
          ...(wasMissing && { missingReason: null, missingAt: null }),
          ...(fromGoodsIn && { goodsInWarehouseId: null }),
        },
      });
      if (moved.count !== 1) throw httpError(409, `Box ${box.boxNumber} was changed by someone else -- please retry`);
      const updated = await tx.box.findUnique({ where: { id: box.id } });

      await appendAuditEvent(
        updated,
        wasAllocatedElsewhere ? "moved" : "allocated",
        actor,
        { fromLocation: wasAllocatedElsewhere ? fromLocation : undefined, toLocation: locationPath, note: wasMissing ? `Found${reason ? " -- " + reason : ""}` : reason },
        tx
      );
      // Box pehle se isi slot me tha to physically kuch nahi hila -- ledger me row nahi.
      if (!alreadyHere) {
        await appendMovement(
          box,
          wasAllocatedElsewhere ? "transfer" : wasMissing ? "found" : "put_away",
          actor,
          { from: fromSlot, to: slot, fromLocation: wasAllocatedElsewhere || fromGoodsIn ? fromLocation : undefined, toLocation: locationPath, reason },
          tx
        );
      }

      results.push(serializeBox(updated));
    }

    return results;
  }, TX_OPTIONS);
}

module.exports = {
  TX_OPTIONS,
  locationPathForSlot,
  reserveSlotSpace,
  releaseSlotSpace,
  releaseBoxSlot,
  RELEASED_BOX_FIELDS,
  LOCKED_SLOT_STATUSES,
  isActiveSlot,
  allocateBoxes,
};
