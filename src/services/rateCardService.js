// Rate cards (spec §7.1): effective-dated prices, one default card (clientId null) plus optional per-client cards.
// A client's own card wins over the default for the dates it covers. Cards are never edited -- a price change is a new
// card from a new date (the previous one is closed the day before), so old charges stay explainable.
const prisma = require("../config/prisma");
const httpError = require("../utils/httpError");
const { dateOnly, toDate } = require("../utils/serialize");
const { appendAdminEvent } = require("./adminAuditService");
const { TAX_RATE_ID } = require("./sageSettingsService");

const PRICE_KEYS = ["intakePerBox", "retrievalPerBox", "deliveryPerOrder", "collectionPerOrder", "destructionPerBox", "digitizePerBox"];

function money(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e6) throw httpError(400, `${name} must be a price from 0 to 1,000,000`);
  return Math.round(n * 100) / 100;
}

// Storage is priced per box size (Sprint 11: any size from Settings → Box sizes, keyed by its code). A size with no
// price on a card is charged 0 -- the rate card screen lists every size so none is forgotten.
function cleanRates(r = {}) {
  const storage = r.storagePerBoxMonth || {};
  const perSize = { standard: 0, large: 0, ...storage };
  const storagePerBoxMonth = {};
  for (const [code, price] of Object.entries(perSize)) {
    if (!/^[a-z0-9-]{1,40}$/.test(code)) throw httpError(400, `Unknown box size "${code}" in the storage prices`);
    storagePerBoxMonth[code] = money(price ?? 0, `storage (${code})`);
  }
  const rates = { storagePerBoxMonth };
  for (const k of PRICE_KEYS) rates[k] = money(r[k] ?? 0, k);
  return rates;
}

function serializeCard(c) {
  const out = {
    id: c.id,
    clientId: c.clientId,
    clientName: c.clientName,
    effectiveFrom: dateOnly(c.effectiveFrom),
    effectiveTo: dateOnly(c.effectiveTo),
    rates: c.rates,
    taxRateId: c.taxRateId,
    notes: c.notes,
    createdBy: c.createdBy,
    createdAt: c.createdAt.toISOString(),
  };
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

async function listCards({ clientId } = {}) {
  const where = clientId === undefined ? {} : { clientId: clientId || null };
  const cards = await prisma.rateCard.findMany({ where, orderBy: [{ clientName: "asc" }, { effectiveFrom: "desc" }] });
  return cards.map(serializeCard);
}

async function createCard(input, actor) {
  const clientId = input.clientId ? String(input.clientId).trim() : null;
  const effectiveFrom = toDate(input.effectiveFrom);
  if (!effectiveFrom || Number.isNaN(effectiveFrom.getTime())) throw httpError(400, "effectiveFrom is required (YYYY-MM-DD)");
  const taxRateId = String(input.taxRateId || "").trim().toUpperCase();
  if (!TAX_RATE_ID.test(taxRateId)) throw httpError(400, "taxRateId must be a Sage tax rate id such as GB_STANDARD");
  const rates = cleanRates(input.rates);

  return prisma.$transaction(async (tx) => {
    const clash = await tx.rateCard.findFirst({ where: { clientId, effectiveFrom } });
    if (clash) throw httpError(409, "There is already a card starting that day — pick another date");
    // Close the card that was running on that date (it ends the day before the new one starts).
    const dayBefore = new Date(effectiveFrom.getTime() - 24 * 60 * 60 * 1000);
    await tx.rateCard.updateMany({
      where: { clientId, effectiveFrom: { lt: effectiveFrom }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveFrom } }] },
      data: { effectiveTo: dayBefore },
    });
    const next = await tx.rateCard.findFirst({ where: { clientId, effectiveFrom: { gt: effectiveFrom } }, orderBy: { effectiveFrom: "asc" } });
    const card = await tx.rateCard.create({
      data: {
        clientId,
        clientName: clientId ? String(input.clientName || clientId).slice(0, 300) : null,
        effectiveFrom,
        effectiveTo: next ? new Date(next.effectiveFrom.getTime() - 24 * 60 * 60 * 1000) : null,
        rates,
        taxRateId,
        notes: input.notes ? String(input.notes).trim().slice(0, 1000) : null,
        createdBy: actor,
      },
    });
    await appendAdminEvent(
      "rate_card_saved",
      actor,
      { entityType: "rate_card", entityId: card.id, summary: `Rate card for ${card.clientName ?? "all clients (default)"} from ${dateOnly(effectiveFrom)}` },
      tx
    );
    return serializeCard(card);
  });
}

// The card that prices `date` for this client: its own card if one covers the date, else the default card.
function pickCard(cards, clientId, date) {
  const covers = (c) => c.effectiveFrom <= date && (!c.effectiveTo || c.effectiveTo >= date);
  const own = cards.filter((c) => c.clientId === clientId && covers(c)).sort((a, b) => b.effectiveFrom - a.effectiveFrom)[0];
  if (own) return own;
  return cards.filter((c) => c.clientId === null && covers(c)).sort((a, b) => b.effectiveFrom - a.effectiveFrom)[0] || null;
}

module.exports = { listCards, createCard, pickCard, serializeCard };
