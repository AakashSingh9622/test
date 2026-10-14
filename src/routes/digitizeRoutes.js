// External scan-app API -- app.js mounts it at "/api/digitize".
//   POST /scheduled-orders   body { email, password (base64), agrno }   ->   { status, count, orders: [{ id, name }] }
// Public (no cookie/token): the body itself is the proof of identity, so it is rate-limited per IP AND per email,
// answers every failure with the same clear JSON shape { status:false, code, message }, and is never cached.
const express = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

const { scheduledDigitizeOrders, ApiError } = require("../services/digitizeFeedService");

const router = express.Router();

const limited = (message) => ({ status: false, code: "RATE_LIMITED", message });
const common = { windowMs: 60_000, standardHeaders: true, legacyHeaders: false };

// Per IP: stops flooding.
const ipLimiter = rateLimit({
  ...common,
  limit: 30,
  message: limited("Too many requests from this address. Please wait a minute."),
  keyGenerator: (req) => ipKeyGenerator(req.ip),
});
// Per email: stops password guessing for one account, even when the attacker rotates IP addresses.
const emailLimiter = rateLimit({
  ...common,
  limit: 10,
  message: limited("Too many attempts for this account. Please wait a minute."),
  keyGenerator: (req) => {
    const email = req.body && typeof req.body.email === "string" ? req.body.email.trim().toLowerCase().slice(0, 254) : "";
    return email ? "email:" + email : "ip:" + ipKeyGenerator(req.ip);
  },
});

router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store"); // credentials went in, a private list comes out: never cache it
  next();
});

router.post("/scheduled-orders", ipLimiter, emailLimiter, async (req, res) => {
  try {
    const result = await scheduledDigitizeOrders(req.body);
    res.json({ status: true, ...result });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json({ status: false, code: err.code, message: err.message });
    // Never show internal details (database messages, stack) to an outside caller.
    console.error("digitize scheduled-orders failed:", err);
    res.status(500).json({ status: false, code: "INTERNAL_ERROR", message: "Something went wrong on our side. Please try again later." });
  }
});

// Any other method on this path: say so clearly instead of a generic 404.
router.all("/scheduled-orders", (_req, res) => {
  res.set("Allow", "POST").status(405).json({
    status: false,
    code: "METHOD_NOT_ALLOWED",
    message: "Use POST with a JSON body { email, password, agrno }.",
  });
});

module.exports = router;
