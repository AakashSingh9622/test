// Box sizes (Sprint 11): the two built-in ones (standard, large) plus any an admin adds -- each a name and the length
// (cm) one box takes along a rack cell. Stored in box_size_config, keyed by a stable code made from the first name, so
// renaming a size never touches the boxes that use it. A size in use can only be retired (no new boxes), not deleted.
// Lengths are read on every registration / slot suggestion, so they are cached briefly and the cache is cleared on change.
const prisma = require("../config/prisma");
const { BOX_LENGTH_CM } = require("../utils/dimensions");
const httpError = require("../utils/httpError");
const { appendAdminEvent } = require("./adminAuditService");

const BUILT_IN = { standard: "Standard", large: "Large" }; // can be renamed / resized / retired, never deleted
const MIN_CM = 1;
const MAX_CM = 1000;
const CACHE_MS = 30_000;

let cache = null; // { at, rows }

// The built-in rows are created on first use (older databases only had a row once a length was changed).
async function allRows() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  let rows = await prisma.boxSizeConfig.findMany();
  const missing = Object.keys(BUILT_IN).filter((code) => !rows.some((r) => r.size === code));
  if (missing.length) {
    await prisma.boxSizeConfig.createMany({
      data: missing.map((code) => ({ size: code, lengthCm: BOX_LENGTH_CM[code], sortOrder: 0 })),
      skipDuplicates: true,
    });
    rows = await prisma.boxSizeConfig.findMany();
  }
  rows.sort((a, b) => a.sortOrder - b.sortOrder || a.lengthCm - b.lengthCm || a.size.localeCompare(b.size));
  cache = { at: Date.now(), rows };
  return rows;
}

const nameOf = (row) => row.name || BUILT_IN[row.size] || row.size;

// { code: lengthCm } for every size (retired too -- old boxes still need their length). Callers fall back to the
// standard length for a code they don't know.
async function getBoxSizes() {
  const value = { ...BOX_LENGTH_CM };
  for (const r of await allRows()) value[r.size] = r.lengthCm;
  return value;
}

// { code: name } -- for CSV export, the portal, charge descriptions.
async function getBoxSizeNames() {
  const value = { ...BUILT_IN };
  for (const r of await allRows()) value[r.size] = nameOf(r);
  return value;
}

async function boxCountsBySize() {
  const groups = await prisma.box.groupBy({ by: ["size"], _count: { _all: true } });
  return new Map(groups.map((g) => [g.size, g._count._all]));
}

function serialize(row, counts) {
  return {
    code: row.size,
    name: nameOf(row),
    lengthCm: row.lengthCm,
    active: row.active,
    builtIn: row.size in BUILT_IN,
    boxCount: counts?.get(row.size) ?? 0,
    updatedAt: row.updatedAt.toISOString(),
    ...(row.updatedBy && { updatedBy: row.updatedBy }),
  };
}

// For the settings screen and every size picker: all sizes (retired ones flagged), with how many boxes use each.
async function listBoxSizes() {
  const [rows, counts] = await Promise.all([allRows(), boxCountsBySize()]);
  const last = rows.filter((r) => r.updatedBy).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return {
    items: rows.map((r) => serialize(r, counts)),
    sizes: Object.fromEntries(rows.map((r) => [r.size, r.lengthCm])), // older shape: { code: lengthCm }
    defaults: { ...BOX_LENGTH_CM },
    updatedAt: last ? last.updatedAt.toISOString() : null,
    updatedBy: last ? last.updatedBy : null,
  };
}

function cleanLength(v, label = "length") {
  const n = Number(v);
  if (!Number.isInteger(n) || n < MIN_CM || n > MAX_CM) {
    throw httpError(400, `${label} must be a whole number of cm between ${MIN_CM} and ${MAX_CM}`);
  }
  return n;
}

function cleanName(v) {
  const name = String(v ?? "").trim().replace(/\s+/g, " ");
  if (!name) throw httpError(400, "A box size needs a name");
  if (name.length > 40) throw httpError(400, "A box size name is at most 40 characters");
  return name;
}

async function assertNameFree(name, exceptCode) {
  const taken = (await allRows()).find((r) => r.size !== exceptCode && nameOf(r).toLowerCase() === name.toLowerCase());
  if (taken) throw httpError(409, `There is already a box size called "${nameOf(taken)}"`);
}

// "Archive XL" -> "archive-xl" (made unique with -2, -3 ...).
async function codeFor(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "size";
  const taken = new Set((await allRows()).map((r) => r.size));
  let code = base;
  for (let i = 2; taken.has(code); i++) code = `${base}-${i}`;
  return code;
}

