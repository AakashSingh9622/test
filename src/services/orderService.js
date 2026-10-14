// Order lifecycle (spec §4). State machine src/services/orderMachine.js me hai. Har multi-step
// action (dispatch, destroy, cancel, ...) ek Postgres transaction me chalta hai -- beech me fail
// hone par na box/slot counters aadhe-adhure rehte hain, na order ka status.
const { Prisma } = require("../config/prisma");
const prisma = require("../config/prisma");
const { nextSequence } = require("./counterService");
const { assertTransition } = require("./orderMachine");
const { getBoxIneligibilityReason } = require("./boxEligibility");
const { releaseBoxSlot, RELEASED_BOX_FIELDS, TX_OPTIONS } = require("./boxAllocationService");
const { appendAuditEvent } = require("./auditService");
const { serializeOrder, serializeOrderLine, toDate } = require("../utils/serialize");
const httpError = require("../utils/httpError");
const { parsePagination } = require("../utils/pagination");

const NO_OPEN_ORDER = { openOrderId: null, openOrder: Prisma.DbNull };

// What a box goes back to when it is free again: "digitized" if it was ever digitized, else "stored".
function restingStatus(box) {
  return box.digitizedAt ? "digitized" : "stored";
}

// { name, note? } typed by the client (or recorded by staff) -> what is saved on order.digitization.
function buildDigitization(a, actor) {
  const name = String(a.name || "").trim();
  if (!name) throw httpError(400, "digitizationAuthorisation.name is required");
  const note = a.note ? String(a.note).trim().slice(0, 1000) : undefined;
  return {
    name,
    note,
    authorisedBy: actor.side === "client" ? name : a.reference ? `${name} — ${a.reference}` : name,
    authorisedAt: new Date().toISOString(),
  };
}

function orderNumber(type, seq) {
  const prefix = { collection: "COL", dispatch: "DSP", destruction: "DST", digitize: "DGT" }[type] || "ORD";
  return `${prefix}-${String(seq).padStart(6, "0")}`;
}

async function getOrderOrThrow(orderId, db) {
  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) throw httpError(404, "Order not found");
  return order;
}

// Order ki saari OrderLines se lineSummary recompute karke order me likhta hai (boxCount
// creation ke baad kabhi nahi badalta -- sirf lineSummary har line-status-change par refresh hoti hai).
async function recomputeLineSummary(orderId, db) {
  const groups = await db.orderLine.groupBy({ by: ["status"], where: { orderId }, _count: { _all: true } });
  const summary = {};
  for (const g of groups) summary[g.status] = g._count._all;
  await db.order.update({ where: { id: orderId }, data: { lineSummary: summary } });
}

// Status badalta hai (assertTransition invalid transition par throw karta hai) aur jin boxes
// ka openOrder snapshot abhi bhi is order ko point karta hai unka status sync rakhta hai.
async function setOrderStatus(order, status, db, extra = {}) {
  assertTransition(order.status, status);
  const updated = await db.order.update({
    where: { id: order.id },
    data: { status, ...(status === "completed" ? { completedAt: new Date() } : {}), ...extra },
  });

  const boxes = await db.box.findMany({ where: { openOrderId: order.id } });
  for (const box of boxes) {
    await db.box.update({ where: { id: box.id }, data: { openOrder: { ...box.openOrder, status } } });
  }
  return updated;
}

// Abhi bhi "reserved" pade boxes ko wapas "stored" kar deta hai (reject/cancel -- spec §4).
async function releaseOrderBoxes(order, actor, db) {
  const lines = await db.orderLine.findMany({ where: { orderId: order.id, boxId: { not: null } }, include: { box: true } });
  for (const line of lines) {
    const box = line.box;
    if (box && box.status === "reserved" && box.openOrderId === order.id) {
      const updated = await db.box.update({ where: { id: box.id }, data: { status: restingStatus(box), ...NO_OPEN_ORDER } });
      await db.orderLine.update({ where: { id: line.id }, data: { status: "removed" } });
      await appendAuditEvent(updated, "removed_from_order", actor, { orderId: order.id, orderNumber: order.orderNumber }, db);
    }
  }
  await recomputeLineSummary(order.id, db);
}

