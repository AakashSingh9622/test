// Docbox "Peticiones" (Phase 2, stage 5) -- app.js mounts it at "/api/record-requests".
//   GET  /?clientId=&status=&q=&page=&pageSize=   -> { items, total }   any staff
//   GET  /:id                                      -> request with its lines (+ each record's fields and box location)
//   GET  /:id/events                               -> the request's history, oldest first (created, accepted, delivered, returned, cancelled)
//   POST /:id/status { to: requested | delivered | cancelled | returned, note? } -> request.   boxes.operate
//        pending->requested (ACCEPT a portal request: an original goes on loan, a digital one changes nothing physical) | cancelled;
//        requested->delivered (digital: finished) | cancelled; delivered->returned (originals only). Cancelled / returned originals
//        go back to archived (all or none). The client is notified of accept / deliver / cancel.
//   PATCH /:id { contactName?, contactEmail?, loanType?, requestChannel?, notes?, addRecordIds?, removeRecordIds?, note? } -> request.   boxes.operate
//        Edit a PENDING or REQUESTED request (all or nothing): header and/or add/remove records. Client and kind never change; a portal
//        request keeps its contact. A requested original request puts added records on loan / gives removed ones back; pending and digital
//        only lock / unlock. History on the request and on each record; the client is told once about contact / urgency / records changes.
//   POST /import { clientId, clientName?, dryRun?, contacts: [{ email, name? }], rows: [{ row?, internalCode, file?, customer?, type, urgency, requestedBy }] }   boxes.operate
//        -> { dryRun, count, requests: [{ kind, loanType, contactEmail, recordCount, (real run) id, requestNumber }] }. Rows are grouped by type + urgency
//        + contact and split into requests of at most 100 records; physical -> records on loan, digital -> never. `contacts` = the client's DocuSoft
//        contacts as read by the screen (nothing is stored); requestedBy must be one of them and not switched off for loans. All or nothing:
//        any wrong row -> 422 + errors [{ row, message }] and nothing is created.
//   POST / { clientId, recordIds: [..], loanType?, requestChannel?, contactName?, contactEmail?, notes? }
//        -> 201 request; every record goes archived -> on_loan, all or none (409 if one isn't archived)   boxes.operate
const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");
const { actorFromReq } = require("../utils/actor");
const svc = require("../services/recordRequestService");
const importSvc = require("../services/recordRequestImportService");

const router = express.Router();
router.use(requireAuth);

router.get("/", asyncHandler(async (req, res) => res.json(await svc.listRequests(req.query))));
router.post("/", requirePermission("boxes.operate"), asyncHandler(async (req, res) => res.status(201).json(await svc.createRequest(req.body || {}, actorFromReq(req)))));
router.post("/import", requirePermission("boxes.operate"), asyncHandler(async (req, res) => res.json(await importSvc.importRequests(req.body || {}, actorFromReq(req)))));
router.post("/:id/status", requirePermission("boxes.operate"), asyncHandler(async (req, res) => res.json(await svc.changeStatus(req.params.id, req.body || {}, actorFromReq(req)))));
router.patch("/:id", requirePermission("boxes.operate"), asyncHandler(async (req, res) => res.json(await svc.editRequest(req.params.id, req.body || {}, actorFromReq(req)))));
router.get("/:id/events", asyncHandler(async (req, res) => res.json(await svc.listRequestEvents(req.params.id))));
router.get("/:id", asyncHandler(async (req, res) => res.json(await svc.getRequest(req.params.id))));

module.exports = router;
