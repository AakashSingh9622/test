// Client-side (portal) business logic. Har function pehle argument me `ctx` leta hai = req.portal (token se aaya):
//   { clientId, email, isMainContact, ... }  -- kabhi request input se nahi.
//
// Rules (user ke flow ke hisaab se):
//   * BOXES  -- client ke saare boxes us client ke saare contacts ko dikhte hain (client ki inventory).
//   * ORDERS -- normal contact (client_user) sirf wahi orders dekhta hai jo uski email par bane;
//               main contact (client_admin) us client ke SAARE orders dekhta hai.
//   * Doosre client ki cheez maangne par 404 (403 nahi), taaki pata hi na chale ki wo maujood hai.
const { Prisma } = require("../config/prisma");
const prisma = require("../config/prisma");
const orderService = require("./orderService");
const { visibleToContactWhere } = orderService;
const { parsePagination } = require("../utils/pagination");
const { toDate } = require("../utils/serialize");
const { portalBox, portalOrder, portalOrderLine, portalAuditEvent } = require("../utils/portalSerialize");
const httpError = require("../utils/httpError");
const certificates = require("./certificateService");
const notifications = require("./notificationService");
const { listContents } = require("./boxContentService");
const orderBilling = require("./orderBillingService");

const OPEN_ORDER_STATUSES = ["requested", "approved", "billing", "scheduled", "in_progress", "ready", "on_hold"];
const BOX_STATUSES = [
  "unallocated", "stored", "reserved", "picked", "out", "pending_destruction", "destroyed", "missing", "digitized",
  "received", "return_pending", "quarantined", "permanently_withdrawn",
];
const ORDER_STATUSES = ["requested", "approved", "billing", "scheduled", "in_progress", "ready", "on_hold", "completed", "cancelled", "rejected"];
const ORDER_TYPES = ["collection", "dispatch", "destruction", "digitize"];
const MAX_BOXES_PER_ORDER = 500;
const DESTRUCTION_METHODS = ["shred", "pulp", "incinerate"];

// Orders whose invoice is in Sage and not paid yet (billing stage) -- the customer can pay by card on the order page.
// (also "acknowledge" -- payment not required -- so the client sees every invoice that's waiting for them)
const AWAITING_PAYMENT = {
  status: "billing",
  AND: [
    {
      OR: [
        { billing: { path: ["status"], equals: orderBilling.BILLING.awaitingPayment } },
        { billing: { path: ["status"], equals: orderBilling.BILLING.awaitingAcknowledgement } },
      ],
    },
  ],
};

// Orders that need the client's sign-off and have not got it yet: destruction (method + name) and digitize (name + note).
const WAITING_FOR_AUTHORISATION = {
  OR: [
    { type: "destruction", destruction: { equals: Prisma.DbNull } },
    { type: "digitize", digitization: { equals: Prisma.DbNull } },
  ],
};

const ownOrders = (ctx) =>
  visibleToContactWhere({ clientId: ctx.clientId, contactEmail: ctx.email, isMainContact: ctx.isMainContact });

const actorOf = (ctx) => ({ id: ctx.email, name: ctx.name || ctx.email, side: "client" });

const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// --- Summary (dashboard) ---------------------------------------------------------------------------------------

