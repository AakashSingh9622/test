// Retention rules (spec §4.4): how long a box must be kept, by category. Versioned -- saving a rule adds a new version
// and the previous one stops being current (history stays). A box's destruction date = its own destroyAfter if set,
// else trigger date + retentionYears of its category's current rule. A scheduled list only SUGGESTS boxes; nothing is
// ever destroyed automatically.
const prisma = require("../config/prisma");
const httpError = require("../utils/httpError");
const { serializeBox, dateOnly } = require("../utils/serialize");
const { parsePagination } = require("../utils/pagination");
const { appendAdminEvent } = require("./adminAuditService");
const { activeHoldsForBoxes } = require("./legalHoldService");

const TRIGGERS = ["filing_date_to", "filing_date_from", "registered"];
const CODE = /^[A-Z0-9][A-Z0-9_-]{0,29}$/;

function serializeRule(r) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    retentionYears: r.retentionYears,
    trigger: r.trigger,
    version: r.version,
    isCurrent: r.isCurrent,
    notes: r.notes ?? undefined,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  };
}

async function listRules({ includeHistory = false } = {}) {
  const rules = await prisma.retentionRule.findMany({
    where: includeHistory ? {} : { isCurrent: true },
    orderBy: [{ code: "asc" }, { version: "desc" }],
  });
  return rules.map(serializeRule);
}

async function currentRules(db = prisma) {
  const rules = await db.retentionRule.findMany({ where: { isCurrent: true } });
  return new Map(rules.map((r) => [r.code, r]));
}

// New rule, or a new version of an existing code.
async function saveRule(input, actor) {
  const code = String(input.code || "").trim().toUpperCase();
  if (!CODE.test(code)) throw httpError(400, "code must be 1-30 letters, digits, - or _ (e.g. TAX or HR-7)");
  const name = String(input.name || "").trim();
  if (!name) throw httpError(400, "name is required");
  const years = Number(input.retentionYears);
  if (!Number.isInteger(years) || years < 0 || years > 200) throw httpError(400, "retentionYears must be a whole number from 0 to 200");
  if (!TRIGGERS.includes(input.trigger)) throw httpError(400, `trigger must be one of: ${TRIGGERS.join(", ")}`);

  return prisma.$transaction(async (tx) => {
    const latest = await tx.retentionRule.findFirst({ where: { code }, orderBy: { version: "desc" } });
    await tx.retentionRule.updateMany({ where: { code, isCurrent: true }, data: { isCurrent: false } });
    const rule = await tx.retentionRule.create({
      data: {
        code,
        name: name.slice(0, 200),
        retentionYears: years,
        trigger: input.trigger,
        version: (latest?.version ?? 0) + 1,
        notes: input.notes ? String(input.notes).trim().slice(0, 1000) : null,
        createdBy: actor,
      },
    });
    await appendAdminEvent(
      "retention_rule_saved",
      actor,
      { entityType: "retention_rule", entityId: code, summary: `Retention rule ${code} v${rule.version}: ${name}, ${years} years after ${input.trigger.replace(/_/g, " ")}` },
      tx
    );
    return serializeRule(rule);
  });
}

function addYears(date, years) {
  const d = new Date(date);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d;
}

// The date from which a box may be destroyed (Date), or null if it has no destroyAfter and no (known) category.
function destructionDateFor(box, rules) {
  if (box.destroyAfter) return new Date(box.destroyAfter);
  const rule = box.retentionCategory ? rules.get(box.retentionCategory) : null;
  if (!rule) return null;
  const base = rule.trigger === "registered" ? box.createdAt : rule.trigger === "filing_date_from" ? box.filingDateFrom : box.filingDateTo ?? box.filingDateFrom;
  return base ? addYears(base, rule.retentionYears) : null;
}

// Boxes whose destruction date has come by `before` -- candidates for a records manager to review. Boxes under a legal
// hold, on hold, on an open order, or not with us are left out (each is listed with why it would be held back).
async function dueForDestruction({ before, clientId, page, pageSize } = {}) {
  const cutoff = before ? new Date(`${before}T00:00:00.000Z`) : new Date();
  if (Number.isNaN(cutoff.getTime())) throw httpError(400, "before must be a date (YYYY-MM-DD)");
  const rules = await currentRules();
  const where = { status: { in: ["stored", "digitized", "received"] }, openOrderId: null };
  if (clientId) where.clientId = clientId;
  // Only boxes that can have a date at all: their own destroyAfter, or a category with a current rule.
  where.OR = [{ destroyAfter: { lte: cutoff } }, { destroyAfter: null, retentionCategory: { in: [...rules.keys()] } }];
  const candidates = await prisma.box.findMany({ where, orderBy: [{ clientName: "asc" }, { boxNumber: "asc" }], take: 5000 });
  const due = [];
  for (const box of candidates) {
    const date = destructionDateFor(box, rules);
    if (date && date <= cutoff) due.push({ box, date });
  }
  const holds = await activeHoldsForBoxes(due.map((d) => d.box));
  const { skip, take } = parsePagination({ page, pageSize });
  return {
    total: due.length,
    items: due.slice(skip, skip + take).map(({ box, date }) => ({
      box: serializeBox(box),
      destructionDate: dateOnly(date),
      basis: box.destroyAfter ? "destroy-after date" : `rule ${box.retentionCategory}`,
      heldBy: (holds.get(box.id) || []).map((h) => ({ id: h.id, scope: h.scope, authority: h.authority })),
      onHold: box.onHold,
    })),
  };
}

module.exports = { TRIGGERS, listRules, currentRules, saveRule, destructionDateFor, dueForDestruction };
