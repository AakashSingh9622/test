// Settings stored in the app_setting table (key/value). Read live from the database every time, so a change
// (UPDATE app_setting SET value = '0007' WHERE key = 'defaultDatabase') takes effect immediately, with no deploy.
const prisma = require("../config/prisma");

const DEFAULT_DATABASE_KEY = "defaultDatabase";

// The agreement number (agrno) this system is for, e.g. "0003". null = not configured.
async function getDefaultDatabase() {
  const row = await prisma.appSetting.findUnique({ where: { key: DEFAULT_DATABASE_KEY } });
  const value = row ? String(row.value).trim() : "";
  return value || null;
}

// Same agrno? (case-insensitive, ignores spaces)
function sameAgreement(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

module.exports = { DEFAULT_DATABASE_KEY, getDefaultDatabase, sameAgreement };
