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
const { appendMovement } = require("./movementService");
const { refuseAndRecord } = require("./exceptionService");
const { assertNoLegalHold } = require("./legalHoldService");
const { issueCertificate } = require("./certificateService");
const { notifyOrderStatus, notifyClientAboutOrder, notifyStaff } = require("./notificationService");
const { serializeOrder, serializeOrderLine, toDate } = require("../utils/serialize");
const httpError = require("../utils/httpError");
const { parsePagination } = require("../utils/pagination");

// Dispatch/destroy ke liye: line ka box + uska slot (movement ledger me slot aur warehouse id dono jaate hain).
const LINE_BOX_WITH_SLOT = { box: { include: { slot: { select: { id: true, warehouseId: true } } } } };

const NO_OPEN_ORDER = { openOrderId: null, openOrder: Prisma.DbNull };

// Where a box waits after arriving, before it is put on a shelf (no slot, so no capacity is used).
function goodsInPath(warehouse) {
  return { warehouse: warehouse?.code ?? "—", rack: "Goods-In", slot: "—" };
}

// A scanned code = the box's CURRENT barcode only. (Not the box number: it equals the first barcode, so after a re-label
// the old, replaced label would still scan.)
async function findBoxByCode(code, db = prisma) {
  return db.box.findUnique({ where: { barcode: code } });
}

// Dispatch / destroy: either nobody scanned (the old one-click way) or every box has been picked.
function assertAllPickedOrNone(lines) {
  const picked = lines.filter((l) => l.status === "picked").length;
  if (picked > 0 && picked < lines.length) {
    throw httpError(409, `${lines.length - picked} of ${lines.length} boxes aren't picked yet — pick them (or mark them missing) first`);
  }
}

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
  await notifyOrderStatus(updated, status, db);
  return updated;
}

