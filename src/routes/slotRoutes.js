const express = require("express");
const { patchSlot } = require("../controllers/locationController");
const { suggestSlots } = require("../controllers/boxController");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/requireRole");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();

// Sab kuch login ke baad hi.
router.use(requireAuth);

// Register-box/move-box wizard ka "suggest me a slot" step -- staff login chahiye.
router.post("/suggest", asyncHandler(suggestSlots));
// Slot block / capacity badalna warehouse-layout change hai -- sirf staff_admin (pehle bina login ke bhi chal jaata tha).
router.patch("/:slotId", requireRole("staff_admin"), asyncHandler(patchSlot));

module.exports = router;
