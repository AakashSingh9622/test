// CSV exports -- app.js mounts it at "/api/exports".  GET /:kind.csv?from=&to=&clientId=&status=
//   inventory, movements: any staff · audit: audit.read · charges: billing.view
const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");
const { exportCsv } = require("../services/exportService");

const router = express.Router();
router.use(requireAuth);
const csv = (kind) => asyncHandler(async (req, res) => exportCsv(kind, req.query, res));

router.get("/inventory.csv", csv("inventory"));
router.get("/movements.csv", csv("movements"));
router.get("/audit.csv", requirePermission("audit.read"), csv("audit"));
router.get("/charges.csv", requirePermission("billing.view"), csv("charges"));

module.exports = router;
