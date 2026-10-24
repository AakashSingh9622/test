const express = require("express");
const { patchZone, removeZone } = require("../controllers/locationController");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();

router.use(requireAuth);

// Rename / remove a zone (one with racks or aisles can't be removed) -- warehouse layout change.
router.patch("/:zoneId", requirePermission("layout.manage"), asyncHandler(patchZone));
router.delete("/:zoneId", requirePermission("layout.manage"), asyncHandler(removeZone));

module.exports = router;
