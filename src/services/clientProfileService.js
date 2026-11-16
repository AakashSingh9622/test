// Client master details and per-contact permissions (Docbox "Clientes" and "Contactos - Clientes").
// The client and its contacts live in DocuSoft; this adds the SAP code, tax ID and address the warehouse needs, and
// two switches per contact: may they ask for loans, may they ask for destruction.
const prisma = require("../config/prisma");
const { appendAdminEvent } = require("./adminAuditService");
const httpError = require("../utils/httpError");

const text = (v) => (v === undefined || v === null ? "" : String(v).trim());
const LIMITS = { sapCode: 40, taxId: 40, address: 300, postcode: 20, city: 100, province: 100 };
const FIELDS = Object.keys(LIMITS);
const normEmail = (e) => text(e).toLowerCase();

const EMPTY = { sapCode: "", taxId: "", address: "", postcode: "", city: "", province: "", deliveryColumns: [] };

// What a client's delivery note may list per box, besides the box number. Custom field codes (C1, C2 ...) are allowed too.
const DELIVERY_COLUMNS = ["description", "department", "reference", "filingDates", "retention", "size", "pallet"];
const MAX_DELIVERY_COLUMNS = 12;

// Keeps order, drops repeats; unknown keys are an error so a typo isn't silently ignored.
function cleanDeliveryColumns(value) {
  if (!Array.isArray(value)) throw httpError(400, "deliveryColumns must be a list");
  const out = [];
  for (const raw of value) {
    const key = text(raw);
    if (!DELIVERY_COLUMNS.includes(key) && !/^C\d{1,3}$/.test(key)) throw httpError(400, `Unknown delivery-note column "${key}"`);
    if (!out.includes(key)) out.push(key);
  }
  if (out.length > MAX_DELIVERY_COLUMNS) throw httpError(400, `At most ${MAX_DELIVERY_COLUMNS} columns on a delivery note`);
  return out;
}

async function getProfile(clientId) {
  const id = text(clientId);
  if (!id) throw httpError(400, "clientId is required");
  const row = await prisma.clientProfile.findUnique({ where: { clientId: id } });
  if (!row) return { clientId: id, ...EMPTY };
  return {
    clientId: id,
    ...Object.fromEntries(FIELDS.map((f) => [f, row[f] ?? ""])),
    deliveryColumns: Array.isArray(row.deliveryColumns) ? row.deliveryColumns : [],
  };
}

async function saveProfile(clientId, body, actor) {
  const id = text(clientId);
  if (!id) throw httpError(400, "clientId is required");
  const data = {};
  for (const f of FIELDS) {
    if (body[f] === undefined) continue;
    const v = text(body[f]);
    if (v.length > LIMITS[f]) throw httpError(400, `${f} is too long (${LIMITS[f]} characters at most)`);
    data[f] = v || null;
  }
  if (body.deliveryColumns !== undefined) data.deliveryColumns = cleanDeliveryColumns(body.deliveryColumns);
  if (!Object.keys(data).length) return getProfile(id);
  await prisma.$transaction(async (tx) => {
    await tx.clientProfile.upsert({
      where: { clientId: id },
      create: { clientId: id, ...data, updatedBy: actor },
      update: { ...data, updatedBy: actor },
    });
    await appendAdminEvent(
      "client_profile_saved",
      actor,
      { entityType: "settings", entityId: `client-profile:${id}`, summary: `Changed the details of client ${id}` },
      tx
    );
  });
  return getProfile(id);
}

async function listContactPermissions(clientId) {
  const id = text(clientId);
  if (!id) throw httpError(400, "clientId is required");
  const rows = await prisma.contactPermission.findMany({ where: { clientId: id } });
  return rows.map((r) => ({ email: r.email, canLoan: r.canLoan, canPurge: r.canPurge }));
}

async function setContactPermission(clientId, email, body, actor) {
  const id = text(clientId);
  const mail = normEmail(email);
  if (!id || !mail) throw httpError(400, "clientId and email are required");
  const data = {};
  if (body.canLoan !== undefined) data.canLoan = Boolean(body.canLoan);
  if (body.canPurge !== undefined) data.canPurge = Boolean(body.canPurge);
  if (!Object.keys(data).length) throw httpError(400, "Send canLoan and / or canPurge");
  const row = await prisma.$transaction(async (tx) => {
    const saved = await tx.contactPermission.upsert({
      where: { clientId_email: { clientId: id, email: mail } },
      create: { clientId: id, email: mail, ...data, updatedBy: actor },
      update: { ...data, updatedBy: actor },
    });
    await appendAdminEvent(
      "contact_permission_saved",
      actor,
      { entityType: "settings", entityId: `contact:${id}:${mail}`, summary: `Contact ${mail} of client ${id}: ${Object.entries(data).map(([k, v]) => `${k} ${v ? "on" : "off"}`).join(", ")}` },
      tx
    );
    return saved;
  });
  return { email: row.email, canLoan: row.canLoan, canPurge: row.canPurge };
}

// The portal asks before creating an order: a contact switched off for loans / destruction can't request them.
// (No row, or the flag still on = allowed, so existing contacts keep working.)
async function assertContactMay(clientId, email, orderType) {
  const kind = orderType === "destruction" ? "canPurge" : orderType === "dispatch" || orderType === "digitize" ? "canLoan" : null;
  if (!kind) return;
  const row = await prisma.contactPermission.findUnique({ where: { clientId_email: { clientId: text(clientId), email: normEmail(email) } } });
  if (row && row[kind] === false) {
    throw httpError(403, kind === "canPurge" ? "You are not allowed to request destruction. Ask your main contact." : "You are not allowed to request boxes or scans. Ask your main contact.");
  }
}

module.exports = { getProfile, saveProfile, listContactPermissions, setContactPermission, assertContactMay };
