const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const { getRack, patchRack, getRackRows, listSlots } = require("../controllers/locationController");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();

// Sab kuch login ke baad hi (pehle GET routes bina login ke khule the).
router.use(requireAuth);

router.get("/:rackId", asyncHandler(getRack));
router.get("/:rackId/slots", asyncHandler(listSlots));
router.get("/:rackId/rows", asyncHandler(getRackRows));
// Rack ki cell length badalna -- warehouse layout change.
router.patch("/:rackId", requirePermission("layout.manage"), asyncHandler(patchRack));

module.exports = router;
