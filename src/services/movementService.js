// Custody / location ledger (movement table). Har physical location change ki ek row -- kabhi update/delete nahi.
// Callers ise usi transaction me likhte hain jisme box ka slot badalta hai, taaki ledger aur box kabhi alag na hon.
const prisma = require("../config/prisma");
const { serializeSimple } = require("../utils/serialize");
const { parsePagination } = require("../utils/pagination");

// `box` = box row jaisa change se PEHLE tha (boxNumber/clientId ke liye). `from`/`to` = { id, warehouseId } slot
// (ya null: box slot me nahi tha / ab nahi hai). Baaki sab optional.
async function appendMovement(box, type, actor, { from, to, fromLocation, toLocation, orderId, orderNumber, reason } = {}, db = prisma) {
  return db.movement.create({
    data: {
      boxId: box.id,
      boxNumber: box.boxNumber,
      clientId: box.clientId,
      type,
      fromSlotId: from?.id,
      fromWarehouseId: from?.warehouseId,
      toSlotId: to?.id,
      toWarehouseId: to?.warehouseId,
      fromLocation: fromLocation ?? undefined,
      toLocation: toLocation ?? undefined,
      orderId: orderId ?? undefined,
      orderNumber: orderNumber ?? undefined,
      reason: reason ?? undefined,
      actor,
      at: new Date(),
    },
  });
}

async function listMovementsForBox(boxId, params = {}) {
  const where = { boxId };
  const { skip, take } = parsePagination(params, 50);
  const [items, total] = await Promise.all([
    prisma.movement.findMany({ where, orderBy: [{ at: "desc" }, { id: "asc" }], skip, take }),
    prisma.movement.count({ where }),
  ]);
  return { items: items.map(serializeSimple), total };
}

module.exports = { appendMovement, listMovementsForBox };
