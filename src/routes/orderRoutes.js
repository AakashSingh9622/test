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
const { actorFromReq } = require("../utils/actor");
const orderBilling = require("../services/orderBillingService");

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
// Billing stage (the invoice itself: POST /api/invoices with orderId). Paid or waived -> the order can be scheduled.
//   POST /:orderId/billing/payment { method: bank_transfer|card|other, reference?, amount?, note? }
//   POST /:orderId/billing/waive   { reason }
//   POST /:orderId/billing/payment-required { required }   "payment not required" = on account: the client only acknowledges
//   POST /:orderId/billing/acknowledge      { note? }      staff record the client's acknowledgement
const billing = requirePermission("billing.manage");
router.post("/:orderId/billing/payment", billing, asyncHandler(async (req, res) => {
  res.json(await orderBilling.recordPayment(req.params.orderId, req.body || {}, actorFromReq(req)));
}));
router.post("/:orderId/billing/payment-required", billing, asyncHandler(async (req, res) => {
  res.json(await orderBilling.setPaymentRequired(req.params.orderId, (req.body || {}).required, actorFromReq(req)));
}));
router.post("/:orderId/billing/acknowledge", billing, asyncHandler(async (req, res) => {
  res.json(await orderBilling.acknowledgeInvoice(req.params.orderId, actorFromReq(req), { via: "staff", note: (req.body || {}).note }));
}));
router.post("/:orderId/billing/waive", billing, asyncHandler(async (req, res) => {
  res.json(await orderBilling.waiveBilling(req.params.orderId, (req.body || {}).reason, actorFromReq(req)));
}));

module.exports = router;
