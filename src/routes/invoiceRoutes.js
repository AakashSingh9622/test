// Warehouse invoices -- app.js mounts it at "/api/invoices". View: billing.view. Change / send: billing.manage.
//   GET    /                       ?clientId&status&q&page&pageSize -> { items, total }
//   GET    /suggest                ?clientId&from&to                 -> { lines, alreadyInvoicedOrders }
//   POST   /                       InvoiceInput                      -> Invoice (draft)        201
//   GET    /:id                                                      -> Invoice (with lines)
//   PUT    /:id                    InvoiceInput                      -> Invoice   (draft only)
//   DELETE /:id                                                      -> { ok }    (draft only)
//   POST   /:id/sending                                              -> Invoice   (takes the "sending" lock)
//   POST   /:id/issued             { sageInvoiceId, sageInvoiceNumber?, sageLink?, sageContactId?, sageBusinessId? }
//   POST   /:id/send-failed        { message }                       -> Invoice   (back to draft)
const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");
const { actorFromReq } = require("../utils/actor");
const invoices = require("../services/invoiceService");

const router = express.Router();
router.use(requireAuth);

const view = requirePermission("billing.view");
const manage = requirePermission("billing.manage");

router.get("/", view, asyncHandler(async (req, res) => {
  const q = req.query;
  res.json(await invoices.listInvoices({ clientId: q.clientId, status: q.status, q: q.q, page: q.page, pageSize: q.pageSize }));
}));
router.get("/suggest", manage, asyncHandler(async (req, res) => {
  res.json(await invoices.suggestLines({ clientId: req.query.clientId, from: req.query.from, to: req.query.to }));
}));
router.post("/", manage, asyncHandler(async (req, res) => res.status(201).json(await invoices.createInvoice(req.body || {}, actorFromReq(req)))));
router.get("/:id", view, asyncHandler(async (req, res) => res.json(await invoices.getInvoice(req.params.id))));
router.put("/:id", manage, asyncHandler(async (req, res) => res.json(await invoices.updateInvoice(req.params.id, req.body || {}))));
router.delete("/:id", manage, asyncHandler(async (req, res) => {
  await invoices.deleteInvoice(req.params.id, actorFromReq(req));
  res.json({ ok: true });
}));
router.post("/:id/sending", manage, asyncHandler(async (req, res) => res.json(await invoices.startSending(req.params.id))));
router.post("/:id/issued", manage, asyncHandler(async (req, res) => res.json(await invoices.markIssued(req.params.id, req.body || {}, actorFromReq(req)))));
router.post("/:id/send-failed", manage, asyncHandler(async (req, res) => res.json(await invoices.markFailed(req.params.id, (req.body || {}).message))));

module.exports = router;
