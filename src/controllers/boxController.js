// HTTP layer for Boxes -- response shapes match frontend ke frontend/src/api/boxes.ts exactly.
const boxService = require("../services/boxService");
const { allocateBoxes } = require("../services/boxAllocationService");
const { suggestSlotsForBoxes } = require("../services/slotSuggestionService");
const { actorFromReq } = require("../utils/actor");

function parseStatusArray(q) {
  if (!q.status) return undefined;
  return Array.isArray(q.status) ? q.status : [q.status];
}

async function listBoxes(req, res) {
  const q = req.query;
  const result = await boxService.searchBoxes({
    q: q.q,
    clientId: q.clientId,
    status: parseStatusArray(q),
    onHold: q.onHold === undefined ? undefined : q.onHold === "true",
    warehouseId: q.warehouseId,
    rackId: q.rackId,
    row: q.row ? Number(q.row) : undefined,
    orderId: q.orderId,
    page: q.page ? Number(q.page) : undefined,
    pageSize: q.pageSize ? Number(q.pageSize) : undefined,
  });
  res.json(result);
}

async function getBox(req, res) {
  const box = await boxService.getBoxById(req.params.boxId);
  if (!box) return res.status(404).json({ message: "Box not found" });
  res.json(box);
}

async function getBoxOrders(req, res) {
  res.json(await boxService.getOrdersForBox(req.params.boxId));
}

async function createBoxesBatch(req, res) {
  const { clientId, clientName, quantity, description, filingDateFrom } = req.body || {};
  if (!clientId || !clientName || !quantity || !description || !filingDateFrom) {
    return res.status(400).json({
      message: "clientId, clientName, quantity, description, and filingDateFrom are required",
    });
  }
  const boxes = await boxService.createBoxesBatch(req.body, actorFromReq(req));
  res.status(201).json(boxes);
}

async function markLabelsPrinted(req, res) {
  const { boxIds } = req.body || {};
  if (!Array.isArray(boxIds) || boxIds.length === 0) {
    return res.status(400).json({ message: "boxIds (non-empty array) is required" });
  }
  await boxService.markLabelsPrinted(boxIds, actorFromReq(req));
  res.json({ ok: true });
}

async function suggestSlots(req, res) {
  const { clientId, boxSizes } = req.body || {};
  if (!clientId || !Array.isArray(boxSizes) || boxSizes.length === 0) {
    return res.status(400).json({ message: "clientId and boxSizes (non-empty array) are required" });
  }
  res.json(await suggestSlotsForBoxes(req.body));
}

async function allocateBatch(req, res) {
  const { allocations } = req.body || {};
  if (!Array.isArray(allocations) || allocations.length === 0) {
    return res.status(400).json({ message: "allocations (non-empty array) is required" });
  }
  res.json(await allocateBoxes(req.body, actorFromReq(req)));
}

async function updateBoxDetails(req, res) {
  const { reason, ...patch } = req.body || {};
  if (!reason) return res.status(400).json({ message: "reason is required" });
  res.json(await boxService.updateBoxDetails(req.params.boxId, patch, reason, actorFromReq(req)));
}

async function placeBoxHold(req, res) {
  const { reason } = req.body || {};
  if (!reason) return res.status(400).json({ message: "reason is required" });
  res.json(await boxService.placeBoxHold(req.params.boxId, reason, actorFromReq(req)));
}

async function releaseBoxHold(req, res) {
  res.json(await boxService.releaseBoxHold(req.params.boxId, actorFromReq(req)));
}

async function markBoxMissing(req, res) {
  const { note } = req.body || {};
  if (!note) return res.status(400).json({ message: "note is required" });
  res.json(await boxService.markBoxMissing(req.params.boxId, note, actorFromReq(req)));
}

module.exports = {
  listBoxes,
  getBox,
  getBoxOrders,
  createBoxesBatch,
  markLabelsPrinted,
  suggestSlots,
  allocateBatch,
  updateBoxDetails,
  placeBoxHold,
  releaseBoxHold,
  markBoxMissing,
};
