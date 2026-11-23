// Reports -- app.js mounts it at "/api/reports". Any logged-in staff may read them (no billing figures in here).
//   GET /loans?from=&to=&clientId=     requests by type and urgency, per client
//   GET /interfiling?clientId=&status=&page=&pageSize=   boxes holding recorded files, with how many (Docbox "Intercalado")
//   GET /archive?clientId=&status=     boxes per client / size / status, and the number of records (archive records) per client
//   GET /record-requests?list=lent|cancelled|requested|returned&from=&to=&clientId=&expedienteId=&requester=&requestChannel=&loanType=&byExpediente=true
//                                      Docbox "Listado peticiones" for RECORD requests, per client (and file); STAFF sessions only
//   GET /record-requesters?clientId=   who asked on record requests (for the picker); STAFF sessions only
const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const { loansReport, archiveReport, interfilingReport, requestersReport, recordRequestsReport, recordRequestersReport } = require("../services/reportService");

const router = express.Router();
router.use(requireAuth);

// The record-request report is for warehouse staff: a client (portal) session is refused.
const staffOnly = (req, res, next) => (req.user?.side === "staff" ? next() : res.status(403).json({ status: false, code: "forbidden", message: "Staff only" }));

router.get("/loans", asyncHandler(async (req, res) => res.json(await loansReport(req.query))));
router.get("/requesters", asyncHandler(async (req, res) => res.json(await requestersReport(req.query))));
router.get("/interfiling", asyncHandler(async (req, res) => res.json(await interfilingReport(req.query))));
router.get("/archive", asyncHandler(async (req, res) => res.json(await archiveReport(req.query))));
router.get("/record-requests", staffOnly, asyncHandler(async (req, res) => res.json(await recordRequestsReport(req.query))));
router.get("/record-requesters", staffOnly, asyncHandler(async (req, res) => res.json(await recordRequestersReport(req.query))));

module.exports = router;
