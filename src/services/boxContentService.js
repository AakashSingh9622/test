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

module.exports = { listContents, addContent, removeContent, serializeContent };
