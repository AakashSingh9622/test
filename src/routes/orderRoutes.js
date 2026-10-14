// Order routes -- app.js inhe "/api/orders" par mount karta hai.
const express = require("express");
const {
  listOrders,
  getOrder,
  getOrderLines,
  createOrder,
  approveOrder,
  rejectOrder,
  scheduleOrder,
  startOrder,
  cancelOrder,
  dispatchOrder,
  authoriseDestruction,
  destroyOrder,
  authoriseDigitization,
  digitizeOrder,
  completeOrder,
} = require("../controllers/orderController");
const { requireAuth } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();
router.use(requireAuth);

router.get("/", asyncHandler(listOrders));
router.post("/", asyncHandler(createOrder));
router.get("/:orderId", asyncHandler(getOrder));
router.get("/:orderId/lines", asyncHandler(getOrderLines));
router.post("/:orderId/approve", asyncHandler(approveOrder));
router.post("/:orderId/reject", asyncHandler(rejectOrder));
router.post("/:orderId/schedule", asyncHandler(scheduleOrder));
router.post("/:orderId/start", asyncHandler(startOrder));
router.post("/:orderId/cancel", asyncHandler(cancelOrder));
router.post("/:orderId/dispatch", asyncHandler(dispatchOrder));
router.post("/:orderId/authorise-destruction", asyncHandler(authoriseDestruction));
router.post("/:orderId/destroy", asyncHandler(destroyOrder));
router.post("/:orderId/authorise-digitization", asyncHandler(authoriseDigitization));
router.post("/:orderId/digitize", asyncHandler(digitizeOrder));
router.post("/:orderId/complete", asyncHandler(completeOrder));

module.exports = router;
