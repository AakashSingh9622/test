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
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();
router.use(requireAuth);

// Padhna: koi bhi staff. Badalna: src/auth/permissions.js ke hisaab se.
const operate = requirePermission("orders.operate");
const approve = requirePermission("orders.approve");
const authorise = requirePermission("orders.authorise");

router.get("/", asyncHandler(listOrders));
// (create me client ki authorisation bhi saath aaye to controller orders.authorise alag se check karta hai)
router.post("/", operate, asyncHandler(createOrder));
router.get("/:orderId", asyncHandler(getOrder));
router.get("/:orderId/lines", asyncHandler(getOrderLines));
router.post("/:orderId/approve", approve, asyncHandler(approveOrder));
router.post("/:orderId/reject", approve, asyncHandler(rejectOrder));
router.post("/:orderId/schedule", operate, asyncHandler(scheduleOrder));
router.post("/:orderId/start", operate, asyncHandler(startOrder));
router.post("/:orderId/cancel", operate, asyncHandler(cancelOrder));
router.post("/:orderId/dispatch", operate, asyncHandler(dispatchOrder));
router.post("/:orderId/authorise-destruction", authorise, asyncHandler(authoriseDestruction));
router.post("/:orderId/destroy", operate, asyncHandler(destroyOrder));
router.post("/:orderId/authorise-digitization", authorise, asyncHandler(authoriseDigitization));
router.post("/:orderId/digitize", operate, asyncHandler(digitizeOrder));
router.post("/:orderId/complete", operate, asyncHandler(completeOrder));

module.exports = router;
