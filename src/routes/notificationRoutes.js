// Staff in-app notifications (new portal requests, client approvals) -- app.js mounts it at "/api/notifications".
const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const { listForStaff } = require("../services/notificationService");

const router = express.Router();
router.use(requireAuth);
router.get("/", asyncHandler(async (req, res) => res.json(await listForStaff(req.query))));

module.exports = router;
