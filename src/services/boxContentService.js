// What is inside a box (file-level index, spec §3 "Contents and DMS links"), optionally pointing at the DocuSoft
// document the file was scanned into. Each change is in the box history.
const prisma = require("../config/prisma");
const httpError = require("../utils/httpError");
const { dateOnly, toDate } = require("../utils/serialize");
const { appendAuditEvent } = require("./auditService");

function serializeContent(c) {
  const out = {
    id: c.id,
    boxId: c.boxId,
    description: c.description,
    reference: c.reference,
    dateFrom: dateOnly(c.dateFrom),
    dateTo: dateOnly(c.dateTo),
    docusoftDocumentId: c.docusoftDocumentId,
    createdBy: c.createdBy,
    createdAt: c.createdAt.toISOString(),
  };
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

async function listContents(boxId) {
  const rows = await prisma.boxContent.findMany({ where: { boxId }, orderBy: [{ dateFrom: "asc" }, { createdAt: "asc" }] });
  return rows.map(serializeContent);
}

async function addContent(boxId, input, actor) {
  const description = String(input.description || "").trim();
  if (!description) throw httpError(400, "description is required");
  const dateFrom = input.dateFrom ? toDate(input.dateFrom) : null;
  const dateTo = input.dateTo ? toDate(input.dateTo) : null;
  if ((dateFrom && Number.isNaN(dateFrom.getTime())) || (dateTo && Number.isNaN(dateTo.getTime()))) throw httpError(400, "Dates must be YYYY-MM-DD");
  if (dateFrom && dateTo && dateTo < dateFrom) throw httpError(400, "The date range ends before it starts");
  return prisma.$transaction(async (tx) => {
    const box = await tx.box.findUnique({ where: { id: boxId } });
    if (!box) throw httpError(404, "Box not found");
    if (box.status === "destroyed") throw httpError(400, `${box.boxNumber} is destroyed`);
    const row = await tx.boxContent.create({
      data: {
        boxId,
        description: description.slice(0, 500),
        reference: input.reference ? String(input.reference).trim().slice(0, 200) : null,
        dateFrom,
        dateTo,
        docusoftDocumentId: input.docusoftDocumentId ? String(input.docusoftDocumentId).trim().slice(0, 100) : null,
        createdBy: actor,
      },
    });
    await appendAuditEvent(box, "contents_changed", actor, { note: `Added: ${row.description}` }, tx);
    return serializeContent(row);
  });
}

async function removeContent(boxId, contentId, actor) {
  return prisma.$transaction(async (tx) => {
    const row = await tx.boxContent.findFirst({ where: { id: contentId, boxId } });
    if (!row) throw httpError(404, "Content line not found");
    await tx.boxContent.delete({ where: { id: contentId } });
    const box = await tx.box.findUnique({ where: { id: boxId } });
    await appendAuditEvent(box, "contents_changed", actor, { note: `Removed: ${row.description}` }, tx);
    return { ok: true };
  });
}

// Docbox "Modificar" on a record: change its description, reference, dates or DocuSoft link. Changes go in the box history.
async function updateContent(boxId, contentId, input, actor) {
  const description = String(input.description ?? "").trim();
  if (!description) throw httpError(400, "description is required");
  const dateFrom = input.dateFrom ? toDate(input.dateFrom) : null;
  const dateTo = input.dateTo ? toDate(input.dateTo) : null;
  if ((dateFrom && Number.isNaN(dateFrom.getTime())) || (dateTo && Number.isNaN(dateTo.getTime()))) throw httpError(400, "Dates must be YYYY-MM-DD");
  if (dateFrom && dateTo && dateTo < dateFrom) throw httpError(400, "The date range ends before it starts");
  const reference = input.reference ? String(input.reference).trim().slice(0, 200) : null;
  const docusoftDocumentId = input.docusoftDocumentId ? String(input.docusoftDocumentId).trim().slice(0, 100) : null;
  return prisma.$transaction(async (tx) => {
    const row = await tx.boxContent.findFirst({ where: { id: contentId, boxId } });
    if (!row) throw httpError(404, "Content line not found");
    const box = await tx.box.findUnique({ where: { id: boxId } });
    if (box.status === "destroyed") throw httpError(400, `${box.boxNumber} is destroyed`);
    const next = { description: description.slice(0, 500), reference, dateFrom, dateTo, docusoftDocumentId };
    const changed = [];
    const was = (v) => (v === null || v === undefined || v === "" ? "empty" : String(v));
    if (next.description !== row.description) changed.push(`description '${row.description}' → '${next.description}'`);
    if (next.reference !== (row.reference ?? null)) changed.push(`reference '${was(row.reference)}' → '${was(next.reference)}'`);
    if (dateOnly(dateFrom) !== dateOnly(row.dateFrom)) changed.push(`date from ${was(dateOnly(row.dateFrom))} → ${was(dateOnly(dateFrom))}`);
    if (dateOnly(dateTo) !== dateOnly(row.dateTo)) changed.push(`date to ${was(dateOnly(row.dateTo))} → ${was(dateOnly(dateTo))}`);
    if (next.docusoftDocumentId !== (row.docusoftDocumentId ?? null)) changed.push("DocuSoft document changed");
    if (changed.length === 0) return serializeContent(row);
    const updated = await tx.boxContent.update({ where: { id: contentId }, data: next });
    await appendAuditEvent(box, "contents_changed", actor, { note: `Edited: ${changed.join("; ")}` }, tx);
    return serializeContent(updated);
  });
}

// Docbox "Cambio de Ubicación" for a record: it goes from this box into another box of the same client (found by box
// number or barcode). Both boxes get a history line.
async function moveContent(boxId, contentId, input, actor) {
  const code = String(input.toBox ?? "").trim();
  if (!code) throw httpError(400, "toBox (the box number or barcode to move it to) is required");
  const reason = String(input.reason ?? "").trim().slice(0, 300);
  return prisma.$transaction(async (tx) => {
    const row = await tx.boxContent.findFirst({ where: { id: contentId, boxId } });
    if (!row) throw httpError(404, "Content line not found");
    const from = await tx.box.findUnique({ where: { id: boxId } });
    if (from.status === "destroyed") throw httpError(400, `${from.boxNumber} is destroyed`);
    const to = await tx.box.findFirst({
      where: { OR: [{ barcode: { equals: code, mode: "insensitive" } }, { boxNumber: { equals: code, mode: "insensitive" } }] },
    });
    if (!to) throw httpError(404, `No box has the number or barcode ${code}`);
    if (to.id === from.id) throw httpError(400, "That is the same box");
    if (to.clientId !== from.clientId) throw httpError(400, `${to.boxNumber} belongs to a different client`);
    if (to.status === "destroyed") throw httpError(400, `${to.boxNumber} is destroyed`);
    const moved = await tx.boxContent.update({ where: { id: contentId }, data: { boxId: to.id } });
    const why = reason ? ` (${reason})` : "";
    await appendAuditEvent(from, "contents_changed", actor, { note: `Moved to ${to.boxNumber}: ${row.description}${why}` }, tx);
    await appendAuditEvent(to, "contents_changed", actor, { note: `Moved in from ${from.boxNumber}: ${row.description}${why}` }, tx);
    return serializeContent(moved);
  });
}

module.exports = { listContents, addContent, removeContent, updateContent, moveContent, serializeContent };
