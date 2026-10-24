// Admin / configuration change history (roles, warehouse layout, settings) -- app.js mounts it at "/api/admin-audit".
//   GET /?entityType=&entityId=&action=&page=&pageSize=   -> { items: AdminAuditEvent[], total }
const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");
const { searchAdminEvents } = require("../services/adminAuditService");

const router = express.Router();
router.use(requireAuth, requirePermission("audit.read"));

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = req.query;
    res.json(await searchAdminEvents({ entityType: q.entityType, entityId: q.entityId, action: q.action, page: q.page, pageSize: q.pageSize }));
  })
);

module.exports = router;
