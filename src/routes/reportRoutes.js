// Reports -- app.js mounts it at "/api/reports". Any logged-in staff may read them (no billing figures in here).
//   GET /loans?from=&to=&clientId=     requests by type and urgency, per client
//   GET /archive?clientId=&status=     boxes per client / size / status, and recorded contents per client
const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const { loansReport, archiveReport } = require("../services/reportService");

const router = express.Router();
router.use(requireAuth);

router.get("/loans", asyncHandler(async (req, res) => res.json(await loansReport(req.query))));
router.get("/archive", asyncHandler(async (req, res) => res.json(await archiveReport(req.query))));

module.exports = router;