async function summary(ctx) {
  const where = ownOrders(ctx);
  const [boxGroups, orderGroups, needsAuthorisation, awaitingPayment, warehouses, recent] = await Promise.all([
    prisma.box.groupBy({ by: ["status"], where: { clientId: ctx.clientId }, _count: { _all: true } }),
    prisma.order.groupBy({ by: ["status"], where, _count: { _all: true } }),
    prisma.order.count({
      where: { ...where, ...WAITING_FOR_AUTHORISATION, status: { in: OPEN_ORDER_STATUSES } },
    }),
    prisma.order.count({ where: { ...where, ...AWAITING_PAYMENT } }),
    prisma.$queryRaw`
      SELECT w."code" AS "code", w."name" AS "name", COUNT(b."id")::int AS "boxes"
      FROM "box" b
      JOIN "slot" s ON s."id" = b."slotId"
      JOIN "warehouse" w ON w."id" = s."warehouseId"
      WHERE b."clientId" = ${ctx.clientId} AND b."status" <> 'destroyed'::"BoxStatus"
      GROUP BY w."code", w."name" ORDER BY w."name"`,
    prisma.order.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 5 }),
  ]);

  const byStatus = Object.fromEntries(BOX_STATUSES.map((s) => [s, 0]));
  for (const g of boxGroups) byStatus[g.status] = g._count._all;
  const orderByStatus = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0]));
  for (const g of orderGroups) orderByStatus[g.status] = g._count._all;

  return {
    boxes: {
      total: Object.values(byStatus).reduce((a, b) => a + b, 0),
      byStatus,
      // Plain-language groups for the dashboard cards.
      inStorage:
        byStatus.stored + byStatus.reserved + byStatus.picked + byStatus.unallocated + byStatus.digitized +
        byStatus.received + byStatus.quarantined,
      outWithYou: byStatus.out + byStatus.return_pending, // still with the client until we receive it back
      permanentlyWithdrawn: byStatus.permanently_withdrawn,
      pendingDestruction: byStatus.pending_destruction,
      destroyed: byStatus.destroyed,
    },
    orders: {
      open: OPEN_ORDER_STATUSES.reduce((sum, s) => sum + orderByStatus[s], 0),
      byStatus: orderByStatus,
      needsAuthorisation, // destruction / digitize orders waiting for the client's authorisation
      awaitingPayment, // orders whose invoice is waiting to be paid (billing stage)
      needsMyApproval: ctx.isMainContact
        ? await prisma.order.count({ where: { clientId: ctx.clientId, clientApprovalRequired: true, clientApprovedAt: null, status: "requested" } })
        : 0,
    },
    warehouses,
    recentOrders: recent.map(portalOrder),
  };
}

// --- Boxes ---------------------------------------------------------------------------------------------------

const BOX_INCLUDE = { slot: { select: { warehouse: { select: { code: true, name: true } } } } };

// Boxes ka openOrder sirf tab dikhao jab wo order is contact ka ho (ya main contact ho) -- doosre contact ke order ka
// number nahi leak hona chahiye.
async function visibleOrderIds(ctx, orderIds) {
  const ids = [...new Set(orderIds.filter(Boolean))];
  if (ctx.isMainContact) return new Set(ids);
  if (ids.length === 0) return new Set();
  const own = await prisma.order.findMany({ where: { id: { in: ids }, ...ownOrders(ctx) }, select: { id: true } });
  return new Set(own.map((o) => o.id));
}

async function listBoxes(ctx, q = {}) {
  const where = { clientId: ctx.clientId };
  const statuses = asArray(q.status).filter((s) => BOX_STATUSES.includes(s));
  if (statuses.length) where.status = { in: statuses };
  else if (q.includeDestroyed !== "true") where.status = { not: "destroyed" };
  if (q.q) {
    const contains = { contains: String(q.q).slice(0, 100), mode: "insensitive" };
    where.OR = [{ boxNumber: contains }, { barcode: contains }, { description: contains }, { reference: contains }, { department: contains }];
  }
  const { skip, take } = parsePagination(q);
  const [items, total] = await Promise.all([
    prisma.box.findMany({ where, include: BOX_INCLUDE, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip, take }),
    prisma.box.count({ where }),
  ]);
  const visible = await visibleOrderIds(ctx, items.map((b) => b.openOrderId));
  return { items: items.map((b) => portalBox(b, { showOrder: visible.has(b.openOrderId) })), total };
}

async function findOwnBox(ctx, boxId) {
  const box = await prisma.box.findFirst({ where: { id: String(boxId), clientId: ctx.clientId }, include: BOX_INCLUDE });
  if (!box) throw httpError(404, "Box not found");
  return box;
}

