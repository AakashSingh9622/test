// Docbox "Expurgo" by file (Phase 2, stage 8) -- app.js mounts it at "/api/record-purges".
//   POST /  { clientId, clientName?, dryRun?, rows: [{ row?, internalCode, file?, customer?, action: "purge"|"loan", authorisedBy?, date? }],
//             loan?: { loanType?, requestChannel?, contactName?, contactEmail?, notes? } }
//        -> { dryRun, purgeCount, loanCount }  or  { dryRun: false, purged, lent, requestNumber?, requestId? }
//        Rows marked purge destroy the record (authorised by + date required); rows marked loan become ONE record request.
//        All rows or none: 422 + errors [{ row, message }].   records.manage (the same permission as retention rules / legal holds)
const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");
const { actorFromReq } = require("../utils/actor");
const svc = require("../services/recordPurgeService");

const router = express.Router();
router.use(requireAuth);

router.post("/", requirePermission("records.manage"), asyncHandler(async (req, res) => res.json(await svc.purgeByFile(req.body || {}, actorFromReq(req)))));

module.exports = router;
