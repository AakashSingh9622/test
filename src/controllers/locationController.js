// HTTP layer for Warehouse/Rack/Slot -- response shapes match frontend ke
// frontend/src/mocks/handlers/locations.ts exactly.
const locationService = require("../services/locationService");
const { actorFromReq } = require("../utils/actor");

async function listWarehouses(_req, res) {
  res.json(await locationService.listWarehouses());
}

async function createWarehouse(req, res) {
  const { code, name, address, site } = req.body || {};
  if (!code || !name) {
    return res.status(400).json({ message: "code and name are required" });
  }
  const warehouse = await locationService.createWarehouse({ code, name, address, site }, actorFromReq(req));
  res.status(201).json(warehouse);
}

async function patchWarehouse(req, res) {
  const { name, address, site } = req.body || {};
  if (name === undefined && address === undefined && site === undefined) {
    return res.status(400).json({ message: "Send name, address or site" });
  }
  res.json(await locationService.updateWarehouse(req.params.warehouseId, { name, address, site }, actorFromReq(req)));
}

async function removeWarehouse(req, res) {
  res.json(await locationService.deleteWarehouse(req.params.warehouseId, actorFromReq(req)));
}

async function addRackShelf(req, res) {
  res.status(201).json(await locationService.addShelf(req.params.rackId, actorFromReq(req)));
}

async function removeRackShelf(req, res) {
  res.json(await locationService.removeLastShelf(req.params.rackId, actorFromReq(req)));
}

async function removeRack(req, res) {
  res.json(await locationService.deleteRack(req.params.rackId, actorFromReq(req)));
}

async function getWarehouse(req, res) {
  const warehouse = await locationService.getWarehouseById(req.params.warehouseId);
  if (!warehouse) return res.status(404).json({ message: "Warehouse not found" });
  res.json(warehouse);
}

async function listRacks(req, res) {
  res.json(await locationService.listRacksForWarehouse(req.params.warehouseId));
}

async function createRack(req, res) {
  const { code, label, rows, columns, cellLength, cellHeight, cellDepth, lengthUnit, zoneId, aisleId } = req.body || {};
  if (!code || !label || !rows || !columns || !cellLength) {
    return res.status(400).json({ message: "code, label, rows, columns, and cellLength are required" });
  }
  if (lengthUnit !== undefined && !["cm", "ft"].includes(lengthUnit)) {
    return res.status(400).json({ message: 'lengthUnit must be "cm" or "ft"' });
  }
  if (!(Number(cellLength) > 0)) {
    return res.status(400).json({ message: "cellLength must be a positive number" });
  }
  // Height and depth are optional only for older callers (then 50 cm, what every cell had before they existed).
  for (const [name, v] of [["cellHeight", cellHeight], ["cellDepth", cellDepth]]) {
    if (v !== undefined && !(Number(v) > 0)) return res.status(400).json({ message: `${name} must be a positive number` });
  }
  const warehouse = await locationService.getWarehouseById(req.params.warehouseId);
  if (!warehouse) return res.status(404).json({ message: "Warehouse not found" });

  const rack = await locationService.createRack(req.params.warehouseId, {
    code,
    label,
    rows: Number(rows),
    columns: Number(columns),
    cellLength: Number(cellLength),
    cellHeight: cellHeight === undefined ? undefined : Number(cellHeight),
    cellDepth: cellDepth === undefined ? undefined : Number(cellDepth),
    lengthUnit: lengthUnit || "cm",
    zoneId,
    aisleId,
  }, actorFromReq(req));
  res.status(201).json(rack);
}

async function getRack(req, res) {
  const rack = await locationService.getRackById(req.params.rackId);
  if (!rack) return res.status(404).json({ message: "Module not found" });
  res.json(rack);
}

