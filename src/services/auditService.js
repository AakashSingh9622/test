// Box history ka event log. Events kabhi update/delete nahi hote, sirf insert.
const prisma = require("../config/prisma");
const { serializeAuditEvent } = require("../utils/serialize");
const { parsePagination } = require("../utils/pagination");

// Spec §5: har event type ka fixed visibility -- kaunse events client ko (portal me) dikhte hain.
const VISIBLE_TO_CLIENT = {
  registered: true,
  added_to_order: true,
  dispatched: true,
  collected: true,
  received: true,
  destruction_authorised: true,
  destroyed: true,
  digitization_authorised: true,
  digitized: true,
};

// Box ke liye ek naya audit event likhta hai. `extra` me orderId/orderNumber/fromLocation/
// toLocation/changes/note aa sakte hain (sab optional, event type ke hisaab se). `db` me
// transaction client pass karo taaki event usi transaction ka hissa bane.
async function appendAuditEvent(box, type, actor, extra = {}, db = prisma) {
  return db.auditEvent.create({
    data: {
      boxId: box.id,
      boxNumber: box.boxNumber,
      clientId: box.clientId,
      type,
      at: new Date(),
      actor,
      visibleToClient: VISIBLE_TO_CLIENT[type] || false,
      orderId: extra.orderId ?? undefined,
      orderNumber: extra.orderNumber ?? undefined,
      fromLocation: extra.fromLocation ?? undefined,
      toLocation: extra.toLocation ?? undefined,
      changes: extra.changes ?? undefined,
      note: extra.note ?? undefined,
    },
  });
}

async function searchAuditEvents(params) {
  const where = {};
  if (params.boxId) where.boxId = params.boxId;
  if (params.clientId) where.clientId = params.clientId;
  if (params.orderId) where.orderId = params.orderId;
  if (params.type) where.type = params.type;
  if (params.visibleToClientOnly) where.visibleToClient = true;

  const { skip, take } = parsePagination(params, 50);

  const [items, total] = await Promise.all([
    prisma.auditEvent.findMany({
      where,
      orderBy: [{ at: "desc" }, { id: "asc" }],
      skip,
      take,
    }),
    prisma.auditEvent.count({ where }),
  ]);

  return { items: items.map(serializeAuditEvent), total };
}

module.exports = { VISIBLE_TO_CLIENT, appendAuditEvent, searchAuditEvents };
