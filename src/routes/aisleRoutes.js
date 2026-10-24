const express = require("express");
const { patchAisle, removeAisle } = require("../controllers/locationController");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();

router.use(requireAuth);

// Rename / move to another zone / remove an aisle (one with racks can't be removed) -- warehouse layout change.
router.patch("/:aisleId", requirePermission("layout.manage"), asyncHandler(patchAisle));
router.delete("/:aisleId", requirePermission("layout.manage"), asyncHandler(removeAisle));

module.exports = router;