// Order ko transaction me padh kar fresh row (lineSummary etc. ke saath) lautata hai.
async function finish(orderId, db) {
  return serializeOrder(await db.order.findUnique({ where: { id: orderId } }));
}

// Lower-case + trim, so "Asha@Tata.com " and "asha@tata.com" are the same contact everywhere.
function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// Which orders a CLIENT-SIDE login may see (not used by the staff screens yet -- the portal will call this):
//   * normal contact  -> only orders of its clientId that were made for / by ITS email
//   * main contact    -> every order of its clientId
// clientId and email must come from the logged-in session, never from request input.
function visibleToContactWhere({ clientId, contactEmail, isMainContact }) {
  if (!clientId) throw httpError(400, "clientId is required");
  if (isMainContact) return { clientId };
  const email = normalizeEmail(contactEmail);
  if (!email) throw httpError(400, "contactEmail is required");
  return { clientId, contactEmail: { equals: email, mode: "insensitive" } };
}

async function searchOrders(params) {
  const where = {};
  if (params.type) where.type = params.type;
  if (params.status?.length) where.status = { in: params.status };
  if (params.clientId) where.clientId = params.clientId;
  // Orders of one contact (staff can filter by it too). Case-insensitive.
  if (params.contactEmail) where.contactEmail = { equals: normalizeEmail(params.contactEmail), mode: "insensitive" };
  if (params.q) {
    const contains = { contains: params.q, mode: "insensitive" };
    where.OR = [{ orderNumber: contains }, { clientName: contains }];
  }
  const { skip, take } = parsePagination(params);
  const [orders, total] = await Promise.all([
    prisma.order.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip, take }),
    prisma.order.count({ where }),
  ]);
  return { items: orders.map(serializeOrder), total };
}

async function getOrderById(id) {
  return serializeOrder(await prisma.order.findUnique({ where: { id } }));
}

async function getOrderLines(orderId) {
  // fromLocation on a line is a snapshot from when the box was put on the order; currentLocation is where the box is NOW
  // (it can have been moved since), which is what staff need to go and pick it.
  const lines = await prisma.orderLine.findMany({
    where: { orderId },
    orderBy: { createdAt: "asc" },
    include: { box: { select: { locationPath: true } } },
  });
  return lines.map(({ box, ...line }) => serializeOrderLine({ ...line, currentLocation: box?.locationPath ?? undefined }));
}

