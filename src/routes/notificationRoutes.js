// Staff in-app notifications (the bell): what clients did in the portal and other things staff should know. Read state
// is per staff member (notification_read).
const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const { listForStaff, unreadCountForStaff, markRead, markAllRead } = require("../services/notificationService");

const router = express.Router();
router.use(requireAuth);

// GET /api/notifications?unread=true&page=&pageSize= -> { items: [... read], total, unread }
router.get("/", asyncHandler(async (req, res) => res.json(await listForStaff(req.query, req.user.userId))));
router.get("/unread-count", asyncHandler(async (req, res) => res.json({ unread: await unreadCountForStaff(req.user.userId) })));
router.post("/read-all", asyncHandler(async (req, res) => res.json({ marked: await markAllRead(req.user.userId) })));
router.post("/:id/read", asyncHandler(async (req, res) => {
  await markRead(req.params.id, req.user.userId);
  res.json({ ok: true });
}));

module.exports = router;
