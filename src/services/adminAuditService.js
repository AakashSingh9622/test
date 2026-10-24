// Admin / configuration changes ka history (roles, warehouse layout, settings). Sirf insert -- kabhi update/delete nahi.
// Box events audit_event me jaate hain (auditService.js); ye un cheezon ke liye hai jinka koi box nahi hota.
const prisma = require("../config/prisma");
const { serializeSimple } = require("../utils/serialize");
const { parsePagination } = require("../utils/pagination");

async function appendAdminEvent(action, actor, { entityType, entityId, summary, changes } = {}, db = prisma) {
  return db.adminAuditEvent.create({
    data: {
      action,
      entityType,
      entityId: entityId ?? undefined,
      summary,
      changes: changes ?? undefined,
      actor,
      at: new Date(),
    },
  });
}

async function searchAdminEvents(params = {}) {
  const where = {};
  if (params.entityType) where.entityType = params.entityType;
  if (params.entityId) where.entityId = params.entityId;
  if (params.action) where.action = params.action;
  const { skip, take } = parsePagination(params, 50);
  const [items, total] = await Promise.all([
    prisma.adminAuditEvent.findMany({ where, orderBy: [{ at: "desc" }, { id: "asc" }], skip, take }),
    prisma.adminAuditEvent.count({ where }),
  ]);
  return { items: items.map(serializeSimple), total };
}

module.exports = { appendAdminEvent, searchAdminEvents };
