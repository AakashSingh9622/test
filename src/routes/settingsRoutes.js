const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");
const { listBoxSizes, updateBoxSizes, createBoxSize, updateBoxSize, deleteBoxSize } = require("../services/boxSizeService");
const { getSageSettings, updateSageSettings } = require("../services/sageSettingsService");
const { actorFromReq } = require("../utils/actor");

const router = express.Router();
router.use(requireAuth);

// Box sizes (Sprint 11). Any staff can read them (every size picker uses them); settings.manage changes them.
router.get("/box-sizes", asyncHandler(async (_req, res) => res.json(await listBoxSizes())));
const manage = requirePermission("settings.manage");
// { name, lengthCm } -> the new size (its code is made from the name)
router.post("/box-sizes", manage, asyncHandler(async (req, res) => res.status(201).json(await createBoxSize(req.body || {}, actorFromReq(req)))));
// { name?, lengthCm?, active? } -- rename, new length for boxes registered from now on, retire (false) / bring back
router.patch("/box-sizes/:code", manage, asyncHandler(async (req, res) => res.json(await updateBoxSize(req.params.code, req.body || {}, actorFromReq(req)))));
// only a size no box uses (not standard / large)
router.delete("/box-sizes/:code", manage, asyncHandler(async (req, res) => {
  await deleteBoxSize(req.params.code, actorFromReq(req));
  res.status(204).end();
}));
// older call: { standard: 45, large: 90 } sets lengths by code
router.put("/box-sizes", manage, asyncHandler(async (req, res) => res.json(await updateBoxSizes(req.body || {}, actorFromReq(req)))));

// Sage One defaults (ledger account, VAT rate, payment terms). The Sage connection itself lives in the browser.
router.get("/sage", requirePermission("billing.view"), asyncHandler(async (_req, res) => res.json(await getSageSettings())));
router.put(
  "/sage",
  requirePermission("billing.manage"),
  asyncHandler(async (req, res) => res.json(await updateSageSettings(req.body || {}, actorFromReq(req))))
);

module.exports = router;
