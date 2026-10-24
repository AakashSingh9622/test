// Charge events (spec §7.2): every chargeable fact, priced from the rate card in force on the day it happened.
//   intake       per box registered (on the registration day)
//   retrieval    per box dispatched, + delivery per dispatch order (on the completion day)
//   collection   per collection order;  destruction / digitize per box (on the completion day)
//   storage      monthly rate per box (by size), PRORATED by the days each box was in our custody in the period --
//                worked out from the movement ledger, never from today's location (decided 24 Oct)
// Each charge has a unique business key (source + type + period), so generating the same period again changes nothing.
const prisma = require("../config/prisma");
const { Prisma } = prisma;
const httpError = require("../utils/httpError");
const { dateOnly, toDate } = require("../utils/serialize");
const { parsePagination } = require("../utils/pagination");
const { appendAdminEvent } = require("./adminAuditService");
const { pickCard } = require("./rateCardService");
const { getBoxSizeNames } = require("./boxSizeService");

const DAY = 24 * 60 * 60 * 1000;
const MONTH_DAYS = 30; // storage proration: monthly rate x days / 30
const IN_MOVES = ["put_away", "transfer", "found", "received"];
const OUT_MOVES = ["dispatched", "destroyed", "marked_missing"];
const IN_CUSTODY = ["stored", "reserved", "picked", "digitized", "received", "quarantined"];

const dec = (n) => new Prisma.Decimal(n);
const num = (d) => (d == null ? d : Number(d));

