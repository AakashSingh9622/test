// Box routes -- app.js inhe "/api/boxes" par mount karta hai. Padhna: koi bhi logged-in staff. Badalna:
// permission chahiye (src/auth/permissions.js) -- boxes.operate, aur hold ke liye boxes.hold.
const express = require("express");
const {
  listBoxes,
  getBox,
  getBoxOrders,
  getBoxMovements,
  createBoxesBatch,
  markLabelsPrinted,
  allocateBatch,
  updateBoxDetails,
  placeBoxHold,
  releaseBoxHold,
  markBoxMissing,
} = require("../controllers/boxController");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();
router.use(requireAuth);

const operate = requirePermission("boxes.operate");

router.get("/", asyncHandler(listBoxes));
router.post("/batch", operate, asyncHandler(createBoxesBatch));
router.post("/mark-label-printed", operate, asyncHandler(markLabelsPrinted));
router.post("/allocate-batch", operate, asyncHandler(allocateBatch));
router.get("/:boxId", asyncHandler(getBox));
router.get("/:boxId/orders", asyncHandler(getBoxOrders));
router.get("/:boxId/movements", asyncHandler(getBoxMovements));
router.patch("/:boxId", operate, asyncHandler(updateBoxDetails));
router.post("/:boxId/hold", requirePermission("boxes.hold"), asyncHandler(placeBoxHold));
router.delete("/:boxId/hold", requirePermission("boxes.hold"), asyncHandler(releaseBoxHold));
router.post("/:boxId/missing", operate, asyncHandler(markBoxMissing));

module.exports = router;