async function getBox(ctx, boxId) {
  const box = await findOwnBox(ctx, boxId);
  const visible = await visibleOrderIds(ctx, [box.openOrderId]);
  const contents = (await listContents(box.id)).map(({ description, reference, dateFrom, dateTo, docusoftDocumentId }) => ({
    description,
    reference,
    dateFrom,
    dateTo,
    docusoftDocumentId,
  }));
  return { ...portalBox(box, { showOrder: visible.has(box.openOrderId) }), contents };
}

// Client-facing history: sirf visibleToClient events, bina staff ke naam / rack / slot ke. Normal contact ko doosre
// contacts ke orders wale events nahi dikhte.
async function boxHistory(ctx, boxId, q = {}) {
  await findOwnBox(ctx, boxId);
  const where = { boxId: String(boxId), visibleToClient: true };
  if (!ctx.isMainContact) {
    where.OR = [{ orderId: null }, { order: { is: { contactEmail: { equals: ctx.email, mode: "insensitive" } } } }];
  }
  const { skip, take } = parsePagination(q, 50);
  const [items, total] = await Promise.all([
    prisma.auditEvent.findMany({ where, orderBy: [{ at: "desc" }, { id: "asc" }], skip, take }),
    prisma.auditEvent.count({ where }),
  ]);
  return { items: items.map(portalAuditEvent), total };
}

// --- Orders --------------------------------------------------------------------------------------------------

async function listOrders(ctx, q = {}) {
  const where = { ...ownOrders(ctx) };
  if (ORDER_TYPES.includes(q.type)) where.type = q.type;
  const statuses = asArray(q.status).filter((s) => ORDER_STATUSES.includes(s));
  if (statuses.length) where.status = { in: statuses };
  if (q.q) where.orderNumber = { contains: String(q.q).slice(0, 50), mode: "insensitive" };
  // "Needs your action": destruction / digitize orders still waiting for the client's authorisation.
  if (q.needsAuthorisation === "true") {
    Object.assign(where, WAITING_FOR_AUTHORISATION);
    delete where.type;
    where.status = { in: OPEN_ORDER_STATUSES };
  }
  // "To pay": orders at the billing stage whose invoice is in Sage and not paid yet.
  if (q.awaitingPayment === "true") {
    delete where.status;
    Object.assign(where, AWAITING_PAYMENT);
  }
  // "Needs your approval" (main contact): destruction requests from the client's other contacts.
  if (q.needsMyApproval === "true") {
    if (!ctx.isMainContact) return { items: [], total: 0 };
    Object.assign(where, { clientApprovalRequired: true, clientApprovedAt: null, status: "requested" });
  }
  const { skip, take } = parsePagination(q);
  const [items, total] = await Promise.all([
    prisma.order.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip, take }),
    prisma.order.count({ where }),
  ]);
  return { items: items.map(portalOrder), total };
}

async function findOwnOrder(ctx, orderId) {
  const order = await prisma.order.findFirst({ where: { id: String(orderId), ...ownOrders(ctx) } });
  if (!order) throw httpError(404, "Order not found");
  return order;
}

async function getOrder(ctx, orderId) {
  return portalOrder(await findOwnOrder(ctx, orderId));
}

async function orderLines(ctx, orderId) {
  await findOwnOrder(ctx, orderId);
  const lines = await prisma.orderLine.findMany({
    where: { orderId: String(orderId) },
    include: { box: { select: { description: true } } },
    orderBy: { createdAt: "asc" },
  });
  return lines.map(portalOrderLine);
}

function clean(value, max) {
  return value === undefined || value === null ? "" : String(value).trim().slice(0, max);
}