function serializeCharge(c) {
  const out = {
    id: c.id,
    clientId: c.clientId,
    clientName: c.clientName,
    chargeType: c.chargeType,
    sourceType: c.sourceType,
    sourceKey: c.sourceKey,
    periodStart: dateOnly(c.periodStart),
    periodEnd: dateOnly(c.periodEnd),
    description: c.description,
    quantity: num(c.quantity),
    unitPrice: num(c.unitPrice),
    amount: num(c.amount),
    taxRateId: c.taxRateId,
    status: c.status,
    billingRunId: c.billingRunId,
    invoiceId: c.invoiceId,
    voidReason: c.voidReason,
    createdAt: c.createdAt.toISOString(),
  };
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

function parsePeriod(from, to) {
  const start = toDate(from);
  const end = toDate(to);
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw httpError(400, "from and to are required (YYYY-MM-DD)");
  if (end < start) throw httpError(400, "The period ends before it starts");
  if (end - start > 366 * DAY) throw httpError(400, "One period can cover at most a year");
  return { start, end, endExclusive: new Date(end.getTime() + DAY) };
}

const day = (d) => new Date(`${new Date(d).toISOString().slice(0, 10)}T00:00:00.000Z`);

// Days a box was in our custody inside [start, endExclusive): walks its movements; a box that predates the ledger is
// assumed to have been with us since it was registered.
function custodyDays(box, movements, start, endExclusive) {
  let inSince = null;
  const first = movements[0];
  if (!first) {
    if (IN_CUSTODY.includes(box.status)) inSince = box.createdAt;
  } else if (!IN_MOVES.includes(first.type) || first.type === "transfer") {
    inSince = box.createdAt; // first ledger entry takes it OUT of (or moves it within) custody -> it was with us before
  }
  let ms = 0;
  const close = (until) => {
    if (inSince == null) return;
    const a = Math.max(new Date(inSince).getTime(), start.getTime());
    const b = Math.min(new Date(until).getTime(), endExclusive.getTime());
    if (b > a) ms += b - a;
  };
  for (const m of movements) {
    if (IN_MOVES.includes(m.type)) {
      if (inSince == null) inSince = m.at;
    } else if (OUT_MOVES.includes(m.type)) {
      close(m.at);
      inSince = null;
    }
  }
  close(endExclusive);
  return ms / DAY;
}

async function insertCharge(tx, data, created) {
  try {
    // savepoint-free: a duplicate (already generated) is skipped via the unique key
    const exists = await tx.chargeEvent.findUnique({
      where: {
        sourceType_sourceKey_chargeType_periodStart_periodEnd: {
          sourceType: data.sourceType,
          sourceKey: data.sourceKey,
          chargeType: data.chargeType,
          periodStart: data.periodStart,
          periodEnd: data.periodEnd,
        },
      },
    });
    if (exists) return;
    await tx.chargeEvent.create({ data });
    created.push(data);
  } catch (err) {
    if (err.code !== "P2002") throw err;
  }
}

// Generates (idempotently) every charge for the period. Clients without any rate card are reported, not charged.
async function generateCharges({ from, to, clientId }, actor) {
  const { start, end, endExclusive } = parsePeriod(from, to);
  const cards = await prisma.rateCard.findMany();
  const clientFilter = clientId ? { clientId } : {};

  const [orders, newBoxes, boxes] = await Promise.all([
    prisma.order.findMany({ where: { ...clientFilter, status: "completed", completedAt: { gte: start, lt: endExclusive } } }),
    prisma.box.findMany({ where: { ...clientFilter, createdAt: { gte: start, lt: endExclusive } } }),
    // every box that could have been with us at some point in the period
    prisma.box.findMany({ where: { ...clientFilter, createdAt: { lt: endExclusive } }, select: { id: true, clientId: true, clientName: true, size: true, status: true, createdAt: true, boxNumber: true } }),
  ]);
  const movementRows = await prisma.movement.findMany({
    where: { boxId: { in: boxes.map((b) => b.id) }, at: { lt: endExclusive } },
    orderBy: [{ boxId: "asc" }, { at: "asc" }],
    select: { boxId: true, type: true, at: true },
  });
  const movesByBox = new Map();
  for (const m of movementRows) movesByBox.set(m.boxId, [...(movesByBox.get(m.boxId) || []), m]);

  const created = [];
  const noCard = new Set();
  const base = (clientId_, clientName, card) => ({ clientId: clientId_, clientName, taxRateId: card.taxRateId, rateCardId: card.id, createdBy: actor });

  await prisma.$transaction(async (tx) => {
    // --- services from completed orders
    for (const o of orders) {
      // Billed up front at the order's billing stage (its own invoice went to Sage) -- don't charge it again here.
      // (Billing waived = on account / no charge at that stage, so it is still charged by the run.)
      if (o.billing?.invoiceId && ["awaiting_payment", "paid"].includes(o.billing.status)) continue;
      const when = day(o.completedAt);
      const card = pickCard(cards, o.clientId, when);
      if (!card) {
        noCard.add(o.clientName);
        continue;
      }
      const s = o.lineSummary || {};
      const charge = async (chargeType, quantity, unitPrice, description) => {
        if (!(quantity > 0)) return;
        await insertCharge(
          tx,
          {
            ...base(o.clientId, o.clientName, card),
            chargeType,
            sourceType: "order",
            sourceKey: o.id,
            periodStart: when,
            periodEnd: when,
            description,
            quantity: dec(quantity),
            unitPrice: dec(unitPrice),
            amount: dec(quantity).mul(unitPrice).toDecimalPlaces(2),
          },
          created
        );
      };
      const r = card.rates;
      if (o.type === "dispatch") {
        const n = s.dispatched ?? o.boxCount;
        await charge("retrieval", n, r.retrievalPerBox, `Retrieval — ${n} box${n === 1 ? "" : "es"}, ${o.orderNumber}`);
        await charge("delivery", 1, r.deliveryPerOrder, `Delivery — ${o.orderNumber}`);
      } else if (o.type === "collection") {
        await charge("collection", 1, r.collectionPerOrder, `Collection — ${o.orderNumber}`);
      } else if (o.type === "destruction") {
        const n = s.destroyed ?? o.boxCount;
        await charge("destruction", n, r.destructionPerBox, `Destruction — ${n} box${n === 1 ? "" : "es"}, ${o.orderNumber}`);
      } else if (o.type === "digitize") {
        const n = s.digitized ?? o.boxCount;
        await charge("digitize", n, r.digitizePerBox, `Digitising — ${n} box${n === 1 ? "" : "es"}, ${o.orderNumber}`);
      }
    }

    // --- intake per box registered
    for (const b of newBoxes) {
      const when = day(b.createdAt);
      const card = pickCard(cards, b.clientId, when);
      if (!card) {
        noCard.add(b.clientName);
        continue;
      }
      if (!(card.rates.intakePerBox > 0)) continue;
      await insertCharge(
        tx,
        {
          ...base(b.clientId, b.clientName, card),
          chargeType: "intake",
          sourceType: "box",
          sourceKey: b.id,
          periodStart: when,
          periodEnd: when,
          description: `Intake — ${b.boxNumber}`,
          quantity: dec(1),
          unitPrice: dec(card.rates.intakePerBox),
          amount: dec(card.rates.intakePerBox),
        },
        created
      );
    }

    // --- storage: box-days per client and size, priced from the card in force at the end of the period
    const sizeNames = await getBoxSizeNames();
    const totals = new Map(); // `${clientId}:${size}` -> { clientId, clientName, size, days }
    for (const b of boxes) {
      const days = custodyDays(b, movesByBox.get(b.id) || [], start, endExclusive);
      if (days <= 0) continue;
      const key = `${b.clientId}:${b.size}`;
      const t = totals.get(key) || { clientId: b.clientId, clientName: b.clientName, size: b.size, days: 0 };
      t.days += days;
      totals.set(key, t);
    }
    for (const [key, t] of totals) {
      const card = pickCard(cards, t.clientId, end);
      if (!card) {
        noCard.add(t.clientName);
        continue;
      }
      const monthly = card.rates.storagePerBoxMonth?.[t.size] ?? 0;
      if (!(monthly > 0)) continue;
      const boxMonths = Math.round((t.days / MONTH_DAYS) * 10000) / 10000;
      await insertCharge(
        tx,
        {
          ...base(t.clientId, t.clientName, card),
          chargeType: "storage",
          sourceType: "storage",
          sourceKey: key,
          periodStart: start,
          periodEnd: end,
          description: `Storage — ${Math.round(t.days * 10) / 10} box-days (${sizeNames[t.size] ?? t.size}), ${dateOnly(start)} to ${dateOnly(end)}`,
          quantity: dec(boxMonths),
          unitPrice: dec(monthly),
          amount: dec(boxMonths).mul(monthly).toDecimalPlaces(2),
        },
        created
      );
    }
  }, { maxWait: 10000, timeout: 120000 });

  return {
    created: created.length,
    amount: created.reduce((s, c) => s + Number(c.amount), 0),
    clientsWithoutRateCard: [...noCard].sort(),
  };
}

async function listCharges(params = {}) {
  const where = {};
  if (params.clientId) where.clientId = params.clientId;
  if (params.status) where.status = params.status;
  if (params.billingRunId) where.billingRunId = params.billingRunId;
  if (params.from || params.to) {
    where.periodEnd = {};
    if (params.from) where.periodEnd.gte = toDate(params.from);
    if (params.to) where.periodEnd.lte = toDate(params.to);
  }
  const { skip, take } = parsePagination(params);
  const [items, total, sum] = await Promise.all([
    prisma.chargeEvent.findMany({ where, orderBy: [{ periodEnd: "desc" }, { clientName: "asc" }, { id: "asc" }], skip, take }),
    prisma.chargeEvent.count({ where }),
    prisma.chargeEvent.aggregate({ where: { ...where, status: where.status ?? { not: "voided" } }, _sum: { amount: true } }),
  ]);
  return { items: items.map(serializeCharge), total, amount: num(sum._sum.amount) ?? 0 };
}

async function addManualCharge(input, actor) {
  const clientId = String(input.clientId || "").trim();
  const clientName = String(input.clientName || "").trim();
  if (!clientId || !clientName) throw httpError(400, "clientId and clientName are required");
  const description = String(input.description || "").trim();
  if (!description) throw httpError(400, "description is required");
  const quantity = Number(input.quantity);
  const unitPrice = Number(input.unitPrice);
  if (!(quantity > 0) || quantity > 1e6) throw httpError(400, "quantity must be more than 0");
  if (!(unitPrice >= 0) || unitPrice > 1e9) throw httpError(400, "unitPrice must be 0 or more");
  const when = toDate(input.date) || day(new Date());
  const { TAX_RATE_ID } = require("./sageSettingsService");
  const taxRateId = String(input.taxRateId || "").trim().toUpperCase();
  if (!TAX_RATE_ID.test(taxRateId)) throw httpError(400, "taxRateId must be a Sage tax rate id such as GB_STANDARD");
  return prisma.$transaction(async (tx) => {
    const charge = await tx.chargeEvent.create({
      data: {
        clientId,
        clientName,
        chargeType: "other",
        sourceType: "manual",
        sourceKey: require("crypto").randomUUID(),
        periodStart: when,
        periodEnd: when,
        description: description.slice(0, 500),
        quantity: dec(quantity),
        unitPrice: dec(Math.round(unitPrice * 100) / 100),
        amount: dec(quantity).mul(Math.round(unitPrice * 100) / 100).toDecimalPlaces(2),
        taxRateId,
        createdBy: actor,
      },
    });
    await appendAdminEvent("charge_added", actor, { entityType: "charge", entityId: charge.id, summary: `Added charge for ${clientName}: ${description}` }, tx);
    return serializeCharge(charge);
  });
}

// Only an open charge that isn't in a billing run can be voided (a reviewed run is fixed until discarded).
async function voidCharge(id, reason, actor) {
  const text = String(reason || "").trim();
  if (!text) throw httpError(400, "Say why the charge is voided");
  return prisma.$transaction(async (tx) => {
    const charge = await tx.chargeEvent.findUnique({ where: { id } });
    if (!charge) throw httpError(404, "Charge not found");
    if (charge.status !== "open") throw httpError(409, `This charge is ${charge.status}`);
    if (charge.billingRunId) throw httpError(409, "This charge is in a billing run — discard the run first");
    const updated = await tx.chargeEvent.update({ where: { id }, data: { status: "voided", voidReason: text.slice(0, 1000) } });
    await appendAdminEvent("charge_voided", actor, { entityType: "charge", entityId: id, summary: `Voided charge for ${charge.clientName}: ${charge.description} — ${text}` }, tx);
    return serializeCharge(updated);
  });
}

module.exports = { generateCharges, listCharges, addManualCharge, voidCharge, serializeCharge, custodyDays, parsePeriod };
