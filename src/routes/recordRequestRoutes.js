// Docbox "Peticiones" (Phase 2, stage 5) -- app.js mounts it at "/api/record-requests".
//   GET  /?clientId=&status=&q=&page=&pageSize=   -> { items, total }   any staff
//   GET  /:id                                      -> request with its lines
//   POST / { clientId, recordIds: [..], loanType?, requestChannel?, contactName?, contactEmail?, notes? }
//        -> 201 request; every record goes archived -> on_loan, all or none (409 if one isn't archived)   boxes.operate
const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");
const { actorFromReq } = require("../utils/actor");
const svc = require("../services/recordRequestService");

const router = express.Router();
router.use(requireAuth);

router.get("/", asyncHandler(async (req, res) => res.json(await svc.listRequests(req.query))));
router.post("/", requirePermission("boxes.operate"), asyncHandler(async (req, res) => res.status(201).json(await svc.createRequest(req.body || {}, actorFromReq(req)))));
router.get("/:id", asyncHandler(async (req, res) => res.json(await svc.getRequest(req.params.id))));

module.exports = router;
