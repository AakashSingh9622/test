// Docbox "Expurgo" by file (Phase 2, stage 8 + 8b) -- app.js mounts it at "/api/record-purges".
//   POST /  { clientId, clientName?, dryRun?, rows: [{ row?, internalCode, file?, customer?, action: "purge"|"loan", authorisedBy?, date? }],
//             loan?: { loanType?, requestChannel?, contactName?, contactEmail?, notes? } }                       records.manage
//        -> dryRun:  { dryRun: true, purgeCount, loanCount, needsApproval }
//        -> a file with a PURGE row is NOT run: { dryRun: false, pending: true, requestId, requestNumber, purgeCount, loanCount }
//           and waits for a different person to approve it (below). A file with only loan rows runs at once:
//           { dryRun: false, pending: false, purged: 0, lent, requestNumber?, requestId? }
//        Every row is checked first: 422 + errors [{ row, message }] and NOTHING changes if any is wrong.
//   GET  /requests?status=&clientId=&q=&page=&pageSize=   -> { items, total }          records.manage
//   GET  /requests/:id                                     -> request with its rows    records.manage
//   POST /requests/:id/approve                             -> request (runs the purge)  records.approve, and NOT the person who
//        prepared it (403). The rows are checked again; 422 and the request stays pending if any is no longer valid.
//   POST /requests/:id/reject  { note }                    -> request                   records.approve, not the preparer (403)
//   POST /requests/:id/cancel                              -> request                   records.manage, ONLY the preparer
const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");
const { actorFromReq } = require("../utils/actor");
const svc = require("../services/recordPurgeService");

const router = express.Router();
router.use(requireAuth);

const manage = requirePermission("records.manage");
const approve = requirePermission("records.approve");

router.post("/", manage, asyncHandler(async (req, res) => res.json(await svc.purgeByFile(req.body || {}, actorFromReq(req)))));
router.get("/requests", manage, asyncHandler(async (req, res) => res.json(await svc.listPurgeRequests(req.query))));
router.get("/requests/:id", manage, asyncHandler(async (req, res) => res.json(await svc.getPurgeRequest(req.params.id))));
router.post("/requests/:id/approve", approve, asyncHandler(async (req, res) => res.json(await svc.approvePurgeRequest(req.params.id, actorFromReq(req)))));
router.post("/requests/:id/reject", approve, asyncHandler(async (req, res) => res.json(await svc.rejectPurgeRequest(req.params.id, req.body || {}, actorFromReq(req)))));
router.post("/requests/:id/cancel", manage, asyncHandler(async (req, res) => res.json(await svc.cancelPurgeRequest(req.params.id, actorFromReq(req)))));

module.exports = router;
