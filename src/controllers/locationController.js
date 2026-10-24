// HTTP layer for Warehouse/Rack/Slot -- response shapes match frontend ke
// frontend/src/mocks/handlers/locations.ts exactly.
const locationService = require("../services/locationService");

async function listWarehouses(_req, res) {
  res.json(await locationService.listWarehouses());
}

async function createWarehouse(req, res) {
  const { code, name, address } = req.body || {};
  if (!code || !name) {
    return res.status(400).json({ message: "code and name are required" });
  }
  const warehouse = await locationService.createWarehouse({ code, name, address });
  res.status(201).json(warehouse);
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
  const { code, label, rows, columns, cellLength, lengthUnit } = req.body || {};
  if (!code || !label || !rows || !columns || !cellLength) {
    return res.status(400).json({ message: "code, label, rows, columns, and cellLength are required" });
  }
  if (lengthUnit !== undefined && !["cm", "ft"].includes(lengthUnit)) {
    return res.status(400).json({ message: 'lengthUnit must be "cm" or "ft"' });
  }
  if (!(Number(cellLength) > 0)) {
    return res.status(400).json({ message: "cellLength must be a positive number" });
  }
  const warehouse = await locationService.getWarehouseById(req.params.warehouseId);
  if (!warehouse) return res.status(404).json({ message: "Warehouse not found" });

  const rack = await locationService.createRack(req.params.warehouseId, {
    code,
    label,
    rows: Number(rows),
    columns: Number(columns),
    cellLength: Number(cellLength),
    lengthUnit: lengthUnit || "cm",
  });
  res.status(201).json(rack);
}

async function getRack(req, res) {
  const rack = await locationService.getRackById(req.params.rackId);
  if (!rack) return res.status(404).json({ message: "Rack not found" });
  res.json(rack);
}

async function patchRack(req, res) {
  const { cellLength, lengthUnit } = req.body || {};
  if (!(Number(cellLength) > 0)) {
    return res.status(400).json({ message: "cellLength must be a positive number" });
  }
  if (lengthUnit !== undefined && !["cm", "ft"].includes(lengthUnit)) {
    return res.status(400).json({ message: 'lengthUnit must be "cm" or "ft"' });
  }
  const rack = await locationService.updateRack(req.params.rackId, {
    cellLength: Number(cellLength),
    lengthUnit: lengthUnit || "cm",
  });
  if (!rack) return res.status(404).json({ message: "Rack not found" });
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
  res.json(await locationService.updateSlot(req.params.slotId, req.body || {}));
}

module.exports = {
  listWarehouses,
  createWarehouse,
  getWarehouse,
  listRacks,
  createRack,
  getRack,
  patchRack,
  getRackRows,
  listSlots,
  patchSlot,
};
