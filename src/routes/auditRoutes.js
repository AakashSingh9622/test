// Audit routes -- app.js inhe "/api/audit" par mount karta hai.
const express = require("express");
const { listAudit } = require("../controllers/auditController");
const { requireAuth } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();
router.use(requireAuth);

router.get("/", asyncHandler(listAudit));

module.exports = router;