// Order + lines banata hai; staff-created orders seedha "approved" shuru hote hain, portal wale
// "requested" (spec §4). Collection orders ke liye boxIds usually khaali hote hain (naye boxes
// collection ke baad register honge), isliye unki boxes ko "reserved" nahi kiya jaata.
async function createOrder(input, actor) {
  // Every order belongs to one contact of the client (identified by email): staff pick it in the form, and the
  // portal uses the logged-in contact. Without it the order could not be shown to the right person later.
  const contactEmail = normalizeEmail(input.contactEmail);
  if (!contactEmail) throw httpError(400, "contactEmail is required -- pick the client contact this order is for");
  // No format check on purpose: the email of a contact picked from DocuSoft is stored exactly as DocuSoft has it.

  // Destruction needs the client's authorisation (name + method). A client in the portal gives it while requesting;
  // staff may instead leave it for later (authoriseDestruction) or record an offline one here.
  let authorisation = null;
  if (input.type === "destruction" && input.destructionAuthorisation) {
    const { name, method, reference } = input.destructionAuthorisation;
    if (!name || !String(name).trim()) throw httpError(400, "destructionAuthorisation.name is required");
    if (!["shred", "pulp", "incinerate"].includes(method)) throw httpError(400, "destructionAuthorisation.method must be shred, pulp or incinerate");
    const who = String(name).trim();
    authorisation = {
      method,
      authorisedBy: reference && actor.side !== "client" ? `${who} — ${reference}` : who,
      authorisedAt: new Date().toISOString(),
    };
  }

  // Digitize needs the client's sign-off too: their name (+ an optional note). Same rule as destruction: the client
  // gives it while requesting in the portal; staff may leave it for later (authoriseDigitization) or record one here.
  let digitization = null;
  if (input.type === "digitize" && input.digitizationAuthorisation) {
    digitization = buildDigitization(input.digitizationAuthorisation, actor);
  }

  return prisma.$transaction(async (tx) => {
    const boxes = [];
    for (const boxId of new Set(input.boxIds || [])) {
      // (Set: the same box sent twice must not become two lines -- it would be released/dispatched twice.)
      const box = await tx.box.findUnique({ where: { id: boxId } });
      if (!box) throw httpError(404, `Box ${boxId} not found`);
      if (box.clientId !== input.clientId) throw httpError(400, `${box.boxNumber}: belongs to a different client`);
      const reason = getBoxIneligibilityReason(box, input.type);
      if (reason) throw httpError(400, `${box.boxNumber}: ${reason}`);
      boxes.push(box);
    }

    const status = input.requestedVia === "portal" ? "requested" : "approved";
    const seq = await nextSequence(`orderSeq:${input.type}`, tx);

    const order = await tx.order.create({
      data: {
        orderNumber: orderNumber(input.type, seq),
        type: input.type,
        status,
        clientId: input.clientId,
        clientName: input.clientName,
        requestedBy: actor,
        requestedVia: input.requestedVia,
        scheduledFor: toDate(input.scheduledFor) || undefined,
        address: input.address || undefined,
        contactName: input.contactName || undefined,
        contactEmail,
        contactPhone: input.contactPhone || undefined,
        notes: input.notes || undefined,
        boxCount: boxes.length,
        lineSummary: boxes.length > 0 ? { pending: boxes.length } : {},
        collectionInfo: input.type === "collection" ? { expectedNewBoxes: input.expectedNewBoxes || 0 } : undefined,
        destruction: authorisation ?? undefined,
        digitization: digitization ?? undefined,
      },
    });

    if (boxes.length > 0) {
      await tx.orderLine.createMany({
        data: boxes.map((box) => ({
          orderId: order.id,
          boxId: box.id,
          boxNumber: box.boxNumber,
          status: "pending",
          fromLocation: box.locationPath ?? undefined,
        })),
      });
    }

    if (input.type !== "collection") {
      for (const box of boxes) {
        // Claim the box ONLY if it is still free: two people adding the same box to different orders at the same
        // moment would both pass the check above -- this conditional update lets exactly one of them win.
        const claimed = await tx.box.updateMany({
          // (a digitized box can still be dispatched/destroyed, so it is claimable too; digitize itself only takes "stored" -- see boxEligibility)
          where: { id: box.id, status: { in: ["stored", "digitized"] }, onHold: false, openOrderId: null },
          data: {
            status: "reserved",
            openOrderId: order.id,
            openOrder: { id: order.id, orderNumber: order.orderNumber, type: order.type, status: order.status },
          },
        });
        if (claimed.count !== 1) throw httpError(409, `${box.boxNumber} is no longer available -- it was just added to another order`);
        await appendAuditEvent(box, "added_to_order", actor, { orderId: order.id, orderNumber: order.orderNumber }, tx);
        if (authorisation) {
          await appendAuditEvent(box, "destruction_authorised", actor, { orderId: order.id, orderNumber: order.orderNumber }, tx);
        }
        if (digitization) {
          await appendAuditEvent(box, "digitization_authorised", actor, { orderId: order.id, orderNumber: order.orderNumber, note: digitization.note }, tx);
        }
      }
    }

    return serializeOrder(order);
  }, TX_OPTIONS);
}

async function approveOrder(orderId) {
  return prisma.$transaction(async (tx) => {
    const order = await getOrderOrThrow(orderId, tx);
    return serializeOrder(await setOrderStatus(order, "approved", tx));
  }, TX_OPTIONS);
}

async function rejectOrder(orderId, reason, actor) {
  return prisma.$transaction(async (tx) => {
    const order = await getOrderOrThrow(orderId, tx);
    const notes = order.notes ? `${order.notes}\nRejected: ${reason}` : `Rejected: ${reason}`;
    await setOrderStatus(order, "rejected", tx, { notes });
    await releaseOrderBoxes(order, actor, tx);
    return finish(orderId, tx);
  }, TX_OPTIONS);
}

