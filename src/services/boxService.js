// Box registration, search, aur detail actions.
const prisma = require("../config/prisma");
const { Prisma } = prisma;
const { nextSequence } = require("./counterService");
const { appendAuditEvent } = require("./auditService");
const { appendMovement } = require("./movementService");
const { getBoxSizes, assertUsableSize } = require("./boxSizeService");
const { TX_OPTIONS, releaseBoxSlot, RELEASED_BOX_FIELDS, allocateBoxes, isActiveSlot } = require("./boxAllocationService");
const { recomputeLineSummary, goodsInPath, findBoxByCode } = require("./orderService");
const { recordException, refuseAndRecord } = require("./exceptionService");
const { resolveLocation } = require("./locationService");
const { boxLengthCm } = require("../utils/dimensions");
const { serializeBox, serializeOrder, serializeSimple, dateOnly, toDate } = require("../utils/serialize");
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

// Scan to see a box (Sprint 11): its current barcode or its box number, any case. (The box number is also the code of
// the box's first label, so an old label still finds the box here -- only for looking; scan operations use the current
// barcode only, see findBoxByCode.)
async function lookupBox(rawCode) {
  const code = String(rawCode || "").trim();
  if (!code) throw httpError(400, "Scan or type a box barcode");
  const box =
    (await findBoxByCode(code)) ??
    (await prisma.box.findFirst({
      where: { OR: [{ barcode: { equals: code, mode: "insensitive" } }, { boxNumber: { equals: code, mode: "insensitive" } }] },
    }));
  if (!box) throw httpError(404, `No box has the barcode ${code}`);
  return serializeBox(box);
}

// Jin orders me ye box kabhi shamil hua hai, unki list (box detail ka "Orders" tab).
async function getOrdersForBox(boxId) {
  const orders = await prisma.order.findMany({
    where: { lines: { some: { boxId } } },
    orderBy: { createdAt: "desc" },
  });
  return orders.map(serializeOrder);
}

// A retention category must be the code of a current retention rule (or empty).
async function checkRetentionCategory(value) {
  if (value === undefined || value === null || value === "") return null;
  const code = String(value).trim().toUpperCase();
  const rule = await prisma.retentionRule.findFirst({ where: { code, isCurrent: true } });
  if (!rule) throw httpError(400, `Unknown retention category "${code}" — add it under Records → Retention rules first`);
  return code;
}

// Naye boxes ek saath register karta hai (Register Boxes wizard, step 1) -- ek transaction me.
async function createBoxesBatch(input, actor) {
  const retentionCategory = await checkRetentionCategory(input.retentionCategory);
  const sizeCode = input.size || "standard";
  await assertUsableSize(sizeCode); // a size from Settings → Box sizes that isn't retired
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
          retentionCategory: retentionCategory ?? undefined,
          size: sizeCode,
          lengthCm: sizes[sizeCode] ?? sizes.standard,
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
  retentionCategory: "retention category",
};
const DATE_FIELDS = new Set(["filingDateFrom", "filingDateTo", "destroyAfter"]);

