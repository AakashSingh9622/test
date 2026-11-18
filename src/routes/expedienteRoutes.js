// Expedientes (Docbox "Expedientes - Clientes") -- app.js mounts it at "/api/expedientes".
//   GET    /?clientId=            any staff
//   POST   /  { clientId, code, description }       settings.manage
//   PATCH  /:id  { description }                    settings.manage
//   DELETE /:id  (only one with no boxes or fields) settings.manage
const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");
const { actorFromReq } = require("../utils/actor");
const svc = require("../services/expedienteService");

const router = express.Router();
router.use(requireAuth);
const manage = requirePermission("settings.manage");

router.get("/", asyncHandler(async (req, res) => res.json(await svc.listExpedientes(req.query.clientId))));
router.post("/", manage, asyncHandler(async (req, res) => res.status(201).json(await svc.createExpediente(req.body || {}, actorFromReq(req)))));
router.patch("/:id", manage, asyncHandler(async (req, res) => res.json(await svc.updateExpediente(req.params.id, req.body || {}, actorFromReq(req)))));
router.delete("/:id", manage, asyncHandler(async (req, res) => res.json(await svc.deleteExpediente(req.params.id, actorFromReq(req)))));

module.exports = router;
