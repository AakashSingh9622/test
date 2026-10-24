const express = require("express");
const {
  listWarehouses,
  createWarehouse,
  getWarehouse,
  listRacks,
  createRack,
} = require("../controllers/locationController");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();

// Sab kuch login ke baad hi -- (warehouse list / racks / slots pehle bina login ke khule the).
router.use(requireAuth);

router.get("/", asyncHandler(listWarehouses));
// Naya warehouse / rack (uska poora slot grid bhi yahin auto-ban jaata hai) -- layout.manage chahiye.
router.post("/", requirePermission("layout.manage"), asyncHandler(createWarehouse));
router.get("/:warehouseId", asyncHandler(getWarehouse));
router.get("/:warehouseId/racks", asyncHandler(listRacks));
router.post("/:warehouseId/racks", requirePermission("layout.manage"), asyncHandler(createRack));

module.exports = router;
