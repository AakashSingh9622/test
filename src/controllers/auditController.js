// HTTP layer for Audit events -- response shape matches frontend ke frontend/src/api/audit.ts.
const { searchAuditEvents } = require("../services/auditService");

async function listAudit(req, res) {
  const q = req.query;
  res.json(
    await searchAuditEvents({
      boxId: q.boxId,
      clientId: q.clientId,
      orderId: q.orderId,
      type: q.type,
      visibleToClientOnly: q.visibleToClientOnly === "true",
      page: q.page ? Number(q.page) : undefined,
      pageSize: q.pageSize ? Number(q.pageSize) : undefined,
    })
  );
}

module.exports = { listAudit };