async function createBoxSize({ name, lengthCm }, actor) {
  const clean = cleanName(name);
  const length = cleanLength(lengthCm);
  await assertNameFree(clean);
  const code = await codeFor(clean);
  const sortOrder = Math.max(0, ...(await allRows()).map((r) => r.sortOrder)) + 1;
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.boxSizeConfig.create({
      data: { size: code, name: clean, lengthCm: length, sortOrder, updatedBy: actor },
    });
    await appendAdminEvent(
      "box_size_created",
      actor,
      { entityType: "settings", entityId: `box-size:${code}`, summary: `Added box size ${clean} (${length} cm)` },
      tx
    );
    return created;
  });
  cache = null;
  return serialize(row);
}

// Rename, change the length (boxes already registered keep theirs, so slot space stays right), retire / bring back.
async function updateBoxSize(code, { name, lengthCm, active }, actor) {
  const row = (await allRows()).find((r) => r.size === code);
  if (!row) throw httpError(404, "Box size not found");
  const data = {};
  const changes = [];
  if (name !== undefined) {
    const clean = cleanName(name);
    if (clean !== nameOf(row)) {
      await assertNameFree(clean, code);
      data.name = clean;
      changes.push({ field: "name", from: nameOf(row), to: clean });
    }
  }
  if (lengthCm !== undefined) {
    const length = cleanLength(lengthCm);
    if (length !== row.lengthCm) {
      data.lengthCm = length;
      changes.push({ field: "length (cm)", from: row.lengthCm, to: length });
    }
  }
  if (active !== undefined && Boolean(active) !== row.active) {
    if (!active && !(await allRows()).some((r) => r.active && r.size !== code)) {
      throw httpError(409, "Keep at least one box size in use");
    }
    data.active = Boolean(active);
    changes.push({ field: "state", from: row.active ? "in use" : "retired", to: active ? "in use" : "retired" });
  }
  if (!changes.length) return serialize(row, await boxCountsBySize());
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.boxSizeConfig.update({ where: { size: code }, data: { ...data, updatedBy: actor } });
    await appendAdminEvent(
      "box_sizes_updated",
      actor,
      {
        entityType: "settings",
        entityId: `box-size:${code}`,
        summary: `Box size ${nameOf(row)}: ${changes.map((c) => `${c.field} ${c.from} → ${c.to}`).join(", ")}`,
        changes,
      },
      tx
    );
    return u;
  });
  cache = null;
  return serialize(updated, await boxCountsBySize());
}

// Only a size no box has ever used, and never a built-in one -- otherwise retire it.
async function deleteBoxSize(code, actor) {
  const row = (await allRows()).find((r) => r.size === code);
  if (!row) throw httpError(404, "Box size not found");
  if (code in BUILT_IN) throw httpError(409, `${nameOf(row)} is built in — retire it instead of removing it`);
  const used = await prisma.box.count({ where: { size: code } });
  if (used) {
    throw httpError(409, `${used} box${used === 1 ? " uses" : "es use"} ${nameOf(row)} — retire it instead, so it isn't offered for new boxes`);
  }
  await prisma.$transaction(async (tx) => {
    await tx.boxSizeConfig.delete({ where: { size: code } });
    await appendAdminEvent(
      "box_size_deleted",
      actor,
      { entityType: "settings", entityId: `box-size:${code}`, summary: `Removed box size ${nameOf(row)}` },
      tx
    );
  });
  cache = null;
}

// Registering / correcting boxes: the size must exist and be in use (not retired).
async function assertUsableSize(code) {
  const row = (await allRows()).find((r) => r.size === code);
  if (!row) throw httpError(400, `Unknown box size "${code}"`);
  if (!row.active) throw httpError(400, `Box size ${nameOf(row)} is retired — choose another`);
  return row;
}

// Older settings call: PUT { standard: 45, large: 90 } -- sets lengths by code.
async function updateBoxSizes(input, actor) {
  const codes = Object.keys(input || {});
  if (!codes.length) throw httpError(400, "Send at least one size and its length");
  for (const code of codes) await updateBoxSize(code, { lengthCm: cleanLength(input[code], `${code} length`) }, actor);
  return listBoxSizes();
}

module.exports = {
  getBoxSizes,
  getBoxSizeNames,
  listBoxSizes,
  getBoxSizeSettings: listBoxSizes,
  createBoxSize,
  updateBoxSize,
  deleteBoxSize,
  assertUsableSize,
  updateBoxSizes,
};
