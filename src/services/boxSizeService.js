// Admin-editable box lengths (cm). Stored in box_size_config (one row per BoxSize); defaults from utils/dimensions.js
// are used (and written) if a row is missing. Read on every box registration / slot suggestion, so it is cached
// for a short time and the cache is cleared right after an update.
const prisma = require("../config/prisma");
const { BOX_LENGTH_CM } = require("../utils/dimensions");
const httpError = require("../utils/httpError");

const SIZES = Object.keys(BOX_LENGTH_CM); // ["standard", "large"]
const MIN_CM = 1;
const MAX_CM = 1000;
const CACHE_MS = 30_000;

let cache = null; // { at, value }

async function getBoxSizes() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const rows = await prisma.boxSizeConfig.findMany();
  const value = { ...BOX_LENGTH_CM };
  for (const r of rows) value[r.size] = r.lengthCm;
  cache = { at: Date.now(), value };
  return value;
}

// Details for the settings screen: the lengths plus who changed them last.
async function getBoxSizeSettings() {
  const rows = await prisma.boxSizeConfig.findMany();
  const sizes = await getBoxSizes();
  const last = rows.filter((r) => r.updatedBy).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return {
    sizes,
    defaults: { ...BOX_LENGTH_CM },
    updatedAt: last ? last.updatedAt.toISOString() : null,
    updatedBy: last ? last.updatedBy : null,
  };
}

async function updateBoxSizes(input, actor) {
  const next = {};
  for (const size of SIZES) {
    if (input[size] === undefined) continue;
    const n = Number(input[size]);
    if (!Number.isInteger(n) || n < MIN_CM || n > MAX_CM) {
      throw httpError(400, `${size} length must be a whole number of cm between ${MIN_CM} and ${MAX_CM}`);
    }
    next[size] = n;
  }
  if (Object.keys(next).length === 0) throw httpError(400, "Send at least one of: " + SIZES.join(", "));

  await prisma.$transaction(
    Object.entries(next).map(([size, lengthCm]) =>
      prisma.boxSizeConfig.upsert({
        where: { size },
        update: { lengthCm, updatedBy: actor },
        create: { size, lengthCm, updatedBy: actor },
      })
    )
  );
  cache = null; // (other server instances pick it up within CACHE_MS)
  return getBoxSizeSettings();
}

module.exports = { getBoxSizes, getBoxSizeSettings, updateBoxSizes };