// Register wizard, back on step 1 after registering: the same correction applied to every box of the batch, in one
// transaction (one "details_edited" history event per box that changed). Client and size can only change while a box is
// not on a shelf and not tied to an order (its order line / slot space would be wrong otherwise).
const CORRECTION_NOTE = "Corrected during registration";
async function correctRegisteredBoxes({ boxIds, patch }, actor) {
  if (!Array.isArray(boxIds) || boxIds.length === 0) throw httpError(400, "boxIds is required");
  if (boxIds.length > 200) throw httpError(400, "At most 200 boxes at a time");
  if (patch.retentionCategory !== undefined) {
    patch = { ...patch, retentionCategory: (await checkRetentionCategory(patch.retentionCategory)) ?? undefined };
  }
  if (patch.size !== undefined) await assertUsableSize(patch.size);
  if (patch.clientId !== undefined && !String(patch.clientId).trim()) throw httpError(400, "clientId can't be empty");
  if (patch.description !== undefined && !String(patch.description).trim()) throw httpError(400, "description can't be empty");
  if (patch.filingDateFrom !== undefined && !patch.filingDateFrom) throw httpError(400, "filing date from is required");
  const sizes = patch.size !== undefined ? await getBoxSizes() : null;

  return prisma.$transaction(async (tx) => {
    const boxes = await tx.box.findMany({ where: { id: { in: boxIds } }, include: { _count: { select: { orderLines: true } } } });
    if (boxes.length !== new Set(boxIds).size) throw httpError(404, "Some of these boxes don't exist");
    const out = [];
    for (const box of boxes) {
      const changes = [];
      const data = {};
      for (const key of Object.keys(FIELD_LABELS)) {
        const nextValue = patch[key];
        if (nextValue === undefined) continue;
        const currentValue = (DATE_FIELDS.has(key) ? dateOnly(box[key]) : box[key]) ?? "";
        if ((nextValue ?? "") === currentValue) continue;
        changes.push({ field: FIELD_LABELS[key], from: currentValue || undefined, to: nextValue || undefined });
        data[key] = DATE_FIELDS.has(key) ? toDate(nextValue) : nextValue || null;
      }
      const movesClient = patch.clientId !== undefined && patch.clientId !== box.clientId;
      const resizes = patch.size !== undefined && patch.size !== box.size;
      if (movesClient || resizes) {
        if (box.slotId || box.openOrderId || box._count.orderLines > 0 || !["unallocated", "received"].includes(box.status)) {
          throw httpError(409, `${box.boxNumber} is already filed or on an order — its ${movesClient ? "client" : "size"} can't change now`);
        }
      }
      if (movesClient) {
        changes.push({ field: "client", from: box.clientName, to: patch.clientName || patch.clientId });
        data.clientId = patch.clientId;
        data.clientName = patch.clientName || patch.clientId;
      }
      if (resizes) {
        changes.push({ field: "size", from: box.size, to: patch.size });
        data.size = patch.size;
        data.lengthCm = sizes[patch.size] ?? sizes.standard;
      }
      if (!changes.length) {
        out.push(serializeBox(box));
        continue;
      }
      const updated = await tx.box.update({ where: { id: box.id }, data });
      await appendAuditEvent(updated, "details_edited", actor, { changes, note: CORRECTION_NOTE }, tx);
      out.push(serializeBox(updated));
    }
    const order = new Map(boxIds.map((id, i) => [id, i]));
    return out.sort((a, b) => order.get(a.id) - order.get(b.id));
  }, TX_OPTIONS);
}

async function updateBoxDetails(boxId, patch, reason, actor) {
  const box = await prisma.box.findUnique({ where: { id: boxId } });
  if (!box) throw httpError(404, "Box not found");
  if (patch.retentionCategory !== undefined) patch = { ...patch, retentionCategory: (await checkRetentionCategory(patch.retentionCategory)) ?? undefined };

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
    const box = await tx.box.findUnique({ where: { id: boxId }, include: { slot: { select: { id: true, warehouseId: true } } } });
    if (!box) throw httpError(404, "Box not found");
    if (box.status === "missing") throw httpError(409, `${box.boxNumber} is already marked missing`);
    if (box.status === "destroyed") throw httpError(400, `${box.boxNumber} is destroyed`);
    if (box.status === "permanently_withdrawn") throw httpError(400, `${box.boxNumber} was permanently withdrawn by the client`);
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
    await appendMovement(box, "marked_missing", actor, { from: box.slot, fromLocation: box.locationPath, reason }, tx);
    return serializeBox(updated);
  }, TX_OPTIONS);
}

// --- Goods-In, put-away by barcode (spec §6.1) ----------------------------------------------------------------------

