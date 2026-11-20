// Docbox "records" (Phase 2, stage 1) -- app.js mounts it at "/api/archive-records". (Not "/api/records": that one is
// retention rules, legal holds and certificates.)
//   GET  /?clientId=&expedienteId=&boxId=&status=&q=<internal code>&page=&pageSize=   -> { items, total }   any staff
//   GET  /:id                                                                          -> record            any staff
//   GET  /:id/events                                                                   -> history, newest first
//   POST /  { boxId, fields?: { C1: "...", ... }, comments? }  -> 201 record (the client and file come from the box)  boxes.operate
//   POST /import  { clientId, clientName?, expedienteId?, dryRun?, rows: [{ row?, boxNo, file?, customer?, comments?, customFields? }] }
//        -> { dryRun, count, firstCode?, lastCode? }; all rows or none (422 + errors: [{ row, message }])   boxes.operate
//   PATCH /:id  { fields?: { C1: "..." }, comments? }  -> record (only the codes sent change; "" clears)             boxes.operate
//   POST /:id/duplicate  { boxId?, fields?, comments? }  -> 201 new record, a copy with the changes sent        boxes.operate
const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");
const { actorFromReq } = require("../utils/actor");
const svc = require("../services/archiveRecordService");
const importSvc = require("../services/archiveRecordImportService");

const router = express.Router();
router.use(requireAuth);

router.get("/", asyncHandler(async (req, res) => res.json(await svc.listRecords(req.query))));
router.post("/", requirePermission("boxes.operate"), asyncHandler(async (req, res) => res.status(201).json(await svc.createRecord(req.body || {}, actorFromReq(req)))));
const operate = requirePermission("boxes.operate");
router.post("/import", operate, asyncHandler(async (req, res) => res.json(await importSvc.importRecords(req.body || {}, actorFromReq(req)))));
router.patch("/:id", operate, asyncHandler(async (req, res) => res.json(await svc.updateRecord(req.params.id, req.body || {}, actorFromReq(req)))));
router.post("/:id/duplicate", operate, asyncHandler(async (req, res) => res.status(201).json(await svc.duplicateRecord(req.params.id, req.body || {}, actorFromReq(req)))));
router.get("/:id", asyncHandler(async (req, res) => res.json(await svc.getRecord(req.params.id))));
router.get("/:id/events", asyncHandler(async (req, res) => res.json(await svc.listRecordEvents(req.params.id))));

module.exports = router;
