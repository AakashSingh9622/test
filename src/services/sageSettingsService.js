// Sage One defaults for this agreement, kept in app_setting (key "sage", JSON). The Sage connection itself (tokens,
// client key/secret) lives in the browser like DocuSoft Practice -- the backend never sees it. These are only the
// choices that should be the same for every user: default ledger account, default VAT rate, payment terms.
const prisma = require("../config/prisma");
const httpError = require("../utils/httpError");
const { appendAdminEvent } = require("./adminAuditService");

const KEY = "sage";
const DEFAULTS = {
  defaultLedgerAccountId: null, // Sage ledger account for invoice lines; null = ask every time
  defaultLedgerAccountName: null, // its displayed_as, for showing without calling Sage
  defaultTaxRateId: "GB_NO_TAX", // same as Practice today; change it if the business is VAT registered
  paymentTermsDays: 30, // due date = invoice date + this
};
const TAX_RATE_ID = /^[A-Z]{2}_[A-Z_]{2,30}$/; // Sage tax rate ids look like GB_STANDARD, GB_ZERO, GB_NO_TAX

async function getSageSettings() {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
  let saved = {};
  try {
    saved = row ? JSON.parse(row.value) : {};
  } catch {
    saved = {};
  }
  return { ...DEFAULTS, ...saved, updatedAt: row?.updatedAt?.toISOString() ?? null, updatedBy: row?.updatedBy ?? null };
}

async function updateSageSettings(input, actor) {
  const current = await getSageSettings();
  const next = {
    defaultLedgerAccountId: current.defaultLedgerAccountId,
    defaultLedgerAccountName: current.defaultLedgerAccountName,
    defaultTaxRateId: current.defaultTaxRateId,
    paymentTermsDays: current.paymentTermsDays,
  };

  if (input.defaultLedgerAccountId !== undefined) {
    const id = input.defaultLedgerAccountId ? String(input.defaultLedgerAccountId).trim() : null;
    next.defaultLedgerAccountId = id;
    next.defaultLedgerAccountName = id ? String(input.defaultLedgerAccountName || "").trim().slice(0, 200) || null : null;
  }
  if (input.defaultTaxRateId !== undefined) {
    const id = String(input.defaultTaxRateId || "").trim().toUpperCase();
    if (!TAX_RATE_ID.test(id)) throw httpError(400, "defaultTaxRateId must be a Sage tax rate id such as GB_STANDARD");
    next.defaultTaxRateId = id;
  }
  if (input.paymentTermsDays !== undefined) {
    const n = Number(input.paymentTermsDays);
    if (!Number.isInteger(n) || n < 0 || n > 365) throw httpError(400, "paymentTermsDays must be a whole number from 0 to 365");
    next.paymentTermsDays = n;
  }

  const changes = Object.keys(next)
    .filter((k) => k !== "defaultLedgerAccountName" && next[k] !== current[k])
    .map((k) => ({ field: k, from: current[k], to: next[k] }));
  if (changes.length === 0) return current;

  await prisma.appSetting.upsert({
    where: { key: KEY },
    update: { value: JSON.stringify(next), updatedBy: actor },
    create: { key: KEY, value: JSON.stringify(next), updatedBy: actor },
  });
  await appendAdminEvent("sage_settings_updated", actor, {
    entityType: "settings",
    entityId: "sage",
    summary: "Sage settings: " + changes.map((c) => `${c.field} ${c.from ?? "—"} → ${c.to ?? "—"}`).join(", "),
    changes,
  });
  return getSageSettings();
}

module.exports = { getSageSettings, updateSageSettings, TAX_RATE_ID };
