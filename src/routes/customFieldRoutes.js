// Custom fields -- app.js mounts it at "/api/custom-fields".
//   GET   /?clientId=&includeInactive=true   any staff
//   POST  /  { clientId, name, fieldType, required }     settings.manage
//   PATCH /:id  { name?, required?, active? }            settings.manage
const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");
const { actorFromReq } = require("../utils/actor");
const svc = require("../services/customFieldService");

const router = express.Router();
router.use(requireAuth);
const manage = requirePermission("settings.manage");

router.get("/", asyncHandler(async (req, res) =>
  res.json(await svc.listFields(req.query.clientId, { includeInactive: req.query.includeInactive === "true", expedienteId: req.query.expedienteId }))
));
router.post("/", manage, asyncHandler(async (req, res) => res.status(201).json(await svc.createField(req.body || {}, actorFromReq(req)))));
router.patch("/:id", manage, asyncHandler(async (req, res) => res.json(await svc.updateField(req.params.id, req.body || {}, actorFromReq(req)))));

module.exports = router;
