// Box registration, search, aur detail actions.
const prisma = require("../config/prisma");
const { Prisma } = prisma;
const { nextSequence } = require("./counterService");
const { appendAuditEvent } = require("./auditService");
const { getBoxSizes } = require("./boxSizeService");
const { TX_OPTIONS, releaseBoxSlot, RELEASED_BOX_FIELDS } = require("./boxAllocationService");
const { recomputeLineSummary } = require("./orderService");
const { serializeBox, serializeOrder, dateOnly, toDate } = require("../utils/serialize");
const httpError = require("../utils/httpError");
const { parsePagination } = require("../utils/pagination");

async function searchBoxes(params) {
  const where = {};

  if (params.q) {
    const contains = { contains: params.q, mode: "insensitive" };
    where.OR = [
      { boxNumber: contains },
      { barcode: contains },
      { description: contains },
      { clientName: contains },
      { reference: contains },
      { department: contains },
    ];
  }
  if (params.clientId) where.clientId = params.clientId;
  if (params.status?.length) where.status = { in: params.status };
  else where.status = { not: "destroyed" }; // default: destroyed boxes hide rahte hain (spec §7)
  if (params.onHold !== undefined) where.onHold = params.onHold;
  if (params.orderId) where.openOrderId = params.orderId;
  if (params.warehouseId || params.rackId || params.row) {
    where.slot = {
      ...(params.warehouseId && { warehouseId: params.warehouseId }),
      ...(params.rackId && { rackId: params.rackId }),
      ...(params.row && { row: params.row }),
    };
  }

  const { skip, take } = parsePagination(params);

  const [items, total] = await Promise.all([
    prisma.box.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }], // id = stable tie-break so pages never overlap
      skip,
      take,
    }),
    prisma.box.count({ where }),
  ]);

  return { items: items.map(serializeBox), total };
}

async function getBoxById(id) {
  return serializeBox(await prisma.box.findUnique({ where: { id } }));
}

// Jin orders me ye box kabhi shamil hua hai, unki list (box detail ka "Orders" tab).
async function getOrdersForBox(boxId) {
  const orders = await prisma.order.findMany({
    where: { lines: { some: { boxId } } },
    orderBy: { createdAt: "desc" },
  });
  return orders.map(serializeOrder);
}

// Naye boxes ek saath register karta hai (Register Boxes wizard, step 1) -- ek transaction me.
async function createBoxesBatch(input, actor) {
  return prisma.$transaction(async (tx) => {
    // Collection order ke liye register ho rahe hain to order pehle hi validate karo (galat/band
    // order par boxes bana kar fail hone se behtar hai ki shuru me hi 4xx mile).
    const linkedOrder = input.orderId ? await tx.order.findUnique({ where: { id: input.orderId } }) : null;
    if (input.orderId) {
      if (!linkedOrder) throw httpError(404, "Order not found");
      if (linkedOrder.type !== "collection") throw httpError(400, "New boxes can only be registered against a collection order");
      if (["completed", "cancelled", "rejected"].includes(linkedOrder.status)) {
        throw httpError(409, `Order ${linkedOrder.orderNumber} is ${linkedOrder.status}`);
      }
    }

    const sizes = await getBoxSizes();
    const created = [];
    for (let i = 0; i < input.quantity; i++) {
      const seq = await nextSequence("boxSeq", tx);
      const barcode = `BX${String(seq).padStart(8, "0")}`;
      const override = input.overrides?.find((o) => o.index === i);
      const box = await tx.box.create({
        data: {
          boxNumber: barcode,
          barcode,
          clientId: input.clientId,
          clientName: input.clientName,
          description: override?.description ?? input.description,
          department: input.department || undefined,
          reference: override?.reference ?? (input.reference || undefined),
          filingDateFrom: toDate(input.filingDateFrom),
          filingDateTo: toDate(input.filingDateTo) || undefined,
          destroyAfter: toDate(input.destroyAfter) || undefined,
          size: input.size,
          lengthCm: sizes[input.size] ?? sizes.standard,
          status: "unallocated",
          onHold: false,
          labelPrinted: false,
          createdBy: actor,
        },
      });
      await appendAuditEvent(box, "registered", actor, { orderId: input.orderId, orderNumber: input.orderNumber }, tx);
      created.push(serializeBox(box));
    }

    // Order se link karo: har naye box ki ek OrderLine ("received" -- collection me box mil chuka hai),
    // phir order ka boxCount aur lineSummary refresh, taaki order screen par count/progress sahi dikhe.
    if (linkedOrder) {
      await tx.orderLine.createMany({
        data: created.map((box) => ({ orderId: linkedOrder.id, boxId: box.id, boxNumber: box.boxNumber, status: "received" })),
      });
      await tx.order.update({ where: { id: linkedOrder.id }, data: { boxCount: { increment: created.length } } });
      await recomputeLineSummary(linkedOrder.id, tx);
    }
    return created;
  }, TX_OPTIONS);
}

