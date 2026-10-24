// Supervisor queue (spec §6.3): a scan that doesn't match (wrong box, unknown barcode, full / unavailable slot) is
// refused AND recorded here, never silently corrected. recordException is called outside the failing request's
// transaction (plain prisma, not tx), so the record stays even though the scan itself was rolled back.
const prisma = require("../config/prisma");
const httpError = require("../utils/httpError");
const { serializeSimple } = require("../utils/serialize");
const { parsePagination } = require("../utils/pagination");

async function recordException(type, actor, { message, orderId, orderNumber, boxId, boxBarcode, slotId, slotBarcode } = {}) {
  try {
    await prisma.operationException.create({
      data: {
        type,
        message: String(message || type).slice(0, 1000),
        orderId: orderId ?? undefined,
        orderNumber: orderNumber ?? undefined,
        boxId: boxId ?? undefined,
        boxBarcode: boxBarcode ?? undefined,
        slotId: slotId ?? undefined,
        slotBarcode: slotBarcode ?? undefined,
        createdBy: actor,
      },
    });
  } catch (err) {
    // The scan is refused anyway; failing to queue it must not hide the real error from the operator.
    console.error("recordException failed:", err);
  }
}

// Throws an HTTP error AND queues the exception -- the one-liner used by the scan flows.
async function refuseAndRecord(status, type, actor, details) {
  await recordException(type, actor, details);
  throw httpError(status, details.message);
}

async function listExceptions(params = {}) {
  const where = {};
  if (params.status) where.status = params.status;
  if (params.orderId) where.orderId = params.orderId;
  const { skip, take } = parsePagination(params);
  const [items, total, open] = await Promise.all([
    prisma.operationException.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip, take }),
    prisma.operationException.count({ where }),
    prisma.operationException.count({ where: { status: "open" } }),
  ]);
  return { items: items.map(serializeSimple), total, open };
}

async function resolveException(id, resolution, actor) {
  const text = String(resolution || "").trim();
  if (!text) throw httpError(400, "Say how it was resolved");
  const changed = await prisma.operationException.updateMany({
    where: { id, status: "open" },
    data: { status: "resolved", resolution: text.slice(0, 1000), resolvedBy: actor, resolvedAt: new Date() },
  });
  const row = await prisma.operationException.findUnique({ where: { id } });
  if (!row) throw httpError(404, "Exception not found");
  if (changed.count !== 1) throw httpError(409, "This exception is already resolved");
  return serializeSimple(row);
}

module.exports = { recordException, refuseAndRecord, listExceptions, resolveException };
