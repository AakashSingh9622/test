// HTTP layer for Orders -- response shapes match frontend ke frontend/src/api/orders.ts exactly.
const orderService = require("../services/orderService");
const { actorFromReq } = require("../utils/actor");
const { can } = require("../auth/permissions");
const certificates = require("../services/certificateService");

function parseStatusArray(q) {
  if (!q.status) return undefined;
  return Array.isArray(q.status) ? q.status : [q.status];
}

async function listOrders(req, res) {
  const q = req.query;
  res.json(
    await orderService.searchOrders({
      type: q.type,
      status: parseStatusArray(q),
      clientId: q.clientId,
      contactEmail: q.contactEmail,
      q: q.q,
      page: q.page,
      pageSize: q.pageSize,
    })
  );
}

async function getOrder(req, res) {
  const order = await orderService.getOrderById(req.params.orderId);
  if (!order) return res.status(404).json({ message: "Order not found" });
  res.json(order);
}

async function getOrderLines(req, res) {
  res.json(await orderService.getOrderLines(req.params.orderId));
}

async function createOrder(req, res) {
  const { type, clientId, clientName } = req.body || {};
  if (!type || !clientId || !clientName) {
    return res.status(400).json({ message: "type, clientId, and clientName are required" });
  }
  // Client ki authorisation create ke saath hi record karna = wahi kaam jo authorise-* endpoints karte hain.
  const { destructionAuthorisation, digitizationAuthorisation } = req.body;
  if ((destructionAuthorisation || digitizationAuthorisation) && !can(req.user.roles, "orders.authorise")) {
    return res.status(403).json({ status: false, code: "forbidden", message: "You can't record a client's authorisation -- leave it for a records manager" });
  }
  const order = await orderService.createOrder({ ...req.body, requestedVia: "staff" }, actorFromReq(req));
  res.status(201).json(order);
}

async function approveOrder(req, res) {
  res.json(await orderService.approveOrder(req.params.orderId));
}

async function rejectOrder(req, res) {
  const { reason } = req.body || {};
  if (!reason) return res.status(400).json({ message: "reason is required" });
  res.json(await orderService.rejectOrder(req.params.orderId, reason, actorFromReq(req)));
}

async function scheduleOrder(req, res) {
  const { scheduledFor } = req.body || {};
  if (!scheduledFor) return res.status(400).json({ message: "scheduledFor is required" });
  res.json(await orderService.scheduleOrder(req.params.orderId, scheduledFor));
}

async function startOrder(req, res) {
  res.json(await orderService.startOrder(req.params.orderId));
}

async function cancelOrder(req, res) {
  const { reason } = req.body || {};
  if (!reason) return res.status(400).json({ message: "reason is required" });
  res.json(await orderService.cancelOrder(req.params.orderId, reason, actorFromReq(req)));
}

async function dispatchOrder(req, res) {
  const { recipientName } = req.body || {};
  if (!recipientName) return res.status(400).json({ message: "recipientName is required" });
  const { courier, trackingRef } = req.body;
  res.json(await orderService.dispatchOrder(req.params.orderId, recipientName, actorFromReq(req), { courier, trackingRef }));
}

async function authoriseDestruction(req, res) {
  const { name, method } = req.body || {};
  if (!name || !method) return res.status(400).json({ message: "name and method are required" });
  res.json(await orderService.authoriseDestruction(req.params.orderId, req.body, actorFromReq(req)));
}

async function authoriseDigitization(req, res) {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ message: "name is required" });
  res.json(await orderService.authoriseDigitization(req.params.orderId, req.body, actorFromReq(req)));
}

async function digitizeOrder(req, res) {
  res.json(await orderService.digitizeOrder(req.params.orderId, actorFromReq(req)));
}

async function destroyOrder(req, res) {
  const { witness } = req.body || {};
  res.json(await orderService.destroyOrder(req.params.orderId, witness, actorFromReq(req), { place: (req.body || {}).place }));
}

async function completeOrder(req, res) {
  res.json(await orderService.completeOrder(req.params.orderId, actorFromReq(req), { warehouseId: (req.body || {}).warehouseId }));
}

async function approveDestruction(req, res) {
  res.json(await orderService.approveDestruction(req.params.orderId, actorFromReq(req)));
}

async function recordDelivery(req, res) {
  res.json(await orderService.recordDelivery(req.params.orderId, req.body || {}, actorFromReq(req)));
}

async function getCertificate(req, res) {
  res.json(await certificates.getForOrder(req.params.orderId));
}

async function holdOrder(req, res) {
  res.json(await orderService.holdOrder(req.params.orderId, (req.body || {}).reason, actorFromReq(req)));
}

async function resumeOrder(req, res) {
  res.json(await orderService.resumeOrder(req.params.orderId));
}

async function getPickList(req, res) {
  res.json(await orderService.getPickList(req.params.orderId));
}

async function pickBox(req, res) {
  res.json(await orderService.pickBox(req.params.orderId, (req.body || {}).barcode, actorFromReq(req)));
}

async function receiveReturnBox(req, res) {
  const { barcode, warehouseId } = req.body || {};
  res.json(await orderService.receiveReturnBox(req.params.orderId, barcode, warehouseId, actorFromReq(req)));
}

module.exports = {
  listOrders,
  getOrder,
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
  approveDestruction,
  recordDelivery,
  getCertificate,
  getPickList,
  pickBox,
  receiveReturnBox,
};
