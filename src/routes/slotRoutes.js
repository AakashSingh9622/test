const express = require("express");
const { patchSlot } = require("../controllers/locationController");
const { suggestSlots } = require("../controllers/boxController");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();

// Sab kuch login ke baad hi.
router.use(requireAuth);

// Register-box/move-box wizard ka "suggest me a slot" step -- sirf padhta hai, koi bhi staff.
router.post("/suggest", asyncHandler(suggestSlots));
// Slot block / capacity badalna warehouse-layout change hai.
router.patch("/:slotId", requirePermission("layout.manage"), asyncHandler(patchSlot));

module.exports = router;
