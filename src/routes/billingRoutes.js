// Pricing and billing (Sprints 5-6) -- app.js mounts it at "/api/billing". View: billing.view. Change: billing.manage.
//   GET  /rate-cards?clientId=                 POST /rate-cards  { clientId?, clientName?, effectiveFrom, rates, taxRateId, notes? }
//   GET  /charges?from&to&clientId&status&billingRunId&page&pageSize   -> { items, total, amount }
//   POST /charges/generate  { from, to, clientId? }   -> { created, amount, clientsWithoutRateCard }   (idempotent)
//   POST /charges  { clientId, clientName, description, quantity, unitPrice, taxRateId, date? }     (manual "other" charge)
//   POST /charges/:id/void  { reason }
//   GET  /runs   GET /runs/:id   POST /runs { from, to }   POST /runs/:id/approve   DELETE /runs/:id
//   GET  /accounts?from&to&q&page&pageSize       -> clients' standing accounts { items, total, totals, period }
//   GET  /accounts/:clientId?from&to&clientName   -> one client's statement { summary, items, earlierUnpaid, drafts }
const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");
const { actorFromReq } = require("../utils/actor");
const rateCards = require("../services/rateCardService");
const charges = require("../services/chargeService");
const runs = require("../services/billingRunService");
const accounts = require("../services/accountService");

const router = express.Router();
router.use(requireAuth);
const view = requirePermission("billing.view");
const manage = requirePermission("billing.manage");

router.get("/rate-cards", view, asyncHandler(async (req, res) => res.json(await rateCards.listCards({ clientId: req.query.clientId }))));
router.post("/rate-cards", manage, asyncHandler(async (req, res) => res.status(201).json(await rateCards.createCard(req.body || {}, actorFromReq(req)))));

router.get("/charges", view, asyncHandler(async (req, res) => {
  const q = req.query;
  res.json(await charges.listCharges({ from: q.from, to: q.to, clientId: q.clientId, status: q.status, billingRunId: q.billingRunId, page: q.page, pageSize: q.pageSize }));
}));
router.post("/charges/generate", manage, asyncHandler(async (req, res) => res.json(await charges.generateCharges(req.body || {}, actorFromReq(req)))));
router.post("/charges", manage, asyncHandler(async (req, res) => res.status(201).json(await charges.addManualCharge(req.body || {}, actorFromReq(req)))));
router.post("/charges/:id/void", manage, asyncHandler(async (req, res) => res.json(await charges.voidCharge(req.params.id, (req.body || {}).reason, actorFromReq(req)))));

router.get("/runs", view, asyncHandler(async (req, res) => res.json(await runs.listRuns(req.query))));
router.get("/runs/:id", view, asyncHandler(async (req, res) => res.json(await runs.getRun(req.params.id))));
router.post("/runs", manage, asyncHandler(async (req, res) => res.status(201).json(await runs.createRun(req.body || {}, actorFromReq(req)))));
router.post("/runs/:id/approve", manage, asyncHandler(async (req, res) => res.json(await runs.approveRun(req.params.id, actorFromReq(req)))));
router.delete("/runs/:id", manage, asyncHandler(async (req, res) => res.json(await runs.discardRun(req.params.id, actorFromReq(req)))));

router.get("/accounts", view, asyncHandler(async (req, res) => {
  const q = req.query;
  res.json(await accounts.listAccounts({ from: q.from, to: q.to, q: q.q, page: q.page, pageSize: q.pageSize }));
}));
router.get("/accounts/:clientId", view, asyncHandler(async (req, res) => {
  res.json(await accounts.clientAccount(req.params.clientId, { from: req.query.from, to: req.query.to, clientName: req.query.clientName }));
}));

module.exports = router;