async function markLabelsPrinted(boxIds, actor) {
  await prisma.$transaction(async (tx) => {
    for (const boxId of boxIds) {
      const box = await tx.box.findUnique({ where: { id: boxId } });
      if (!box || box.labelPrinted) continue;
      await tx.box.update({ where: { id: boxId }, data: { labelPrinted: true } });
      await appendAuditEvent(box, "label_printed", actor, {}, tx);
    }
  }, TX_OPTIONS);
}

const FIELD_LABELS = {
  description: "description",
  department: "department",
  reference: "reference",
  filingDateFrom: "filing date from",
  filingDateTo: "filing date to",
  destroyAfter: "destroy after",
};
const DATE_FIELDS = new Set(["filingDateFrom", "filingDateTo", "destroyAfter"]);

async function updateBoxDetails(boxId, patch, reason, actor) {
  const box = await prisma.box.findUnique({ where: { id: boxId } });
  if (!box) throw httpError(404, "Box not found");

  const changes = [];
  const data = {};
  for (const key of Object.keys(FIELD_LABELS)) {
    const nextValue = patch[key];
    if (nextValue === undefined) continue;
    const currentValue = (DATE_FIELDS.has(key) ? dateOnly(box[key]) : box[key]) ?? undefined;
    if (nextValue === currentValue) continue;
    changes.push({ field: FIELD_LABELS[key], from: currentValue, to: nextValue });
    data[key] = DATE_FIELDS.has(key) ? toDate(nextValue) : nextValue;
  }

  if (changes.length === 0) return serializeBox(box);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.box.update({ where: { id: boxId }, data });
    await appendAuditEvent(updated, "details_edited", actor, { changes, note: reason }, tx);
    return serializeBox(updated);
  }, TX_OPTIONS);
}

async function placeBoxHold(boxId, reason, actor) {
  const box = await prisma.box.findUnique({ where: { id: boxId } });
  if (!box) throw httpError(404, "Box not found");
  return prisma.$transaction(async (tx) => {
    const updated = await tx.box.update({ where: { id: boxId }, data: { onHold: true, holdReason: reason } });
    await appendAuditEvent(updated, "hold_placed", actor, { note: reason }, tx);
    return serializeBox(updated);
  }, TX_OPTIONS);
}

async function releaseBoxHold(boxId, actor) {
  const box = await prisma.box.findUnique({ where: { id: boxId } });
  if (!box) throw httpError(404, "Box not found");
  return prisma.$transaction(async (tx) => {
    const updated = await tx.box.update({ where: { id: boxId }, data: { onHold: false, holdReason: null } });
    await appendAuditEvent(updated, "hold_released", actor, {}, tx);
    return serializeBox(updated);
  }, TX_OPTIONS);
}

// A missing box stops counting as stored: its slot space is freed, it leaves the slot and can't go on any order.
// It stays visible (status "missing", with the reason) until someone finds it and places it in a slot again.
async function markBoxMissing(boxId, note, actor) {
  const reason = String(note || "").trim();
  if (!reason) throw httpError(400, "A reason is required to mark a box missing");
  return prisma.$transaction(async (tx) => {
    const box = await tx.box.findUnique({ where: { id: boxId } });
    if (!box) throw httpError(404, "Box not found");
    if (box.status === "missing") throw httpError(409, `${box.boxNumber} is already marked missing`);
    if (box.status === "destroyed") throw httpError(400, `${box.boxNumber} is destroyed`);
    // On an open order? Its line becomes "missing" so the order can still be finished without this box.
    const openOrder = box.openOrderId ? await tx.order.findUnique({ where: { id: box.openOrderId } }) : null;
    await releaseBoxSlot(box, tx);
    const updated = await tx.box.update({
      where: { id: boxId },
      data: {
        status: "missing",
        missingReason: reason,
        missingAt: new Date(),
        ...RELEASED_BOX_FIELDS,
        openOrderId: null,
        openOrder: Prisma.DbNull,
      },
    });
    if (openOrder) {
      await tx.orderLine.updateMany({ where: { orderId: openOrder.id, boxId }, data: { status: "missing" } });
      await recomputeLineSummary(openOrder.id, tx);
      await appendAuditEvent(
        updated,
        "removed_from_order",
        actor,
        { orderId: openOrder.id, orderNumber: openOrder.orderNumber, note: "Box is missing" },
        tx
      );
    }
    await appendAuditEvent(updated, "marked_missing", actor, { note: reason, fromLocation: box.locationPath ?? undefined }, tx);
    return serializeBox(updated);
  }, TX_OPTIONS);
}

module.exports = {
  searchBoxes,
  getBoxById,
  getOrdersForBox,
  createBoxesBatch,
  markLabelsPrinted,
  updateBoxDetails,
  placeBoxHold,
  releaseBoxHold,
  markBoxMissing,
};
