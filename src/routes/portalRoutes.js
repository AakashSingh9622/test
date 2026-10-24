// Client-portal API -- app.js ise "/api/portal" par mount karta hai.
//   POST /auth/login           (public, rate-limited)  ->  { token, user }
//   baaki sab                  Authorization: Bearer <token>  (middleware/portalAuth.js)
const express = require("express");
const { rateLimit } = require("express-rate-limit");

const { requirePortalAuth } = require("../middleware/portalAuth");
const asyncHandler = require("../utils/asyncHandler");
const portalAuthService = require("../services/portalAuthService");
const portal = require("../services/portalService");

const router = express.Router();

const tooMany = (message) => ({ status: false, code: "rate_limited", message });

// Login: ek IP se ek minute me 20 -- token-guessing / flooding rokne ke liye.
const loginLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: tooMany("Too many login attempts, please wait a minute"),
});

// Baaki portal calls: ek IP se ek minute me 600 (ek office ke kai log ek hi IP se aa sakte hain).
const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: tooMany("Too many requests, please slow down"),
});

router.post(
  "/auth/login",
  loginLimiter,
  asyncHandler(async (req, res) => {
    res.json(await portalAuthService.login(req.body));
  })
);

router.use(apiLimiter, requirePortalAuth);

router.get("/auth/me", (req, res) => res.json(req.portal));

router.get("/summary", asyncHandler(async (req, res) => res.json(await portal.summary(req.portal))));
router.get("/notifications", asyncHandler(async (req, res) => res.json(await portal.listNotifications(req.portal, req.query))));
router.get("/certificates", asyncHandler(async (req, res) => res.json(await portal.listCertificates(req.portal, req.query))));

router.get("/boxes", asyncHandler(async (req, res) => res.json(await portal.listBoxes(req.portal, req.query))));
router.get("/boxes/:boxId", asyncHandler(async (req, res) => res.json(await portal.getBox(req.portal, req.params.boxId))));
router.get(
  "/boxes/:boxId/history",
  asyncHandler(async (req, res) => res.json(await portal.boxHistory(req.portal, req.params.boxId, req.query)))
);

router.get("/orders", asyncHandler(async (req, res) => res.json(await portal.listOrders(req.portal, req.query))));
router.post(
  "/orders",
  asyncHandler(async (req, res) => res.status(201).json(await portal.createOrder(req.portal, req.body)))
);
router.get("/orders/:orderId", asyncHandler(async (req, res) => res.json(await portal.getOrder(req.portal, req.params.orderId))));
router.get(
  "/orders/:orderId/certificate",
  asyncHandler(async (req, res) => res.json(await portal.orderCertificate(req.portal, req.params.orderId)))
);
// Card payment made in the portal (Stripe via DocuSoft's proxy): { paymentIntentId, amount (minor units), currency }
router.post(
  "/orders/:orderId/payment",
  asyncHandler(async (req, res) => res.json(await portal.payOrder(req.portal, req.params.orderId, req.body || {})))
);
// Payment not required (on account): the client acknowledges the order's invoice instead of paying it.
router.post(
  "/orders/:orderId/acknowledge-invoice",
  asyncHandler(async (req, res) => res.json(await portal.acknowledgeInvoice(req.portal, req.params.orderId)))
);
router.post(
  "/orders/:orderId/client-approve",
  asyncHandler(async (req, res) => res.json(await portal.clientApprove(req.portal, req.params.orderId)))
);
router.get(
  "/orders/:orderId/lines",
  asyncHandler(async (req, res) => res.json(await portal.orderLines(req.portal, req.params.orderId)))
);
router.post(
  "/orders/:orderId/cancel",
  asyncHandler(async (req, res) => res.json(await portal.cancelOrder(req.portal, req.params.orderId, (req.body || {}).reason)))
);
router.post(
  "/orders/:orderId/authorise-destruction",
  asyncHandler(async (req, res) => res.json(await portal.authoriseDestruction(req.portal, req.params.orderId, req.body)))
);
router.post(
  "/orders/:orderId/authorise-digitization",
  asyncHandler(async (req, res) => res.json(await portal.authoriseDigitization(req.portal, req.params.orderId, req.body)))
);

module.exports = router;