// A registered box arrives at a warehouse: it waits at that warehouse's Goods-In ("received") until it is put away.
// Scanning it again at the same Goods-In is fine.
async function receiveAtGoodsIn(rawCode, warehouseId, actor) {
  const code = String(rawCode || "").trim();
  if (!code) throw httpError(400, "Scan or type a box barcode");
  if (!warehouseId) throw httpError(400, "Choose the warehouse the box arrived at");
  const warehouse = await prisma.warehouse.findUnique({ where: { id: warehouseId } });
  if (!warehouse) throw httpError(404, "Warehouse not found");
  const box = await findBoxByCode(code);
  if (!box) await refuseAndRecord(404, "box_not_found", actor, { boxBarcode: code, message: `No box has the barcode ${code}` });
  if (box.status === "received" && box.goodsInWarehouseId === warehouse.id) return { box: serializeBox(box), alreadyReceived: true };
  if (box.status === "return_pending") {
    throw httpError(409, `${box.boxNumber} is coming back on order ${box.openOrder?.orderNumber ?? ""} — receive it on that collection`);
  }
  if (box.status !== "unallocated") {
    throw httpError(409, `${box.boxNumber} is ${box.status.replace(/_/g, " ")} — only newly registered boxes are received at Goods-In`);
  }

  return prisma.$transaction(async (tx) => {
    const toLocation = goodsInPath(warehouse);
    const changed = await tx.box.updateMany({
      where: { id: box.id, status: "unallocated" },
      data: { status: "received", goodsInWarehouseId: warehouse.id, locationPath: toLocation },
    });
    if (changed.count !== 1) throw httpError(409, `${box.boxNumber} was changed by someone else — scan it again`);
    const updated = await tx.box.findUnique({ where: { id: box.id } });
    await appendMovement(box, "received", actor, { to: { id: undefined, warehouseId: warehouse.id }, toLocation }, tx);
    await appendAuditEvent(updated, "goods_in", actor, { toLocation, note: `Goods-In ${warehouse.code}` }, tx);
    return { box: serializeBox(updated), alreadyReceived: false };
  }, TX_OPTIONS);
}

