const express = require("express");
const {
  listWarehouses,
  createWarehouse,
  getWarehouse,
  listRacks,
  createRack,
} = require("../controllers/locationController");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/requireRole");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();

// Sab kuch login ke baad hi -- (warehouse list / racks / slots pehle bina login ke khule the).
router.use(requireAuth);

router.get("/", asyncHandler(listWarehouses));
// Naya warehouse sirf staff_admin add kar sakta hai -- staff_operator read-only hai is par.
router.post("/", requireAuth, requireRole("staff_admin"), asyncHandler(createWarehouse));
router.get("/:warehouseId", asyncHandler(getWarehouse));
router.get("/:warehouseId/racks", asyncHandler(listRacks));
// Naya rack sirf staff_admin add kar sakta hai -- uska poora slot grid bhi yahin auto-ban jaata hai.
router.post("/:warehouseId/racks", requireAuth, requireRole("staff_admin"), asyncHandler(createRack));

module.exports = router;
