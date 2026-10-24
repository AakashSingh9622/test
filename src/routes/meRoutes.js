// The signed-in staff member's own settings. Today: their signature (signatureService), which goes on the certificates
// of destruction they sign. Any staff member, for themselves only.
const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const { actorFromReq } = require("../utils/actor");
const { getSignature, setSignature, removeSignature } = require("../services/signatureService");
const httpError = require("../utils/httpError");

const router = express.Router();
router.use(requireAuth);
router.use((req, _res, next) => next(req.user.side === "staff" ? undefined : httpError(403, "Staff only")));

router.get("/signature", asyncHandler(async (req, res) => res.json({ signature: await getSignature(req.user.userId) })));
// { kind: drawn | typed | uploaded, image: data URL, text?, font? }
router.put("/signature", asyncHandler(async (req, res) =>
  res.json({ signature: await setSignature(req.user.userId, req.body || {}, actorFromReq(req)) })
));
router.delete("/signature", asyncHandler(async (req, res) => {
  await removeSignature(req.user.userId, actorFromReq(req));
  res.status(204).end();
}));

module.exports = router;