// Scan the box, then the slot barcode -- or type a shelf / position code ("B04-3", "B04-3-2", Sprint 10): the box goes
// there (a shelf: its best-fitting position). Any mismatch is refused AND queued for a supervisor.
async function putAwayByBarcode({ boxBarcode, slotBarcode, reason }, actor) {
  const boxCode = String(boxBarcode || "").trim();
  const slotCode = String(slotBarcode || "").trim();
  if (!boxCode || !slotCode) throw httpError(400, "Scan the box and then the slot");
  const box = await findBoxByCode(boxCode);
  if (!box) await refuseAndRecord(404, "box_not_found", actor, { boxBarcode: boxCode, slotBarcode: slotCode, message: `No box has the barcode ${boxCode}` });
  const need = box.lengthCm ?? boxLengthCm(box);
  const ref = { boxId: box.id, boxBarcode: boxCode, slotBarcode: slotCode };
  let slot = await prisma.slot.findUnique({ where: { barcode: slotCode } });
  if (!slot) {
    const found = await resolveLocation(slotCode, { needCm: need });
    if (found.kind === "position") slot = found.positions[0];
    else if (found.kind === "shelf") {
      if (!found.suggestedSlotId) {
        await refuseAndRecord(409, "slot_full", actor, { ...ref, message: `No position on shelf ${slotCode} has ${need} cm free for ${box.boxNumber}` });
      }
      slot = found.positions.find((p) => p.id === found.suggestedSlotId);
    } else if (found.kind === "ambiguous") {
      await refuseAndRecord(409, "slot_not_found", actor, { ...ref, message: `${found.message} — scan the position label instead` });
    }
  }
  if (!slot) await refuseAndRecord(404, "slot_not_found", actor, { ...ref, message: `No slot or shelf has the code ${slotCode}` });
  ref.slotId = slot.id;
  if (!isActiveSlot(slot)) {
    await refuseAndRecord(409, "slot_unavailable", actor, { ...ref, message: `Slot ${slot.barcode} is ${slot.status} — choose another slot` });
  }
  if (["destroyed", "permanently_withdrawn", "return_pending"].includes(box.status)) {
    await refuseAndRecord(409, "box_unavailable", actor, {
      ...ref,
      message: `${box.boxNumber} is ${box.status.replace(/_/g, " ")} and can't be put away`,
    });
  }
  const free = slot.capacity - slot.used;
  if (box.slotId !== slot.id && free < need) {
    await refuseAndRecord(409, "slot_full", actor, { ...ref, message: `Slot ${slot.barcode} has ${free} cm free, ${box.boxNumber} needs ${need} cm` });
  }
  try {
    const [updated] = await allocateBoxes({ allocations: [{ boxId: box.id, slotId: slot.id }], reason }, actor);
    return { box: updated, slot: serializeSimple(await prisma.slot.findUnique({ where: { id: slot.id } })) };
  } catch (err) {
    // Filled up between the check and the move (someone else put a box there) -- still an exception to look at.
    if (/doesn't have room/.test(err.message)) await recordException("slot_full", actor, { ...ref, message: err.message });
    throw err;
  }
}

// --- Quarantine, re-label ------------------------------------------------------------------------------------------

// Damaged / under investigation: the box stays where it is but can't go on any order until released (spec §4.1).
async function quarantineBox(boxId, rawReason, actor) {
  const reason = String(rawReason || "").trim();
  if (!reason) throw httpError(400, "A reason is required to quarantine a box");
  return prisma.$transaction(async (tx) => {
    const box = await tx.box.findUnique({ where: { id: boxId } });
    if (!box) throw httpError(404, "Box not found");
    if (box.status === "quarantined") throw httpError(409, `${box.boxNumber} is already quarantined`);
    if (box.openOrderId) throw httpError(409, `${box.boxNumber} is on order ${box.openOrder?.orderNumber ?? ""} — take it off the order first`);
    if (!["stored", "digitized", "unallocated", "received"].includes(box.status)) {
      throw httpError(409, `${box.boxNumber} is ${box.status.replace(/_/g, " ")} — only a box that is with us can be quarantined`);
    }
    const updated = await tx.box.update({
      where: { id: boxId },
      data: { status: "quarantined", quarantineReason: reason.slice(0, 1000), quarantinedAt: new Date() },
    });
    await appendAuditEvent(updated, "quarantined", actor, { note: reason }, tx);
    return serializeBox(updated);
  }, TX_OPTIONS);
}

// Back to where it was: on a shelf -> stored (digitized if it was), at Goods-In -> received, else registered.
async function releaseQuarantine(boxId, actor) {
  return prisma.$transaction(async (tx) => {
    const box = await tx.box.findUnique({ where: { id: boxId } });
    if (!box) throw httpError(404, "Box not found");
    if (box.status !== "quarantined") throw httpError(409, `${box.boxNumber} is not quarantined`);
    const status = box.slotId ? (box.digitizedAt ? "digitized" : "stored") : box.goodsInWarehouseId ? "received" : "unallocated";
    const updated = await tx.box.update({ where: { id: boxId }, data: { status, quarantineReason: null, quarantinedAt: null } });
    await appendAuditEvent(updated, "quarantine_released", actor, { note: box.quarantineReason ?? undefined }, tx);
    return serializeBox(updated);
  }, TX_OPTIONS);
}

// A damaged / unreadable label: new barcode, SAME box (id, number, history). The old barcode stops working.
async function relabelBox(boxId, rawReason, actor) {
  const reason = String(rawReason || "").trim();
  if (!reason) throw httpError(400, "A reason is required to re-label a box");
  return prisma.$transaction(async (tx) => {
    const box = await tx.box.findUnique({ where: { id: boxId } });
    if (!box) throw httpError(404, "Box not found");
    if (box.status === "destroyed") throw httpError(400, `${box.boxNumber} is destroyed`);
    const seq = await nextSequence("boxSeq", tx);
    const barcode = `BX${String(seq).padStart(8, "0")}`;
    const updated = await tx.box.update({ where: { id: boxId }, data: { barcode, labelPrinted: false } });
    await appendAuditEvent(updated, "relabelled", actor, { changes: [{ field: "barcode", from: box.barcode, to: barcode }], note: reason }, tx);
    return serializeBox(updated);
  }, TX_OPTIONS);
}

module.exports = {
  receiveAtGoodsIn,
  putAwayByBarcode,
  correctRegisteredBoxes,
  quarantineBox,
  releaseQuarantine,
  relabelBox,
  searchBoxes,
  getBoxById,
  lookupBox,
  getOrdersForBox,
  createBoxesBatch,
  markLabelsPrinted,
  updateBoxDetails,
  placeBoxHold,
  releaseBoxHold,
  markBoxMissing,
};
