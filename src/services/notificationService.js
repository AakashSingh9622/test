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
  billing: (o) => `Your ${TYPE_NAME[o.type]} request ${o.orderNumber} was approved — your invoice follows`,
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

// Staff notifications from before someone's first login count as read for them (a new user doesn't start with
// hundreds of unread items).
async function firstSeen(userId) {
  const user = userId ? await prisma.wHUser.findUnique({ where: { id: userId }, select: { createdAt: true } }) : null;
  return user?.createdAt ?? new Date(0);
}

function unreadWhere(userId, since) {
  return { audience: "staff", createdAt: { gte: since }, reads: { none: { userId } } };
}

// The bell / dashboard list for one staff member: newest first, each with `read`, plus how many are still unread.
async function listForStaff(params = {}, userId) {
  const since = await firstSeen(userId);
  const where = params.unread === "true" || params.unread === true ? unreadWhere(userId, since) : { audience: "staff" };
  const { skip, take } = parsePagination(params, 20);
  const [items, total, unread] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip,
      take,
      include: { reads: { where: { userId: userId ?? "" }, select: { readAt: true } } },
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: unreadWhere(userId, since) }),
  ]);
  return {
    items: items.map(({ reads, ...n }) => ({ ...serializeSimple(n), read: reads.length > 0 || n.createdAt < since })),
    total,
    unread,
  };
}

async function unreadCountForStaff(userId) {
  return prisma.notification.count({ where: unreadWhere(userId, await firstSeen(userId)) });
}

async function markRead(notificationId, userId) {
  const n = await prisma.notification.findFirst({ where: { id: notificationId, audience: "staff" }, select: { id: true } });
  if (!n) return;
  await prisma.notificationRead.createMany({ data: [{ notificationId, userId }], skipDuplicates: true });
}

async function markAllRead(userId) {
  const unread = await prisma.notification.findMany({ where: unreadWhere(userId, await firstSeen(userId)), select: { id: true }, take: 5000 });
  if (unread.length) {
    await prisma.notificationRead.createMany({ data: unread.map((n) => ({ notificationId: n.id, userId })), skipDuplicates: true });
  }
  return unread.length;
}

module.exports = {
  notify,
  notifyClientAboutOrder,
  notifyOrderStatus,
  notifyStaff,
  listForClient,
  listForStaff,
  unreadCountForStaff,
  markRead,
  markAllRead,
};
