// Supervisor queue of scans that didn't match -- app.js mounts it at "/api/exceptions". Supervisors only
// (orders.approve: staff_admin, warehouse_admin, operations_manager).
//   GET  /?status=open|resolved&orderId=&page=&pageSize=   -> { items, total, open }
//   POST /:id/resolve  { resolution }                       -> OperationException
const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");
const { actorFromReq } = require("../utils/actor");
const { listExceptions, resolveException } = require("../services/exceptionService");

const router = express.Router();
router.use(requireAuth, requirePermission("orders.approve"));

router.get("/", asyncHandler(async (req, res) => {
  const q = req.query;
  res.json(await listExceptions({ status: q.status, orderId: q.orderId, page: q.page, pageSize: q.pageSize }));
}));
router.post("/:id/resolve", asyncHandler(async (req, res) => {
  res.json(await resolveException(req.params.id, (req.body || {}).resolution, actorFromReq(req)));
}));

module.exports = router;