// Reject / cancel (spec §4): boxes still held by this order are freed -- reserved / picked ones go back to stored,
// a box that was coming back on a collection (return_pending) is simply still with the client ("out").
async function releaseOrderBoxes(order, actor, db) {
  const lines = await db.orderLine.findMany({ where: { orderId: order.id, boxId: { not: null } }, include: { box: true } });
  for (const line of lines) {
    const box = line.box;
    if (!box || box.openOrderId !== order.id) continue;
    const status = ["reserved", "picked"].includes(box.status) ? restingStatus(box) : box.status === "return_pending" ? "out" : null;
    if (status) {
      const updated = await db.box.update({ where: { id: box.id }, data: { status, ...NO_OPEN_ORDER } });
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
// "requested" (spec §4). Boxes are claimed for the order: "reserved" for dispatch / destruction / digitize, and
// "return_pending" for boxes coming back on a collection (they are still with the client until received).
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

    // Legal hold always overrides (spec §4.4): a held box can't even be put on a destruction order.
    if (input.type === "destruction") await assertNoLegalHold(boxes, tx);

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
        permanentWithdrawal: input.type === "dispatch" && input.permanentWithdrawal === true,
        clientApprovalRequired: input.clientApprovalRequired === true,
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

    const isReturn = input.type === "collection";
    {
      for (const box of boxes) {
        // Claim the box ONLY if it is still free: two people adding the same box to different orders at the same
        // moment would both pass the check above -- this conditional update lets exactly one of them win.
        const claimed = await tx.box.updateMany({
          // (a digitized box can still be dispatched/destroyed, so it is claimable too; digitize itself only takes "stored" -- see boxEligibility)
          where: isReturn
            ? { id: box.id, status: "out", openOrderId: null }
            : { id: box.id, status: { in: ["stored", "digitized"] }, onHold: false, openOrderId: null },
          data: {
            status: isReturn ? "return_pending" : "reserved",
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

    if (input.requestedVia === "portal") {
      await notifyStaff(
        { kind: "order_requested", title: `New ${order.type} request ${order.orderNumber} from ${order.clientName}`, orderId: order.id, clientId: order.clientId },
        tx
      );
      if (order.clientApprovalRequired) {
        // Shown to the client's main contacts (contactEmail null) -- they approve it in the portal.
        await notifyClientAboutOrder(
          { ...order, contactEmail: null },
          "needs_client_approval",
          `${order.contactName || order.contactEmail} asked to destroy ${order.boxCount} box${order.boxCount === 1 ? "" : "es"} (${order.orderNumber}) — your approval is needed`,
          undefined,
          tx
        );
      }
    }
    return serializeOrder(order);
  }, TX_OPTIONS);
}

async function approveOrder(orderId) {
  return prisma.$transaction(async (tx) => {
    const order = await getOrderOrThrow(orderId, tx);
    if (order.clientApprovalRequired && !order.clientApprovedAt) {
      throw httpError(409, `${order.orderNumber} is waiting for the client's main contact to approve it in the portal`);
    }
    return serializeOrder(await setOrderStatus(order, "approved", tx));
  }, TX_OPTIONS);
}

// The client's main contact approves a destruction asked for by one of their contacts (portal).
async function clientApproveOrder(orderId, ctx) {
  return prisma.$transaction(async (tx) => {
    const order = await getOrderOrThrow(orderId, tx);
    if (!order.clientApprovalRequired) throw httpError(409, "This order doesn't need your approval");
    if (order.clientApprovedAt) throw httpError(409, "This order is already approved");
    if (order.status !== "requested") throw httpError(409, `This order is ${order.status.replace(/_/g, " ")}`);
    await tx.order.update({ where: { id: orderId }, data: { clientApprovedBy: ctx.name || ctx.email, clientApprovedAt: new Date() } });
    await notifyStaff(
      { kind: "client_approved", title: `${order.clientName} approved ${order.orderNumber} — ready for warehouse approval`, orderId, clientId: order.clientId },
      tx
    );
    return finish(orderId, tx);
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

async function dispatchOrder(orderId, recipientName, actor, { courier, trackingRef } = {}) {
  return prisma.$transaction(async (tx) => {
    const order = await getOrderOrThrow(orderId, tx);
    if (order.type !== "dispatch") throw httpError(400, "Not a dispatch order");
    assertTransition(order.status, "completed"); // galat status par kuch bhi badalne se pehle hi fail ho jao

    const lines = await tx.orderLine.findMany({ where: { orderId, boxId: { not: null }, status: { notIn: ["missing", "removed"] } }, include: LINE_BOX_WITH_SLOT });
    assertAllPickedOrNone(lines);
    // Permanent withdrawal: the client keeps the boxes for good -- they can't come back on a collection.
    const leftStatus = order.permanentWithdrawal ? "permanently_withdrawn" : "out";
    for (const line of lines) {
      const box = line.box;
      if (!box) continue;
      await releaseBoxSlot(box, tx);
      const updated = await tx.box.update({
        where: { id: box.id },
        data: { status: leftStatus, ...RELEASED_BOX_FIELDS, ...NO_OPEN_ORDER },
      });
      await appendMovement(
        box,
        "dispatched",
        actor,
        {
          from: box.slot,
          fromLocation: box.locationPath,
          orderId: order.id,
          orderNumber: order.orderNumber,
          reason: order.permanentWithdrawal ? `${recipientName} (permanent withdrawal)` : recipientName,
        },
        tx
      );
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
    const delivery = {
      ...(recipientName && { recipientName: String(recipientName).trim().slice(0, 200) }),
      ...(courier && { courier: String(courier).trim().slice(0, 200) }),
      ...(trackingRef && { trackingRef: String(trackingRef).trim().slice(0, 200) }),
      dispatchedAt: new Date().toISOString(),
    };
    await setOrderStatus(order, "completed", tx, { delivery });
    return finish(orderId, tx);
  }, TX_OPTIONS);
}

// Proof of delivery for a dispatched order (spec §6.2): who received it, when, and a reference (signature / POD number).
async function recordDelivery(orderId, input, actor) {
  const receivedBy = String(input.receivedBy || "").trim();
  if (!receivedBy) throw httpError(400, "receivedBy is required");
  const deliveredAt = input.deliveredAt ? new Date(input.deliveredAt) : new Date();
  if (Number.isNaN(deliveredAt.getTime())) throw httpError(400, "deliveredAt is not a valid date");
  return prisma.$transaction(async (tx) => {
    const order = await getOrderOrThrow(orderId, tx);
    if (order.type !== "dispatch") throw httpError(400, "Only dispatch orders are delivered");
    if (order.status !== "completed") throw httpError(409, `${order.orderNumber} hasn't been dispatched yet`);
    const delivery = {
      ...(order.delivery || {}),
      receivedBy: receivedBy.slice(0, 200),
      proofReference: input.proofReference ? String(input.proofReference).trim().slice(0, 200) : undefined,
      deliveredAt: deliveredAt.toISOString(),
      recordedBy: { id: actor.id, name: actor.name },
    };
    await tx.order.update({ where: { id: orderId }, data: { delivery } });
    await notifyClientAboutOrder(order, "order_delivered", `${order.orderNumber} was delivered — received by ${delivery.receivedBy}`, undefined, tx);
    return finish(orderId, tx);
  }, TX_OPTIONS);
}

async function authoriseDestruction(orderId, input, actor) {
  return prisma.$transaction(async (tx) => {
    const order = await getOrderOrThrow(orderId, tx);
    if (order.type !== "destruction") throw httpError(400, "Not a destruction order");
    if (order.destruction?.approvedBy) throw httpError(409, "This destruction is already approved — it can't be re-authorised");

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

// The second signature (spec §4.4 two-person control): a records manager who did NOT prepare the order approves it.
async function approveDestruction(orderId, actor) {
  return prisma.$transaction(async (tx) => {
    const order = await getOrderOrThrow(orderId, tx);
    if (order.type !== "destruction") throw httpError(400, "Not a destruction order");
    if (!order.destruction) throw httpError(409, "The client's authorisation must be recorded first");
    if (order.destruction.approvedBy) throw httpError(409, "This destruction is already approved");
    if (!["approved", "scheduled", "in_progress", "ready"].includes(order.status)) {
      throw httpError(409, `${order.orderNumber} is ${order.status.replace(/_/g, " ")}`);
    }
    if (order.requestedBy?.side === "staff" && order.requestedBy.id === actor.id) {
      throw httpError(403, "You prepared this destruction order — a different person must approve it");
    }
    const lines = await tx.orderLine.findMany({ where: { orderId, boxId: { not: null }, status: { notIn: ["missing", "removed"] } }, include: { box: true } });
    await assertNoLegalHold(lines.map((l) => l.box).filter(Boolean), tx);
    const destruction = { ...order.destruction, approvedBy: { id: actor.id, name: actor.name }, approvedAt: new Date().toISOString() };
    await tx.order.update({ where: { id: orderId }, data: { destruction } });
    for (const line of lines) {
      if (line.box) await appendAuditEvent(line.box, "destruction_approved", actor, { orderId: order.id, orderNumber: order.orderNumber }, tx);
    }
    return finish(orderId, tx);
  }, TX_OPTIONS);
}

async function destroyOrder(orderId, witness, actor, { place } = {}) {
  return prisma.$transaction(async (tx) => {
    const order = await getOrderOrThrow(orderId, tx);
    if (order.type !== "destruction") throw httpError(400, "Not a destruction order");
    if (!order.destruction) throw httpError(400, "Destruction must be authorised first");
    if (!order.destruction.approvedBy) throw httpError(409, "A records manager must approve this destruction first (second signature)");
    assertTransition(order.status, "completed");

    const destruction = witness ? { ...order.destruction, witness } : order.destruction;

    const lines = await tx.orderLine.findMany({ where: { orderId, boxId: { not: null }, status: { notIn: ["missing", "removed"] } }, include: LINE_BOX_WITH_SLOT });
    assertAllPickedOrNone(lines);
    // A hold placed after the approval still wins.
    await assertNoLegalHold(lines.map((l) => l.box).filter(Boolean), tx);
    const destroyedBoxes = [];
    for (const line of lines) {
      const box = line.box;
      if (!box) continue;
      await releaseBoxSlot(box, tx);
      const updated = await tx.box.update({
        where: { id: box.id },
        data: { status: "destroyed", ...RELEASED_BOX_FIELDS, ...NO_OPEN_ORDER },
      });
      await appendMovement(
        box,
        "destroyed",
        actor,
        { from: box.slot, fromLocation: box.locationPath, orderId: order.id, orderNumber: order.orderNumber, reason: destruction.method },
        tx
      );
      await tx.orderLine.update({ where: { id: line.id }, data: { status: "destroyed" } });
      destroyedBoxes.push(box);
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
    const certificate = await issueCertificate({ order, boxes: destroyedBoxes, destruction, place, actor }, tx);
    await notifyClientAboutOrder(
      order,
      "certificate_issued",
      `Certificate of destruction ${certificate.certificateNumber} is ready for ${order.orderNumber}`,
      undefined,
      tx
    );
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

// One returning box arrives: the line is received and the box waits at the warehouse's Goods-In ("received") until
// it is put on a shelf. Fixes B7 (boxes used to stay "out" after the collection was completed).
async function receiveReturnLine(tx, order, line, warehouse, actor) {
  const box = line.box;
  if (box && box.status === "return_pending") {
    const toLocation = goodsInPath(warehouse);
    const updated = await tx.box.update({
      where: { id: box.id },
      data: { status: "received", goodsInWarehouseId: warehouse?.id ?? null, locationPath: toLocation, ...NO_OPEN_ORDER },
    });
    await appendMovement(
      box,
      "received",
      actor,
      { to: warehouse ? { id: undefined, warehouseId: warehouse.id } : null, toLocation, orderId: order.id, orderNumber: order.orderNumber },
      tx
    );
    await appendAuditEvent(updated, "received", actor, { orderId: order.id, orderNumber: order.orderNumber, toLocation }, tx);
  }
  await tx.orderLine.update({ where: { id: line.id }, data: { status: "received", scannedAt: new Date(), scannedBy: actor } });
}

async function warehouseOrThrow(warehouseId, db) {
  if (!warehouseId) return null;
  const warehouse = await db.warehouse.findUnique({ where: { id: warehouseId } });
  if (!warehouse) throw httpError(404, "Warehouse not found");
  return warehouse;
}

// Finishes a collection: returning boxes that weren't scanned are received now (into warehouseId's Goods-In if given).
async function completeOrder(orderId, actor, { warehouseId } = {}) {
  return prisma.$transaction(async (tx) => {
    const order = await getOrderOrThrow(orderId, tx);
    if (order.type !== "collection") throw httpError(400, "Only collection orders can be completed directly");
    assertTransition(order.status, "completed");
    const warehouse = await warehouseOrThrow(warehouseId, tx);
    const pending = await tx.orderLine.findMany({ where: { orderId, status: "pending" }, include: { box: true } });
    for (const line of pending) await receiveReturnLine(tx, order, line, warehouse, actor);
    await recomputeLineSummary(orderId, tx);
    await setOrderStatus(order, "completed", tx);
    return finish(orderId, tx);
  }, TX_OPTIONS);
}

// --- Hold / resume (supervisor) -----------------------------------------------------------------------------------

async function holdOrder(orderId, reason, actor) {
  const text = String(reason || "").trim();
  if (!text) throw httpError(400, "A reason is required to put an order on hold");
  return prisma.$transaction(async (tx) => {
    const order = await getOrderOrThrow(orderId, tx);
    const notes = order.notes ? `${order.notes}\nOn hold: ${text}` : `On hold: ${text}`;
    await setOrderStatus(order, "on_hold", tx, { heldFromStatus: order.status, holdReason: text.slice(0, 1000), notes });
    return finish(orderId, tx);
  }, TX_OPTIONS);
}

async function resumeOrder(orderId) {
  return prisma.$transaction(async (tx) => {
    const order = await getOrderOrThrow(orderId, tx);
    if (order.status !== "on_hold" || !order.heldFromStatus) throw httpError(409, `Order ${order.orderNumber} is not on hold`);
    await setOrderStatus(order, order.heldFromStatus, tx, { heldFromStatus: null, holdReason: null });
    return finish(orderId, tx);
  }, TX_OPTIONS);
}

// --- Pick list, pick scan, receive scan ---------------------------------------------------------------------------

// The order's boxes in walking order: warehouse, rack, row, column (spec §6.2). Boxes not on a shelf come last.
async function getPickList(orderId) {
  const order = await getOrderOrThrow(orderId, prisma);
  const lines = await prisma.orderLine.findMany({
    where: { orderId, boxId: { not: null }, status: { not: "removed" } },
    include: { box: { include: { slot: { include: { rack: { select: { code: true } }, warehouse: { select: { code: true } } } } } } },
  });
  const key = (l) => {
    const s = l.box?.slot;
    // same slot -> by box number, so the list is always in the same order
    return s
      ? [0, s.warehouse.code, s.rack.code, String(s.row).padStart(4, "0"), String(s.column).padStart(4, "0"), l.boxNumber || ""]
      : [1, l.boxNumber || ""];
  };
  lines.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      if (ka[i] === kb[i]) continue;
      return String(ka[i] ?? "").localeCompare(String(kb[i] ?? ""));
    }
    return 0;
  });
  return {
    order: serializeOrder(order),
    lines: lines.map((l) => ({
      lineId: l.id,
      boxId: l.boxId,
      boxNumber: l.boxNumber,
      barcode: l.box?.barcode,
      description: l.box?.description,
      lineStatus: l.status,
      boxStatus: l.box?.status,
      slotBarcode: l.box?.slot?.barcode,
      location: l.box?.locationPath ?? undefined,
      scannedAt: l.scannedAt?.toISOString(),
    })),
  };
}

// One box scanned while picking. Wrong / unknown box -> refused AND put in the supervisor queue. Scanning the same box
// twice is fine. When the last box is picked the order becomes "ready".
async function pickBox(orderId, rawCode, actor) {
  const code = String(rawCode || "").trim();
  if (!code) throw httpError(400, "Scan or type a box barcode");
  const order = await getOrderOrThrow(orderId, prisma);
  if (!["dispatch", "destruction"].includes(order.type)) throw httpError(400, "Only dispatch and destruction orders are picked");
  if (!["in_progress", "ready"].includes(order.status)) {
    throw httpError(409, `Order ${order.orderNumber} is ${order.status.replace(/_/g, " ")} — start picking first`);
  }
  const ref = { orderId: order.id, orderNumber: order.orderNumber, boxBarcode: code };
  const box = await findBoxByCode(code);
  if (!box) await refuseAndRecord(404, "box_not_found", actor, { ...ref, message: `No box has the barcode ${code}` });
  const line = await prisma.orderLine.findFirst({ where: { orderId, boxId: box.id, status: { in: ["pending", "picked"] } } });
  if (!line) {
    await refuseAndRecord(409, "wrong_box", actor, { ...ref, boxId: box.id, message: `${box.boxNumber} is not on order ${order.orderNumber} — put it back` });
  }

  return prisma.$transaction(async (tx) => {
    const taken = await tx.orderLine.updateMany({
      where: { id: line.id, status: "pending" },
      data: { status: "picked", scannedAt: new Date(), scannedBy: actor },
    });
    if (taken.count === 1) {
      const updated = await tx.box.update({ where: { id: box.id }, data: { status: "picked" } });
      await appendAuditEvent(updated, "picked", actor, { orderId: order.id, orderNumber: order.orderNumber, fromLocation: box.locationPath ?? undefined }, tx);
      await recomputeLineSummary(orderId, tx);
    }
    const remaining = await tx.orderLine.count({ where: { orderId, boxId: { not: null }, status: "pending" } });
    const current = await tx.order.findUnique({ where: { id: orderId } });
    if (remaining === 0 && current.status === "in_progress") await setOrderStatus(current, "ready", tx);
    return { order: await finish(orderId, tx), boxNumber: box.boxNumber, alreadyPicked: taken.count === 0, remaining };
  }, TX_OPTIONS);
}

// One returning box scanned at the dock for a collection order.
async function receiveReturnBox(orderId, rawCode, warehouseId, actor) {
  const code = String(rawCode || "").trim();
  if (!code) throw httpError(400, "Scan or type a box barcode");
  const order = await getOrderOrThrow(orderId, prisma);
  if (order.type !== "collection") throw httpError(400, "Only collection orders receive boxes");
  if (order.status !== "in_progress") {
    throw httpError(409, `Order ${order.orderNumber} is ${order.status.replace(/_/g, " ")} — start receiving first`);
  }
  const warehouse = await warehouseOrThrow(warehouseId, prisma);
  const ref = { orderId: order.id, orderNumber: order.orderNumber, boxBarcode: code };
  const box = await findBoxByCode(code);
  if (!box) await refuseAndRecord(404, "box_not_found", actor, { ...ref, message: `No box has the barcode ${code}` });
  const line = await prisma.orderLine.findFirst({ where: { orderId, boxId: box.id, status: { in: ["pending", "received"] } } });
  if (!line) {
    await refuseAndRecord(409, "wrong_box", actor, {
      ...ref,
      boxId: box.id,
      message: `${box.boxNumber} is not on collection ${order.orderNumber} — keep it apart and tell a supervisor`,
    });
  }

  return prisma.$transaction(async (tx) => {
    const fresh = await tx.orderLine.findUnique({ where: { id: line.id }, include: { box: true } });
    const alreadyReceived = fresh.status === "received";
    if (!alreadyReceived) {
      await receiveReturnLine(tx, order, fresh, warehouse, actor);
      await recomputeLineSummary(orderId, tx);
    }
    const remaining = await tx.orderLine.count({ where: { orderId, boxId: { not: null }, status: "pending" } });
    return { order: await finish(orderId, tx), boxNumber: box.boxNumber, alreadyReceived, remaining };
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
  holdOrder,
  resumeOrder,
  clientApproveOrder,
  recordDelivery,
  approveDestruction,
  getPickList,
  pickBox,
  receiveReturnBox,
  goodsInPath,
  findBoxByCode,
};
