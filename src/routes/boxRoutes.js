// Box routes -- app.js inhe "/api/boxes" par mount karta hai. Sab routes requireAuth (koi bhi
// logged-in staff) -- mock ki tarah hi, koi role-specific restriction nahi (UI khud button
// chhupati hai staff_admin-only actions ke liye, API khud nahi rokti).
const express = require("express");
const {
  listBoxes,
  getBox,
  getBoxOrders,
  createBoxesBatch,
  markLabelsPrinted,
  allocateBatch,
  updateBoxDetails,
  placeBoxHold,
  releaseBoxHold,
  markBoxMissing,
} = require("../controllers/boxController");
const { requireAuth } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();
router.use(requireAuth);

router.get("/", asyncHandler(listBoxes));
router.post("/batch", asyncHandler(createBoxesBatch));
router.post("/mark-label-printed", asyncHandler(markLabelsPrinted));
router.post("/allocate-batch", asyncHandler(allocateBatch));
router.get("/:boxId", asyncHandler(getBox));
router.get("/:boxId/orders", asyncHandler(getBoxOrders));
router.patch("/:boxId", asyncHandler(updateBoxDetails));
router.post("/:boxId/hold", asyncHandler(placeBoxHold));
router.delete("/:boxId/hold", asyncHandler(releaseBoxHold));
router.post("/:boxId/missing", asyncHandler(markBoxMissing));

module.exports = router;
