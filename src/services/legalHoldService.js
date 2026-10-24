// Legal holds (spec §4.4): a hold on one box, all of a client's boxes, or a whole retention category. While a hold is
// active no box it covers can be put on a destruction order or destroyed -- "legal hold always overrides". Only a
// records manager (records.manage) places or releases one; each change is in the box history and the admin audit log.
const prisma = require("../config/prisma");
const httpError = require("../utils/httpError");
const { dateOnly, toDate } = require("../utils/serialize");
const { parsePagination } = require("../utils/pagination");
const { appendAdminEvent } = require("./adminAuditService");
const { appendAuditEvent } = require("./auditService");

const SCOPES = ["box", "client", "category"];

function serializeHold(h) {
  const out = {
    id: h.id,
    scope: h.scope,
    boxId: h.boxId,
    boxNumber: h.boxNumber,
    clientId: h.clientId,
    clientName: h.clientName,
    category: h.category,
    authority: h.authority,
    reason: h.reason,
    startsAt: dateOnly(h.startsAt),
    endsAt: dateOnly(h.endsAt),
    status: h.status,
    createdBy: h.createdBy,
    createdAt: h.createdAt.toISOString(),
    releasedBy: h.releasedBy,
    releasedAt: h.releasedAt?.toISOString(),
    releaseNote: h.releaseNote,
  };
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

// Active today: status active, started, and not past its end date.
function activeWhere(now = new Date()) {
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  return { status: "active", startsAt: { lte: today }, OR: [{ endsAt: null }, { endsAt: { gte: today } }] };
}

// Map boxId -> active holds covering it (by box, by client, or by the box's retention category).
async function activeHoldsForBoxes(boxes, db = prisma) {
  const result = new Map();
  if (!boxes.length) return result;
  const holds = await db.legalHold.findMany({
    where: {
      ...activeWhere(),
      AND: [
        {
          OR: [
            { scope: "box", boxId: { in: boxes.map((b) => b.id) } },
            { scope: "client", clientId: { in: [...new Set(boxes.map((b) => b.clientId))] } },
            { scope: "category", category: { in: [...new Set(boxes.map((b) => b.retentionCategory).filter(Boolean))] } },
          ],
        },
      ],
    },
  });
  for (const box of boxes) {
    const covering = holds.filter(
      (h) =>
        (h.scope === "box" && h.boxId === box.id) ||
        (h.scope === "client" && h.clientId === box.clientId) ||
        (h.scope === "category" && box.retentionCategory && h.category === box.retentionCategory)
    );
    if (covering.length) result.set(box.id, covering);
  }
  return result;
}

// Throws 409 naming the held boxes -- used before a box is put on, or destroyed by, a destruction order.
async function assertNoLegalHold(boxes, db = prisma) {
  const held = await activeHoldsForBoxes(boxes, db);
  if (held.size === 0) return;
  const names = boxes.filter((b) => held.has(b.id)).map((b) => `${b.boxNumber} (${held.get(b.id)[0].authority})`);
  throw httpError(409, `Under legal hold — can't be destroyed: ${names.slice(0, 10).join(", ")}${names.length > 10 ? ` and ${names.length - 10} more` : ""}`);
}

async function listHolds(params = {}) {
  const where = {};
  if (params.status) where.status = params.status;
  if (params.clientId) where.clientId = params.clientId;
  if (params.boxId) where.boxId = params.boxId;
  // coversBox=<boxId>: har ACTIVE hold jo us box ko cover karta hai (box ka, client ka, category ka) -- box page banner.
  if (params.coversBox) {
    const box = await prisma.box.findUnique({ where: { id: params.coversBox } });
    const covering = box ? (await activeHoldsForBoxes([box])).get(box.id) ?? [] : [];
    return { items: covering.map(serializeHold), total: covering.length };
  }
  const { skip, take } = parsePagination(params);
  const [items, total] = await Promise.all([
    prisma.legalHold.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip, take }),
    prisma.legalHold.count({ where }),
  ]);
  return { items: items.map(serializeHold), total };
}

async function placeHold(input, actor) {
  const scope = input.scope;
  if (!SCOPES.includes(scope)) throw httpError(400, `scope must be one of: ${SCOPES.join(", ")}`);
  const authority = String(input.authority || "").trim();
  const reason = String(input.reason || "").trim();
  if (!authority) throw httpError(400, "authority is required (who asked for the hold)");
  if (!reason) throw httpError(400, "reason is required");
  const startsAt = input.startsAt ? toDate(input.startsAt) : new Date(new Date().toISOString().slice(0, 10));
  const endsAt = input.endsAt ? toDate(input.endsAt) : null;
  if (Number.isNaN(startsAt.getTime()) || (endsAt && Number.isNaN(endsAt.getTime()))) throw httpError(400, "Dates must be YYYY-MM-DD");
  if (endsAt && endsAt < startsAt) throw httpError(400, "The hold ends before it starts");

  return prisma.$transaction(async (tx) => {
    const data = { scope, authority: authority.slice(0, 300), reason: reason.slice(0, 1000), startsAt, endsAt, createdBy: actor };
    let box = null;
    if (scope === "box") {
      box = await tx.box.findUnique({ where: { id: String(input.boxId || "") } });
      if (!box) throw httpError(404, "Box not found");
      Object.assign(data, { boxId: box.id, boxNumber: box.boxNumber, clientId: box.clientId, clientName: box.clientName });
    } else if (scope === "client") {
      const clientId = String(input.clientId || "").trim();
      if (!clientId) throw httpError(400, "clientId is required for a client hold");
      Object.assign(data, { clientId, clientName: String(input.clientName || clientId).slice(0, 300) });
    } else {
      const category = String(input.category || "").trim().toUpperCase();
      if (!category) throw httpError(400, "category is required for a category hold");
      data.category = category;
    }
    const hold = await tx.legalHold.create({ data });
    const what = scope === "box" ? `box ${box.boxNumber}` : scope === "client" ? `all boxes of ${data.clientName}` : `retention category ${data.category}`;
    await appendAdminEvent("legal_hold_placed", actor, { entityType: "legal_hold", entityId: hold.id, summary: `Legal hold on ${what} (${authority})` }, tx);
    if (box) await appendAuditEvent(box, "legal_hold_placed", actor, { note: `${authority}: ${reason}` }, tx);
    return serializeHold(hold);
  });
}

async function releaseHold(id, note, actor) {
  const text = String(note || "").trim();
  if (!text) throw httpError(400, "Say why the hold is released");
  return prisma.$transaction(async (tx) => {
    const changed = await tx.legalHold.updateMany({
      where: { id, status: "active" },
      data: { status: "released", releasedBy: actor, releasedAt: new Date(), releaseNote: text.slice(0, 1000) },
    });
    const hold = await tx.legalHold.findUnique({ where: { id } });
    if (!hold) throw httpError(404, "Legal hold not found");
    if (changed.count !== 1) throw httpError(409, "This legal hold is already released");
    await appendAdminEvent("legal_hold_released", actor, { entityType: "legal_hold", entityId: id, summary: `Released legal hold (${hold.authority}): ${text}` }, tx);
    if (hold.boxId) {
      const box = await tx.box.findUnique({ where: { id: hold.boxId } });
      if (box) await appendAuditEvent(box, "legal_hold_released", actor, { note: text }, tx);
    }
    return serializeHold(hold);
  });
}

module.exports = { activeHoldsForBoxes, assertNoLegalHold, listHolds, placeHold, releaseHold };