// Any of: cellLength / cellHeight / cellDepth (+ lengthUnit), label, zoneId, aisleId (null / "" = take it out of its zone / aisle).
async function patchRack(req, res) {
  const { cellLength, cellHeight, cellDepth, lengthUnit, label, zoneId, aisleId } = req.body || {};
  const sizeGiven = cellLength !== undefined || cellHeight !== undefined || cellDepth !== undefined;
  if (!sizeGiven && label === undefined && zoneId === undefined && aisleId === undefined) {
    return res.status(400).json({ message: "Send cellLength, cellHeight, cellDepth, label, zoneId or aisleId" });
  }
  for (const [name, v] of [["cellLength", cellLength], ["cellHeight", cellHeight], ["cellDepth", cellDepth]]) {
    if (v !== undefined && !(Number(v) > 0)) return res.status(400).json({ message: `${name} must be a positive number` });
  }
  if (lengthUnit !== undefined && !["cm", "ft"].includes(lengthUnit)) {
    return res.status(400).json({ message: 'lengthUnit must be "cm" or "ft"' });
  }
  const rack = await locationService.updateRack(req.params.rackId, {
    cellLength: cellLength === undefined ? undefined : Number(cellLength),
    cellHeight: cellHeight === undefined ? undefined : Number(cellHeight),
    cellDepth: cellDepth === undefined ? undefined : Number(cellDepth),
    lengthUnit: lengthUnit || "cm",
    label,
    zoneId,
    aisleId,
  }, actorFromReq(req));
  if (!rack) return res.status(404).json({ message: "Module not found" });
  res.json(rack);
}

async function getRackRows(req, res) {
  res.json(await locationService.rackRowStats(req.params.rackId));
}

async function listSlots(req, res) {
  res.json(await locationService.listSlotsForRack(req.params.rackId));
}

async function patchSlot(req, res) {
  // 404 / 400 / 409 service se aate hain (errorMiddleware); pehle har error "Slot not found" ban jaata tha.
  res.json(await locationService.updateSlot(req.params.slotId, req.body || {}, actorFromReq(req)));
}

// --- Zones, aisles, find by code (Sprint 10) ---

async function getWarehouseLayout(req, res) {
  const warehouse = await locationService.getWarehouseById(req.params.warehouseId);
  if (!warehouse) return res.status(404).json({ message: "Warehouse not found" });
  res.json(await locationService.warehouseLayout(req.params.warehouseId));
}

async function createZone(req, res) {
  const { code, name } = req.body || {};
  res.status(201).json(await locationService.createZone(req.params.warehouseId, { code, name }, actorFromReq(req)));
}

async function patchZone(req, res) {
  const { code, name } = req.body || {};
  res.json(await locationService.updateZone(req.params.zoneId, { code, name }, actorFromReq(req)));
}

async function removeZone(req, res) {
  await locationService.deleteZone(req.params.zoneId, actorFromReq(req));
  res.status(204).end();
}

async function createAisle(req, res) {
  const { code, name, zoneId } = req.body || {};
  res.status(201).json(await locationService.createAisle(req.params.warehouseId, { code, name, zoneId }, actorFromReq(req)));
}

async function patchAisle(req, res) {
  const { code, name, zoneId } = req.body || {};
  res.json(await locationService.updateAisle(req.params.aisleId, { code, name, zoneId }, actorFromReq(req)));
}

async function removeAisle(req, res) {
  await locationService.deleteAisle(req.params.aisleId, actorFromReq(req));
  res.status(204).end();
}

// GET /api/locations/resolve?code=B04-3&needCm=80&warehouseId=&rackId=
async function resolveLocation(req, res) {
  const { code, warehouseId, rackId, needCm } = req.query;
  res.json(
    await locationService.resolveLocation(code, {
      warehouseId: warehouseId || undefined,
      rackId: rackId || undefined,
      needCm: Number(needCm) || 0,
    })
  );
}

// GET /api/locations/racks?q=rac -- search-as-you-type by rack code or name
async function searchRacks(req, res) {
  res.json(await locationService.searchRacks(req.query.q, { warehouseId: req.query.warehouseId || undefined }));
}

module.exports = {
  getWarehouseLayout,
  createZone,
  patchZone,
  removeZone,
  createAisle,
  patchAisle,
  removeAisle,
  resolveLocation,
  searchRacks,
  listWarehouses,
  createWarehouse,
  patchWarehouse,
  removeWarehouse,
  addRackShelf,
  removeRackShelf,
  removeRack,
  getWarehouse,
  listRacks,
  createRack,
  getRack,
  patchRack,
  getRackRows,
  listSlots,
  patchSlot,
};
