// Per-client custom fields (Docbox "Expedientes - Campos"): each client's boxes can carry their own extra columns
// (FOLDER, SUBFOLDER, CONTENTS ...), typed text / date / number and optionally mandatory. The definitions live in
// custom_field_def; the values sit on the box in Box.customFields as { C1: "...", C2: "..." }.
// A field is switched off (active=false), never deleted, so old values never lose their meaning.
const prisma = require("../config/prisma");
const { appendAdminEvent } = require("./adminAuditService");
const httpError = require("../utils/httpError");

const TYPES = ["text", "date", "number"];
const MAX_FIELDS = 30; // per client
const MAX_TEXT = 500;

const text = (v) => (v === undefined || v === null ? "" : String(v).trim());

const serialize = (f) => ({
  id: f.id,
  clientId: f.clientId,
  code: f.code,
  name: f.name,
  fieldType: f.fieldType,
  required: f.required,
  position: f.position,
  active: f.active,
});

async function listFields(clientId, { includeInactive = false } = {}) {
  const id = text(clientId);
  if (!id) throw httpError(400, "clientId is required");
  const rows = await prisma.customFieldDef.findMany({
    where: { clientId: id, ...(includeInactive ? {} : { active: true }) },
    orderBy: { position: "asc" },
  });
  return rows.map(serialize);
}

function cleanName(v) {
  const name = text(v).replace(/\s+/g, " ");
  if (!name) throw httpError(400, "A field needs a name");
  if (name.length > 60) throw httpError(400, "A field name is at most 60 characters");
  return name;
}

async function createField(input, actor) {
  const clientId = text(input.clientId);
  if (!clientId) throw httpError(400, "clientId is required");
  const name = cleanName(input.name);
  const fieldType = text(input.fieldType) || "text";
  if (!TYPES.includes(fieldType)) throw httpError(400, `fieldType must be one of ${TYPES.join(", ")}`);

  const existing = await prisma.customFieldDef.findMany({ where: { clientId } });
  if (existing.length >= MAX_FIELDS) throw httpError(409, `At most ${MAX_FIELDS} fields per client`);
  if (existing.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
    throw httpError(409, `This client already has a field called "${name}"`);
  }
  const next = Math.max(0, ...existing.map((f) => Number(f.code.slice(1)) || 0)) + 1;
  const position = Math.max(0, ...existing.map((f) => f.position)) + 1;

  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.customFieldDef.create({
      data: { clientId, code: `C${next}`, name, fieldType, required: Boolean(input.required), position, createdBy: actor },
    });
    await appendAdminEvent(
      "custom_field_saved",
      actor,
      { entityType: "settings", entityId: `custom-field:${clientId}:${created.code}`, summary: `Added field ${name} (${fieldType}) for client ${clientId}` },
      tx
    );
    return created;
  });
  return serialize(row);
}

// Name, mandatory flag and on/off can change; the type can't (existing values would stop making sense).
async function updateField(id, patch, actor) {
  const row = await prisma.customFieldDef.findUnique({ where: { id } });
  if (!row) throw httpError(404, "Field not found");
  const data = {};
  if (patch.name !== undefined) {
    const name = cleanName(patch.name);
    if (name.toLowerCase() !== row.name.toLowerCase()) {
      const clash = await prisma.customFieldDef.findFirst({
        where: { clientId: row.clientId, id: { not: id }, name: { equals: name, mode: "insensitive" } },
      });
      if (clash) throw httpError(409, `This client already has a field called "${name}"`);
    }
    data.name = name;
  }
  if (patch.required !== undefined) data.required = Boolean(patch.required);
  if (patch.active !== undefined) data.active = Boolean(patch.active);
  if (patch.fieldType !== undefined && patch.fieldType !== row.fieldType) throw httpError(400, "The type of a field can't be changed");
  if (!Object.keys(data).length) return serialize(row);
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.customFieldDef.update({ where: { id }, data });
    await appendAdminEvent(
      "custom_field_saved",
      actor,
      { entityType: "settings", entityId: `custom-field:${row.clientId}:${row.code}`, summary: `Changed field ${row.name} for client ${row.clientId}` },
      tx
    );
    return u;
  });
  return serialize(updated);
}

// "28/10/2026" or "2026-10-28" -> "2026-10-28"; "" -> null; anything else -> undefined (not a date).
function parseDate(value) {
  const v = text(value);
  if (!v) return null;
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : dmy ? `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}` : null;
  if (!iso) return undefined;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? undefined : iso;
}

// Checks the values a box is being given against the client's ACTIVE fields.
//   values   { C1: "...", ... } (unknown codes are an error)
//   partial  true when editing: only the codes present are checked and mandatory fields aren't demanded
// Returns { clean, problems }: clean = { code: value } with "" removed; problems = ["Field X: ..."].
function checkValues(defs, values, { partial = false } = {}) {
  const input = values && typeof values === "object" && !Array.isArray(values) ? values : {};
  const byCode = new Map(defs.map((d) => [d.code, d]));
  const problems = [];
  const clean = {};
  for (const code of Object.keys(input)) {
    if (!byCode.has(code)) problems.push(`unknown field ${code}`);
  }
  for (const def of defs) {
    const present = Object.prototype.hasOwnProperty.call(input, def.code);
    if (partial && !present) continue;
    const raw = text(input[def.code]);
    if (!raw) {
      if (def.required && !partial) problems.push(`${def.name} is required`);
      else if (def.required && partial) problems.push(`${def.name} can't be empty`);
      continue;
    }
    if (def.fieldType === "date") {
      const d = parseDate(raw);
      if (d === undefined) problems.push(`${def.name} is not a date`);
      else clean[def.code] = d;
    } else if (def.fieldType === "number") {
      const n = Number(raw.replace(",", "."));
      if (!Number.isFinite(n)) problems.push(`${def.name} is not a number`);
      else clean[def.code] = n;
    } else if (raw.length > MAX_TEXT) problems.push(`${def.name} is too long (${MAX_TEXT} characters at most)`);
    else clean[def.code] = raw;
  }
  return { clean, problems };
}

// Same, but throws a 400 -- for the single-box endpoints.
async function cleanValuesOrThrow(clientId, values, opts) {
  const defs = await prisma.customFieldDef.findMany({ where: { clientId, active: true }, orderBy: { position: "asc" } });
  const { clean, problems } = checkValues(defs, values, opts);
  if (problems.length) throw httpError(400, problems.join("; "));
  return clean;
}

module.exports = { listFields, createField, updateField, checkValues, cleanValuesOrThrow, TYPES };
