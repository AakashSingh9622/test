const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/requireRole");
const { getRack, patchRack, getRackRows, listSlots } = require("../controllers/locationController");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();

// Sab kuch login ke baad hi (pehle GET routes bina login ke khule the).
router.use(requireAuth);

router.get("/:rackId", asyncHandler(getRack));
router.get("/:rackId/slots", asyncHandler(listSlots));
router.get("/:rackId/rows", asyncHandler(getRackRows));
// Rack ki cell length badalna -- staff_admin-only (warehouse layout change).
router.patch("/:rackId", requireAuth, requireRole("staff_admin"), asyncHandler(patchRack));

module.exports = router;
