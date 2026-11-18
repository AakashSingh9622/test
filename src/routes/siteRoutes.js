// Sites (Docbox "Sedes") -- app.js mounts it at "/api/sites".
//   GET    /                      any staff        -> [{ name, warehouseCount, warehouses }]
//   POST   /  { name }            layout.manage
//   PATCH  /  { name, newName }   layout.manage    (the warehouses move to the new name)
//   DELETE /?name=                layout.manage    (only a site with no warehouse)
// The site is named in the body / query, not the path, so a name with a slash or accent needs no escaping.
const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");
const { actorFromReq } = require("../utils/actor");
const svc = require("../services/siteService");

const router = express.Router();
router.use(requireAuth);
const manage = requirePermission("layout.manage");

router.get("/", asyncHandler(async (req, res) => res.json(await svc.listSites())));
router.post("/", manage, asyncHandler(async (req, res) => res.status(201).json(await svc.createSite(req.body || {}, actorFromReq(req)))));
router.patch("/", manage, asyncHandler(async (req, res) => res.json(await svc.renameSite(req.body || {}, actorFromReq(req)))));
router.delete("/", manage, asyncHandler(async (req, res) => res.json(await svc.deleteSite({ name: req.query.name }, actorFromReq(req)))));

module.exports = router;