async function scheduleOrder(orderId, scheduledFor) {
  return prisma.$transaction(async (tx) => {
    const order = await getOrderOrThrow(orderId, tx);
    return serializeOrder(await setOrderStatus(order, "scheduled", tx, { scheduledFor: toDate(scheduledFor) }));
  }, TX_OPTIONS);
}

async function startOrder(orderId) {
  return prisma.$transaction(async (tx) => {
    const order = await getOrderOrThrow(orderId, tx);
    return serializeOrder(await setOrderStatus(order, "in_progress", tx));
  }, TX_OPTIONS);
}

async function cancelOrder(orderId, reason, actor) {
  return prisma.$transaction(async (tx) => {
    const order = await getOrderOrThrow(orderId, tx);
    const notes = order.notes ? `${order.notes}\nCancelled: ${reason}` : `Cancelled: ${reason}`;
    await setOrderStatus(order, "cancelled", tx, { notes });
    await releaseOrderBoxes(order, actor, tx);
    return finish(orderId, tx);
  }, TX_OPTIONS);
}

async function dispatchOrder(orderId, recipientName, actor) {
  return prisma.$transaction(async (tx) => {
    const order = await getOrderOrThrow(orderId, tx);
    if (order.type !== "dispatch") throw httpError(400, "Not a dispatch order");
    assertTransition(order.status, "completed"); // galat status par kuch bhi badalne se pehle hi fail ho jao

    const lines = await tx.orderLine.findMany({ where: { orderId, boxId: { not: null }, status: { notIn: ["missing", "removed"] } }, include: { box: true } });
    for (const line of lines) {
      const box = line.box;
      if (!box) continue;
      await releaseBoxSlot(box, tx);
      const updated = await tx.box.update({
        where: { id: box.id },
        data: { status: "out", ...RELEASED_BOX_FIELDS, ...NO_OPEN_ORDER },
      });
      await tx.orderLine.update({
        where: { id: line.id },
        data: { status: "dispatched", scannedBy: actor, scannedAt: new Date() },
      });
      await appendAuditEvent(
        updated,
        "dispatched",
        actor,
        { orderId: order.id, orderNumber: order.orderNumber, note: recipientName },
        tx
      );
    }
    await recomputeLineSummary(orderId, tx);
    await setOrderStatus(order, "completed", tx);
    return finish(orderId, tx);
  }, TX_OPTIONS);
}

async function authoriseDestruction(orderId, input, actor) {
  return prisma.$transaction(async (tx) => {
    const order = await getOrderOrThrow(orderId, tx);
    if (order.type !== "destruction") throw httpError(400, "Not a destruction order");

    await tx.order.update({
      where: { id: orderId },
      data: {
        destruction: {
          method: input.method,
          authorisedBy:
            input.reference && actor.side !== "client" ? `${input.name} — ${input.reference}` : input.name,
          authorisedAt: new Date().toISOString(),
        },
      },
    });

    const lines = await tx.orderLine.findMany({ where: { orderId, boxId: { not: null }, status: { notIn: ["missing", "removed"] } }, include: { box: true } });
    for (const line of lines) {
      if (!line.box) continue;
      await appendAuditEvent(
        line.box,
        "destruction_authorised",
        actor,
        { orderId: order.id, orderNumber: order.orderNumber },
        tx
      );
    }
    return finish(orderId, tx);
  }, TX_OPTIONS);
}

