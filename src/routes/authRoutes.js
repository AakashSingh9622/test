// Auth endpoints -- paths frontend ke apiClient prefix (/api/*) se match karte hain,
// app.js inhe "/api/auth" par mount karta hai.
const express = require("express");
const { login, logout, me } = require("../controllers/authController");
const { requireAuth } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();

router.post("/login", asyncHandler(login));
router.post("/logout", asyncHandler(logout));
router.get("/me", requireAuth, asyncHandler(me));

module.exports = router;
