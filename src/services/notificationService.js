// In-app notifications (decided 24 Oct: no email yet). Client ones show in the portal's "Updates", staff ones on the
// staff dashboard. Email can later be sent from the same notify() call. Rows are written inside the transaction of the
// change they describe, so a rolled-back change never leaves a notification behind.
const prisma = require("../config/prisma");
const { serializeSimple } = require("../utils/serialize");
const { parsePagination } = require("../utils/pagination");

async function notify({ audience, clientId, contactEmail, orderId, kind, title, body }, db = prisma) {
  return db.notification.create({
    data: {
      audience,
      clientId: clientId ?? undefined,
      contactEmail: contactEmail ? String(contactEmail).toLowerCase() : undefined,
      orderId: orderId ?? undefined,
      kind,
      title: String(title).slice(0, 300),
      body: body ? String(body).slice(0, 1000) : undefined,
    },
  });
}

const TYPE_NAME = { collection: "collection", dispatch: "delivery", destruction: "destruction", digitize: "digitising" };

// What the client is told when their order changes status (null = nothing worth telling).
const CLIENT_STATUS_TEXT = {
  approved: (o) => `Your ${TYPE_NAME[o.type]} request ${o.orderNumber} was approved`,
  rejected: (o) => `Your ${TYPE_NAME[o.type]} request ${o.orderNumber} was declined`,
  scheduled: (o) => `${o.orderNumber} is scheduled`,
  in_progress: (o) => (o.type === "dispatch" ? `${o.orderNumber} is being prepared for delivery` : `${o.orderNumber} is in progress`),
  ready: (o) => (o.type === "dispatch" ? `${o.orderNumber} is packed and ready for delivery` : null),
  on_hold: (o) => `${o.orderNumber} is on hold — we will be in touch`,
  completed: (o) =>
    o.type === "dispatch" ? `${o.orderNumber} was dispatched to you` : o.type === "destruction" ? `${o.orderNumber}: your boxes were destroyed` : `${o.orderNumber} is complete`,
  cancelled: (o) => `${o.orderNumber} was cancelled`,
};

// Client notification for an order: goes to the order's contact (and is visible to the client's main contacts).
async function notifyClientAboutOrder(order, kind, title, body, db = prisma) {
  if (!title) return null;
  return notify({ audience: "client", clientId: order.clientId, contactEmail: order.contactEmail, orderId: order.id, kind, title, body }, db);
}

async function notifyOrderStatus(order, status, db = prisma) {
  const text = CLIENT_STATUS_TEXT[status]?.(order);
  if (text) await notifyClientAboutOrder(order, `order_${status}`, text, undefined, db);
}

async function notifyStaff({ kind, title, body, orderId, clientId }, db = prisma) {
  return notify({ audience: "staff", kind, title, body, orderId, clientId }, db);
}

// Portal: what this contact may see -- their own (contactEmail) and, for a main contact, everything of the client.
async function listForClient(ctx, params = {}) {
  const where = { audience: "client", clientId: ctx.clientId };
  // An ordinary contact sees only its own orders (null = for the main contacts, e.g. "your approval is needed").
  if (!ctx.isMainContact) where.contactEmail = ctx.email;
  const { skip, take } = parsePagination(params, 20);
  const [items, total] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip, take }),
    prisma.notification.count({ where }),
  ]);
  return {
    items: items.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body ?? undefined, orderId: n.orderId ?? undefined, createdAt: n.createdAt.toISOString() })),
    total,
  };
}

async function listForStaff(params = {}) {
  const where = { audience: "staff" };
  const { skip, take } = parsePagination(params, 20);
  const [items, total] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip, take }),
    prisma.notification.count({ where }),
  ]);
  return { items: items.map(serializeSimple), total };
}

module.exports = { notify, notifyClientAboutOrder, notifyOrderStatus, notifyStaff, listForClient, listForStaff };