// Client order request: hamesha "requested" (staff approve karega), us client + us contact ke naam par.
async function createOrder(ctx, body = {}) {
  const type = body.type;
  if (!ORDER_TYPES.includes(type)) throw httpError(400, "type must be collection, dispatch, destruction or digitize");

  const boxIds = [...new Set(asArray(body.boxIds).map(String))];
  if (boxIds.length > MAX_BOXES_PER_ORDER) throw httpError(400, `At most ${MAX_BOXES_PER_ORDER} boxes per order`);
  const address = clean(body.address, 500);
  const expectedNewBoxes = body.expectedNewBoxes === undefined ? 0 : Number(body.expectedNewBoxes);
  if (!Number.isInteger(expectedNewBoxes) || expectedNewBoxes < 0 || expectedNewBoxes > 10000) {
    throw httpError(400, "expectedNewBoxes must be a whole number between 0 and 10000");
  }
  const scheduledFor = body.scheduledFor ? toDate(body.scheduledFor) : undefined;
  if (scheduledFor && Number.isNaN(scheduledFor.getTime())) throw httpError(400, "scheduledFor is not a valid date");

  if (type === "collection") {
    if (!address) throw httpError(400, "address is required for a collection");
    if (expectedNewBoxes === 0 && boxIds.length === 0) {
      throw httpError(400, "Tell us how many new boxes to collect, or pick the boxes being returned");
    }
  } else if (boxIds.length === 0) {
    throw httpError(400, "Pick at least one box");
  }

  let destructionAuthorisation;
  if (type === "destruction") {
    const a = body.destructionAuthorisation || {};
    // The client ticks "I authorise the destruction of these N boxes" and types their name (spec §4).
    if (!clean(a.name, 200)) throw httpError(400, "Type your name to authorise the destruction");
    const method = a.method || "shred";
    if (!DESTRUCTION_METHODS.includes(method)) throw httpError(400, "method must be shred, pulp or incinerate");
    destructionAuthorisation = { name: clean(a.name, 200), method };
  }

  // clientName: token me aaya ho to wahi, warna client ke kisi box se, warna id.
  let clientName = ctx.clientName;
  if (!clientName) {
    const known = await prisma.box.findFirst({ where: { clientId: ctx.clientId }, orderBy: { createdAt: "desc" }, select: { clientName: true } });
    clientName = known?.clientName || ctx.clientId;
  }

  let digitizationAuthorisation;
  if (type === "digitize") {
    const a = body.digitizationAuthorisation || {};
    // The client types their name (and may add a note) to authorise digitising these boxes.
    if (!clean(a.name, 200)) throw httpError(400, "Type your name to authorise the digitising");
    digitizationAuthorisation = { name: clean(a.name, 200), note: clean(a.note, 1000) || undefined };
  }

  return portalOrder(
    await orderService.createOrder(
      {
        type,
        clientId: ctx.clientId,
        clientName,
        boxIds,
        expectedNewBoxes: type === "collection" ? expectedNewBoxes : undefined,
        address: address || undefined,
        contactName: ctx.name || ctx.email,
        contactEmail: ctx.email,
        contactPhone: clean(body.contactPhone, 50) || undefined,
        scheduledFor: scheduledFor ? scheduledFor.toISOString().slice(0, 10) : undefined,
        notes: clean(body.notes, 2000) || undefined,
        requestedVia: "portal",
        // decided 24 Oct: destruction asked for by an ordinary contact needs the main contact's approval first
        clientApprovalRequired: type === "destruction" && !ctx.isMainContact,
        destructionAuthorisation,
        digitizationAuthorisation,
      },
      actorOf(ctx)
    )
  );
}

// Client sirf tab cancel kar sakta hai jab order abhi "requested" ho (staff ne approve nahi kiya).
async function cancelOrder(ctx, orderId, reason) {
  const order = await findOwnOrder(ctx, orderId);
  if (order.status !== "requested") {
    throw httpError(409, "Only orders that are still waiting for approval can be cancelled");
  }
  return portalOrder(await orderService.cancelOrder(order.id, clean(reason, 500) || "Cancelled by the client", actorOf(ctx)));
}

