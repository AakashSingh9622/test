const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/requireRole");
const asyncHandler = require("../utils/asyncHandler");
const { getBoxSizeSettings, updateBoxSizes } = require("../services/boxSizeService");
const { actorFromReq } = require("../utils/actor");

const router = express.Router();
router.use(requireAuth);

// Any staff can read the lengths (screens use them); only staff_admin can change them.
router.get("/box-sizes", asyncHandler(async (_req, res) => res.json(await getBoxSizeSettings())));
router.put(
  "/box-sizes",
  requireRole("staff_admin"),
  asyncHandler(async (req, res) => res.json(await updateBoxSizes(req.body || {}, actorFromReq(req))))
);

module.exports = router;
