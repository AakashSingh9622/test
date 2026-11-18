// Docbox "Expedientes - Clientes": a client's files (PLANOS, ...). A client may have none (then nothing changes for it), one
// or several. Each has a code (upper case, unique per client, never changes) and a description. Custom fields can belong
// to one expediente (customFieldService). An expediente with boxes can't be deleted (its own fields go with it).
const prisma = require("../config/prisma");
const { appendAdminEvent } = require("./adminAuditService");
const httpError = require("../utils/httpError");
const { cleanDeliveryColumns } = require("./clientProfileService");

// Docbox "Formato": the delivery-note templates. Albaran is the plain list; Apaisado prints landscape; Cod adds the
// internal code (the box barcode); Akte groups the boxes by the first field of the ordering.
const FORMATS = ["Albaran", "AlbaranApaisado", "AlbaranCod", "AlbaranCodApaisado", "AlbaranAkte"];

const text = (v) => (v === undefined || v === null ? "" : String(v).trim());

const serialize = (e) => ({
  id: e.id,
  clientId: e.clientId,
  code: e.code,
  description: e.description,
  format: e.format,
  deliveryColumns: Array.isArray(e.deliveryColumns) ? e.deliveryColumns : [],
  createdAt: e.createdAt.toISOString(),
});

async function listExpedientes(clientId) {
  const id = text(clientId);
  if (!id) throw httpError(400, "clientId is required");
  const rows = await prisma.expediente.findMany({ where: { clientId: id }, orderBy: { code: "asc" } });
  return rows.map(serialize);
}

async function createExpediente(input, actor) {
  const clientId = text(input.clientId);
  if (!clientId) throw httpError(400, "clientId is required");
  const code = text(input.code).toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z0-9][A-Z0-9_-]{0,29}$/.test(code)) throw httpError(400, "The code is 1 to 30 letters, numbers, - or _ (no spaces), e.g. PLANOS");
  const description = text(input.description).replace(/\s+/g, " ");
  if (!description) throw httpError(400, "A description is required");
  if (description.length > 200) throw httpError(400, "The description is at most 200 characters");
  if ((await prisma.expediente.count({ where: { clientId } })) >= 50) throw httpError(409, "At most 50 expedientes per client");
  const clash = await prisma.expediente.findFirst({ where: { clientId, code } });
  if (clash) throw httpError(409, `This client already has an expediente ${code}`);
  const row = await prisma.$transaction(async (tx) => {
    const format = input.format === undefined || input.format === "" ? "Albaran" : cleanFormat(input.format);
    const deliveryColumns = input.deliveryColumns === undefined ? [] : cleanDeliveryColumns(input.deliveryColumns);
    const created = await tx.expediente.create({ data: { clientId, code, description, format, deliveryColumns, createdBy: actor } });
    await appendAdminEvent("expediente_saved", actor, { entityType: "settings", entityId: `expediente:${clientId}:${code}`, summary: `Added expediente ${code} for client ${clientId}` }, tx);
    return created;
  });
  return serialize(row);
}

function cleanFormat(value) {
  const f = text(value);
  if (!FORMATS.includes(f)) throw httpError(400, `Format must be one of: ${FORMATS.join(", ")}`);
  return f;
}

// The description, the delivery-note format and the order of its fields can change; the code is how boxes and fields
// refer to it, so it stays. Send only what changes.
async function updateExpediente(id, patch, actor) {
  const row = await prisma.expediente.findUnique({ where: { id } });
  if (!row) throw httpError(404, "Expediente not found");
  const data = {};
  const changes = [];
  if (patch.description !== undefined) {
    const description = text(patch.description).replace(/\s+/g, " ");
    if (!description) throw httpError(400, "A description is required");
    if (description.length > 200) throw httpError(400, "The description is at most 200 characters");
    if (description !== row.description) {
      data.description = description;
      changes.push({ field: "description", from: row.description, to: description });
    }
  }
  if (patch.format !== undefined) {
    const format = cleanFormat(patch.format);
    if (format !== row.format) {
      data.format = format;
      changes.push({ field: "format", from: row.format, to: format });
    }
  }
  if (patch.deliveryColumns !== undefined) {
    const columns = cleanDeliveryColumns(patch.deliveryColumns);
    // a field code must be one of this client's fields that applies to this expediente
    const codes = columns.filter((c) => /^C\d+$/.test(c));
    if (codes.length) {
      const known = await prisma.customFieldDef.findMany({
        where: { clientId: row.clientId, code: { in: codes }, OR: [{ expedienteId: null }, { expedienteId: id }] },
        select: { code: true },
      });
      const missing = codes.filter((c) => !known.some((k) => k.code === c));
      if (missing.length) throw httpError(400, `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not a field of this expediente`);
    }
    if (JSON.stringify(columns) !== JSON.stringify(row.deliveryColumns ?? [])) {
      data.deliveryColumns = columns;
      changes.push({ field: "deliveryColumns", from: row.deliveryColumns ?? [], to: columns });
    }
  }
  if (!changes.length) return serialize(row);
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.expediente.update({ where: { id }, data });
    await appendAdminEvent(
      "expediente_saved",
      actor,
      { entityType: "settings", entityId: `expediente:${row.clientId}:${row.code}`, summary: `Changed ${changes.map((c) => c.field).join(", ")} of expediente ${row.code} for client ${row.clientId}`, changes },
      tx
    );
    return u;
  });
  return serialize(updated);
}

async function deleteExpediente(id, actor) {
  const row = await prisma.expediente.findUnique({ where: { id } });
  if (!row) throw httpError(404, "Expediente not found");
  const boxes = await prisma.box.count({ where: { expedienteId: id } });
  if (boxes > 0) throw httpError(409, `${row.code} has ${boxes} box${boxes === 1 ? "" : "es"} and can't be deleted`);
  // No box is in it, so no value of its own fields exists anywhere: they go with it.
  await prisma.$transaction(async (tx) => {
    await tx.customFieldDef.deleteMany({ where: { expedienteId: id } });
    await tx.expediente.delete({ where: { id } });
    await tx.adminAuditEvent.create({
      data: { action: "expediente_saved", entityType: "settings", entityId: `expediente:${row.clientId}:${row.code}`, summary: `Deleted expediente ${row.code} of client ${row.clientId}`, actor, at: new Date() },
    });
  });
  return { ok: true };
}

/** The expediente a box is being put in: it must be the client's own; a client that has expedientes must name one. */
async function resolveForBox(clientId, expedienteId, db = prisma) {
  const id = text(expedienteId);
  if (id) {
    const e = await db.expediente.findUnique({ where: { id } });
    if (!e || e.clientId !== clientId) throw httpError(400, "That expediente doesn't belong to this client");
    return { id: e.id, code: e.code };
  }
  if ((await db.expediente.count({ where: { clientId } })) > 0) throw httpError(400, "Choose the expediente these boxes belong to");
  return { id: null, code: null };
}

module.exports = { FORMATS, listExpedientes, createExpediente, updateExpediente, deleteExpediente, resolveForBox };
