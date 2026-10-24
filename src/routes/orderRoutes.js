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
  holdOrder,
  resumeOrder,
  approveDestruction,
  recordDelivery,
  getCertificate,
  getPickList,
  pickBox,
  receiveReturnBox,
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
// Scanning: the pick list in walking order, one pick scan / one receive scan at a time.
router.get("/:orderId/pick-list", asyncHandler(getPickList));
router.post("/:orderId/pick", operate, asyncHandler(pickBox));
router.post("/:orderId/receive", operate, asyncHandler(receiveReturnBox));
// Supervisor pause / resume.
router.post("/:orderId/hold", approve, asyncHandler(holdOrder));
// Destruction: second signature by a records manager who didn't prepare it; certificate once destroyed.
router.post("/:orderId/approve-destruction", requirePermission("records.approve"), asyncHandler(approveDestruction));
router.get("/:orderId/certificate", asyncHandler(getCertificate));
// Proof of delivery for a dispatched order.
router.post("/:orderId/delivered", operate, asyncHandler(recordDelivery));
router.post("/:orderId/resume", approve, asyncHandler(resumeOrder));

module.exports = router;
