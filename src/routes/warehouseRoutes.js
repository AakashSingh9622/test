const express = require("express");
const {
  listWarehouses,
  createWarehouse,
  getWarehouse,
  listRacks,
  createRack,
  getWarehouseLayout,
  createZone,
  createAisle,
} = require("../controllers/locationController");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");
const { actorFromReq } = require("../utils/actor");
const { importLayout } = require("../services/layoutImportService");

const router = express.Router();

// Sab kuch login ke baad hi -- (warehouse list / racks / slots pehle bina login ke khule the).
router.use(requireAuth);

router.get("/", asyncHandler(listWarehouses));
// Naya warehouse / rack (uska poora slot grid bhi yahin auto-ban jaata hai) -- layout.manage chahiye.
router.post("/", requirePermission("layout.manage"), asyncHandler(createWarehouse));
// Whole layout from a sheet: one row per shelf (Docbox "Importacion de Almacen"). All-or-nothing check first.
router.post(
  "/import-layout",
  requirePermission("layout.manage"),
  asyncHandler(async (req, res) => res.status(req.body?.dryRun ? 200 : 201).json(await importLayout(req.body || {}, actorFromReq(req))))
);
router.get("/:warehouseId", asyncHandler(getWarehouse));
router.get("/:warehouseId/racks", asyncHandler(listRacks));
router.post("/:warehouseId/racks", requirePermission("layout.manage"), asyncHandler(createRack));
// Zones -> aisles -> racks with capacity, in one call (browse picker + warehouse page). Zones / aisles are optional.
router.get("/:warehouseId/layout", asyncHandler(getWarehouseLayout));
router.post("/:warehouseId/zones", requirePermission("layout.manage"), asyncHandler(createZone));
router.post("/:warehouseId/aisles", requirePermission("layout.manage"), asyncHandler(createAisle));

module.exports = router;