async function destroyOrder(orderId, witness, actor) {
  return prisma.$transaction(async (tx) => {
    const order = await getOrderOrThrow(orderId, tx);
    if (order.type !== "destruction") throw httpError(400, "Not a destruction order");
    if (!order.destruction) throw httpError(400, "Destruction must be authorised first");
    assertTransition(order.status, "completed");

    const destruction = witness ? { ...order.destruction, witness } : order.destruction;

    const lines = await tx.orderLine.findMany({ where: { orderId, boxId: { not: null }, status: { notIn: ["missing", "removed"] } }, include: { box: true } });
    for (const line of lines) {
      const box = line.box;
      if (!box) continue;
      await releaseBoxSlot(box, tx);
      const updated = await tx.box.update({
        where: { id: box.id },
        data: { status: "destroyed", ...RELEASED_BOX_FIELDS, ...NO_OPEN_ORDER },
      });
      await tx.orderLine.update({ where: { id: line.id }, data: { status: "destroyed" } });
      await appendAuditEvent(
        updated,
        "destroyed",
        actor,
        {
          orderId: order.id,
          orderNumber: order.orderNumber,
          note: destruction.method,
          changes: witness ? [{ field: "witness", to: witness }] : undefined,
        },
        tx
      );
    }
    await recomputeLineSummary(orderId, tx);
    await setOrderStatus(order, "completed", tx, { destruction });
    return finish(orderId, tx);
  }, TX_OPTIONS);
}

async function authoriseDigitization(orderId, input, actor) {
  return prisma.$transaction(async (tx) => {
    const order = await getOrderOrThrow(orderId, tx);
    if (order.type !== "digitize") throw httpError(400, "Not a digitize order");
    if (order.digitization) throw httpError(409, "This order is already authorised");
    const digitization = buildDigitization(input, actor);
    await tx.order.update({ where: { id: orderId }, data: { digitization } });
    const lines = await tx.orderLine.findMany({
      where: { orderId, boxId: { not: null }, status: { notIn: ["missing", "removed"] } },
      include: { box: true },
    });
    for (const line of lines) {
      if (!line.box) continue;
      await appendAuditEvent(
        line.box,
        "digitization_authorised",
        actor,
        { orderId: order.id, orderNumber: order.orderNumber, note: digitization.note },
        tx
      );
    }
    return finish(orderId, tx);
  }, TX_OPTIONS);
}

// Finishes a digitize order: the boxes stay where they are but become "digitized" (and remember it in digitizedAt).
// No screen calls this yet -- the scan app that does the digitising will.
async function digitizeOrder(orderId, actor) {
  return prisma.$transaction(async (tx) => {
    const order = await getOrderOrThrow(orderId, tx);
    if (order.type !== "digitize") throw httpError(400, "Not a digitize order");
    if (!order.digitization) throw httpError(400, "Digitising must be authorised first");
    assertTransition(order.status, "completed");

    const lines = await tx.orderLine.findMany({
      where: { orderId, boxId: { not: null }, status: { notIn: ["missing", "removed"] } },
      include: { box: true },
    });
    for (const line of lines) {
      if (!line.box) continue;
      const updated = await tx.box.update({
        where: { id: line.box.id },
        data: { status: "digitized", digitizedAt: new Date(), ...NO_OPEN_ORDER },
      });
      await tx.orderLine.update({ where: { id: line.id }, data: { status: "digitized" } });
      await appendAuditEvent(updated, "digitized", actor, { orderId: order.id, orderNumber: order.orderNumber }, tx);
    }
    await recomputeLineSummary(orderId, tx);
    await setOrderStatus(order, "completed", tx);
    return finish(orderId, tx);
  }, TX_OPTIONS);
}

// Collection orders ke liye pick/dispatch/destroy jaisa koi step nahi -- complete seedha close kar deta hai.
async function completeOrder(orderId) {
  return prisma.$transaction(async (tx) => {
    const order = await getOrderOrThrow(orderId, tx);
    if (order.type !== "collection") throw httpError(400, "Only collection orders can be completed directly");
    assertTransition(order.status, "completed");
    await tx.orderLine.updateMany({ where: { orderId }, data: { status: "received" } });
    await recomputeLineSummary(orderId, tx);
    await setOrderStatus(order, "completed", tx);
    return finish(orderId, tx);
  }, TX_OPTIONS);
}

module.exports = {
  visibleToContactWhere,
  recomputeLineSummary,
  searchOrders,
  getOrderById,
  getOrderLines,
  createOrder,
  approveOrder,
  rejectOrder,
  scheduleOrder,
  startOrder,
  cancelOrder,
  dispatchOrder,
  authoriseDestruction,
  destroyOrder,
  authoriseDigitization,
  digitizeOrder,
  completeOrder,
};
