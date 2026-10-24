// Records management (Sprint 4) -- app.js mounts it at "/api/records".
//   GET  /retention-rules?history=true            -> RetentionRule[]            (any staff)
//   POST /retention-rules  { code, name, retentionYears, trigger, notes? }  -> new version   (records.manage)
//   GET  /due?before=&clientId=&page=&pageSize=    -> boxes due for destruction review    (records.manage)
//   GET  /legal-holds?status=&clientId=&boxId=     -> { items, total }            (any staff)
//        ?coversBox=<boxId>                        -> active holds covering that box (own / client / category)
//   POST /legal-holds  { scope, boxId|clientId+clientName|category, authority, reason, startsAt?, endsAt? }  (records.manage)
//   POST /legal-holds/:id/release  { note }                                        (records.manage)
//   GET  /certificates?clientId=&page=&pageSize=   -> certificates of destruction  (any staff)
const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");
const { actorFromReq } = require("../utils/actor");
const retention = require("../services/retentionService");
const holds = require("../services/legalHoldService");
const certificates = require("../services/certificateService");

const router = express.Router();
router.use(requireAuth);
const manage = requirePermission("records.manage");

router.get("/retention-rules", asyncHandler(async (req, res) => res.json(await retention.listRules({ includeHistory: req.query.history === "true" }))));
router.post("/retention-rules", manage, asyncHandler(async (req, res) => res.status(201).json(await retention.saveRule(req.body || {}, actorFromReq(req)))));
router.get("/due", manage, asyncHandler(async (req, res) => {
  const q = req.query;
  res.json(await retention.dueForDestruction({ before: q.before, clientId: q.clientId, page: q.page, pageSize: q.pageSize }));
}));
router.get("/legal-holds", asyncHandler(async (req, res) => {
  const q = req.query;
  res.json(await holds.listHolds({ status: q.status, clientId: q.clientId, boxId: q.boxId, coversBox: q.coversBox, page: q.page, pageSize: q.pageSize }));
}));
router.post("/legal-holds", manage, asyncHandler(async (req, res) => res.status(201).json(await holds.placeHold(req.body || {}, actorFromReq(req)))));
router.post("/legal-holds/:id/release", manage, asyncHandler(async (req, res) => res.json(await holds.releaseHold(req.params.id, (req.body || {}).note, actorFromReq(req)))));
router.get("/certificates", asyncHandler(async (req, res) => {
  const q = req.query;
  res.json(await certificates.listCertificates({ clientId: q.clientId, page: q.page, pageSize: q.pageSize }));
}));

module.exports = router;
