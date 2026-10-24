// Staff roles: DocuSoft admin flag (wh_user.isAdmin) + locally assigned roles (user_role). Permission checks always use
// these FRESH roles, not the ones inside the 7-day session token -- a role taken away stops working within CACHE_MS.
const prisma = require("../config/prisma");
const { ASSIGNABLE_ROLES, effectiveRoles } = require("../auth/permissions");
const { getDefaultDatabase, sameAgreement } = require("./appSettingService");
const { appendAdminEvent } = require("./adminAuditService");
const httpError = require("../utils/httpError");

const CACHE_MS = 30_000;
const cache = new Map(); // userId -> { at, email, roles }

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

async function localRolesFor(email, db = prisma) {
  const rows = await db.userRole.findMany({ where: { email: normalizeEmail(email) }, select: { role: true } });
  return rows.map((r) => r.role);
}

// Roles of a logged-in staff user (by wh_user id). null = no such user.
async function rolesForUser(userId) {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.roles;
  const user = await prisma.wHUser.findUnique({ where: { id: String(userId) }, select: { email: true, isAdmin: true } }).catch(() => null);
  if (!user) return null;
  const roles = effectiveRoles(user.isAdmin, await localRolesFor(user.email));
  cache.set(userId, { at: Date.now(), email: user.email, roles });
  return roles;
}

function forgetRoles(email) {
  const e = normalizeEmail(email);
  for (const [userId, entry] of cache) if (entry.email === e) cache.delete(userId);
}

function userRow(email, whUser, localRoles) {
  const roles = localRoles.filter((r) => ASSIGNABLE_ROLES.includes(r));
  return {
    email,
    name: whUser?.name,
    hasLoggedIn: !!whUser,
    lastLoginAt: whUser?.lastLoginAt?.toISOString(),
    docusoftAdmin: !!whUser?.isAdmin,
    roles, // assigned here
    effectiveRoles: effectiveRoles(!!whUser?.isAdmin, roles), // what they can actually do
  };
}

// Everyone who has logged in to this agreement, plus e-mails that were given a role before their first login.
// Staff lists are small (tens of people), so this returns them all.
async function listUsers() {
  const agrno = await getDefaultDatabase();
  const [whUsers, roleRows] = await Promise.all([prisma.wHUser.findMany(), prisma.userRole.findMany({ orderBy: { assignedAt: "asc" } })]);
  const byEmail = new Map();
  for (const u of whUsers) if (!agrno || sameAgreement(u.agreementNo, agrno)) byEmail.set(u.email, { whUser: u, roles: [] });
  for (const r of roleRows) {
    if (!byEmail.has(r.email)) byEmail.set(r.email, { whUser: null, roles: [] });
    byEmail.get(r.email).roles.push(r.role);
  }
  const items = [...byEmail.entries()]
    .map(([email, { whUser, roles }]) => userRow(email, whUser, roles))
    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  return { items, total: items.length };
}

// Replaces the locally assigned roles of one e-mail. Every role added / removed is written to the admin audit log.
async function setUserRoles(rawEmail, rawRoles, actor) {
  const email = normalizeEmail(rawEmail);
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw httpError(400, "A valid e-mail address is required");
  if (!Array.isArray(rawRoles)) throw httpError(400, "roles must be an array");
  const wanted = [...new Set(rawRoles)];
  const bad = wanted.filter((r) => !ASSIGNABLE_ROLES.includes(r));
  if (bad.length) {
    throw httpError(400, `Not an assignable role: ${bad.join(", ")} (staff_admin comes from DocuSoft; use one of ${ASSIGNABLE_ROLES.join(", ")})`);
  }

  await prisma.$transaction(async (tx) => {
    const current = await localRolesFor(email, tx);
    const added = wanted.filter((r) => !current.includes(r));
    const removed = current.filter((r) => !wanted.includes(r));
    if (removed.length) await tx.userRole.deleteMany({ where: { email, role: { in: removed } } });
    if (added.length) await tx.userRole.createMany({ data: added.map((role) => ({ email, role, assignedBy: actor })) });
    for (const role of added) {
      await appendAdminEvent("role_assigned", actor, { entityType: "user", entityId: email, summary: `Gave ${role} to ${email}` }, tx);
    }
    for (const role of removed) {
      await appendAdminEvent("role_removed", actor, { entityType: "user", entityId: email, summary: `Removed ${role} from ${email}` }, tx);
    }
  });
  forgetRoles(email);

  const whUser = await prisma.wHUser.findUnique({ where: { email } });
  return userRow(email, whUser, await localRolesFor(email));
}

module.exports = { rolesForUser, localRolesFor, forgetRoles, listUsers, setUserRoles };
