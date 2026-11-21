// Docbox "Devoluciones" (Phase 2, stage 7) -- app.js mounts it at "/api/record-returns".
//   POST /  { codes: [internal codes], note? }  -> { count, closedRequests: [REQ-..], items: [shelving list] }
//        every code is checked first: 422 + errors [{ row, message }] and NOTHING changes if any is wrong   boxes.operate
//   POST /import { clientId, clientName?, dryRun?, note?, rows: [{ row?, internalCode, file?, customer? }] } (<= 500 rows) -> the same, from a file
//        ("Importar Devoluciones"): all or nothing, 422 RETURN_IMPORT_INVALID + rowErrors [{ row, message }]; dryRun only checks   boxes.operate
//   GET  /shelving?ids=a,b,c  -> { items }  the same records with their box's place, in shelf order (to reprint the list)
const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");
const { actorFromReq } = require("../utils/actor");
const svc = require("../services/recordReturnService");

const router = express.Router();
router.use(requireAuth);

router.post("/", requirePermission("boxes.operate"), asyncHandler(async (req, res) => res.json(await svc.returnRecords(req.body || {}, actorFromReq(req)))));
router.post("/import", requirePermission("boxes.operate"), asyncHandler(async (req, res) => res.json(await svc.importReturns(req.body || {}, actorFromReq(req)))));
router.get("/shelving", asyncHandler(async (req, res) => res.json(await svc.shelvingList(req.query.ids))));

module.exports = router;
