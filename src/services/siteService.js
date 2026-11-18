// Sites (Docbox "Sedes"): the head offices / places warehouses belong to. A warehouse keeps its site as text
// (warehouse.site, which boxes' locations also carry); the `site` table only lets a site exist before it has a warehouse.
// The list is the registry plus every name a warehouse already uses (so a site typed on a warehouse or in an imported
// layout shows up too). Names are unique ignoring letter case.
const prisma = require("../config/prisma");
const { Prisma } = prisma;
const { appendAdminEvent } = require("./adminAuditService");
const { refreshBoxLocations } = require("./locationService");
const httpError = require("../utils/httpError");

const MAX_SITES = 200;

function cleanName(value) {
  const t = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!t) throw httpError(400, "A site needs a name");
  if (t.length > 80) throw httpError(400, "A site name is at most 80 characters");
  return t;
}
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

// [{ name, warehouseCount, warehouses: [{id, code, name}] }], A-Z. Sites with no warehouse have an empty list.
async function listSites() {
  const [registry, warehouses] = await Promise.all([
    prisma.site.findMany(),
    prisma.warehouse.findMany({ where: { site: { not: null } }, select: { id: true, code: true, name: true, site: true }, orderBy: { code: "asc" } }),
  ]);
  const byKey = new Map();
  for (const r of registry) byKey.set(r.name.toLowerCase(), { name: r.name, warehouses: [] });
  for (const w of warehouses) {
    const key = w.site.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, { name: w.site, warehouses: [] });
    byKey.get(key).warehouses.push({ id: w.id, code: w.code, name: w.name });
  }
  return [...byKey.values()]
    .map((s) => ({ ...s, warehouseCount: s.warehouses.length }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function findSite(name) {
  const wanted = cleanName(name);
  const found = (await listSites()).find((s) => same(s.name, wanted));
  return found ?? null;
}

async function createSite({ name }, actor) {
  const clean = cleanName(name);
  const all = await listSites();
  if (all.length >= MAX_SITES) throw httpError(409, `At most ${MAX_SITES} sites`);
  if (all.some((s) => same(s.name, clean))) throw httpError(409, `There is already a site called ${clean}`);
  await prisma.$transaction(async (tx) => {
    await tx.site.create({ data: { name: clean } });
    await appendAdminEvent("site_saved", actor, { entityType: "settings", entityId: `site:${clean}`, summary: `Added site ${clean}` }, tx);
  });
  return findSite(clean);
}

// Rename: every warehouse of the site moves to the new name and their boxes' shown location is refreshed.
async function renameSite({ name, newName }, actor) {
  const current = await findSite(name);
  if (!current) throw httpError(404, "Site not found");
  const next = cleanName(newName);
  if (next === current.name) return current;
  const all = await listSites();
  if (all.some((s) => same(s.name, next) && !same(s.name, current.name))) throw httpError(409, `There is already a site called ${next}`);
  await prisma.$transaction(async (tx) => {
    await tx.site.deleteMany({ where: { name: { equals: current.name, mode: "insensitive" } } });
    await tx.site.create({ data: { name: next } });
    if (current.warehouseCount) {
      await tx.warehouse.updateMany({ where: { site: { equals: current.name, mode: "insensitive" } }, data: { site: next } });
      await refreshBoxLocations(Prisma.sql`w."site" = ${next}`, tx);
    }
    await appendAdminEvent("site_saved", actor, { entityType: "settings", entityId: `site:${next}`, summary: `Renamed site ${current.name} to ${next}`, changes: [{ field: "name", from: current.name, to: next }] }, tx);
  });
  return findSite(next);
}

// Only a site no warehouse uses can be deleted.
async function deleteSite({ name }, actor) {
  const current = await findSite(name);
  if (!current) throw httpError(404, "Site not found");
  if (current.warehouseCount) throw httpError(409, `${current.name} still has ${current.warehouseCount} warehouse${current.warehouseCount === 1 ? "" : "s"}. Move them to another site (or none) first.`);
  await prisma.$transaction(async (tx) => {
    await tx.site.deleteMany({ where: { name: { equals: current.name, mode: "insensitive" } } });
    await appendAdminEvent("site_deleted", actor, { entityType: "settings", entityId: `site:${current.name}`, summary: `Deleted site ${current.name}` }, tx);
  });
  return { name: current.name };
}

module.exports = { listSites, createSite, renameSite, deleteSite };
