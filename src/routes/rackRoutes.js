const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const { getRack, patchRack, getRackRows, listSlots, addRackShelf, removeRackShelf, removeRack } = require("../controllers/locationController");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();

// Sab kuch login ke baad hi (pehle GET routes bina login ke khule the).
router.use(requireAuth);

router.get("/:rackId", asyncHandler(getRack));
router.get("/:rackId/slots", asyncHandler(listSlots));
router.get("/:rackId/rows", asyncHandler(getRackRows));
// Rack ki cell length badalna -- warehouse layout change.
router.patch("/:rackId", requirePermission("layout.manage"), asyncHandler(patchRack));
// Docbox "Fila / Balda": add a shelf on top, remove the last (empty) one, or delete the whole (empty) module.
router.post("/:rackId/shelves", requirePermission("layout.manage"), asyncHandler(addRackShelf));
router.delete("/:rackId/shelves/last", requirePermission("layout.manage"), asyncHandler(removeRackShelf));
router.delete("/:rackId", requirePermission("layout.manage"), asyncHandler(removeRack));

module.exports = router;