// Staff ne destruction order bana diya par authorisation client se leni hai -> client yahan karta hai.
async function authoriseDestruction(ctx, orderId, body = {}) {
  const order = await findOwnOrder(ctx, orderId);
  if (order.type !== "destruction") throw httpError(400, "Only destruction orders need authorisation");
  if (!OPEN_ORDER_STATUSES.includes(order.status)) throw httpError(409, "This order is closed");
  if (order.destruction) throw httpError(409, "This order is already authorised");
  const name = clean(body.name, 200);
  if (!name) throw httpError(400, "Type your name to authorise the destruction");
  const method = body.method || "shred";
  if (!DESTRUCTION_METHODS.includes(method)) throw httpError(400, "method must be shred, pulp or incinerate");
  return portalOrder(await orderService.authoriseDestruction(order.id, { name, method }, actorOf(ctx)));
}

// Staff made the digitize order but the client's sign-off is still missing -> the client gives it here.
async function authoriseDigitization(ctx, orderId, body = {}) {
  const order = await findOwnOrder(ctx, orderId);
  if (order.type !== "digitize") throw httpError(400, "Only digitize orders need this authorisation");
  if (!OPEN_ORDER_STATUSES.includes(order.status)) throw httpError(409, "This order is closed");
  if (order.digitization) throw httpError(409, "This order is already authorised");
  const name = clean(body.name, 200);
  if (!name) throw httpError(400, "Type your name to authorise the digitising");
  return portalOrder(
    await orderService.authoriseDigitization(order.id, { name, note: clean(body.note, 1000) || undefined }, actorOf(ctx))
  );
}

// The customer paid the order's invoice by card in the portal (Stripe, through DocuSoft's proxy -- the browser did the
// charge). We record it against the order; staff can check the payment in Stripe from the order page.
async function payOrder(ctx, orderId, body = {}) {
  const order = await findOwnOrder(ctx, orderId);
  const updated = await orderBilling.recordPayment(
    order.id,
    { reference: clean(body.paymentIntentId, 200), amountMinor: body.amount, currency: body.currency },
    actorOf(ctx),
    { via: "portal" }
  );
  return portalOrder(updated);
}

async function acknowledgeInvoice(ctx, orderId) {
  const order = await findOwnOrder(ctx, orderId);
  return portalOrder(await orderBilling.acknowledgeInvoice(order.id, actorOf(ctx), { via: "portal" }));
}

// Main contact approves a destruction one of their contacts asked for (then the warehouse can approve it).
async function clientApprove(ctx, orderId) {
  if (!ctx.isMainContact) throw httpError(403, "Only the client's main contact can approve this");
  const order = await findOwnOrder(ctx, orderId);
  return portalOrder(await orderService.clientApproveOrder(order.id, ctx));
}

async function orderCertificate(ctx, orderId) {
  const order = await findOwnOrder(ctx, orderId);
  return certificates.getForOrder(order.id, { forClient: true });
}

// A normal contact sees the certificates of its own orders; a main contact sees all of the client's.
async function listCertificates(ctx, q = {}) {
  if (ctx.isMainContact) return certificates.listCertificates({ clientId: ctx.clientId, page: q.page, pageSize: q.pageSize }, { forClient: true });
  const own = await prisma.order.findMany({ where: { ...ownOrders(ctx), type: "destruction" }, select: { id: true } });
  const ids = new Set(own.map((o) => o.id));
  const all = await certificates.listCertificates({ clientId: ctx.clientId, page: 1, pageSize: 100 }, { forClient: true });
  const items = all.items.filter((c) => ids.has(c.orderId));
  return { items, total: items.length };
}

async function listNotifications(ctx, q = {}) {
  return notifications.listForClient(ctx, q);
}

module.exports = {
  payOrder,
  acknowledgeInvoice,
  clientApprove,
  orderCertificate,
  listCertificates,
  listNotifications,
  summary,
  listBoxes,
  getBox,
  boxHistory,
  listOrders,
  getOrder,
  orderLines,
  createOrder,
  cancelOrder,
  authoriseDestruction,
  authoriseDigitization,
};
