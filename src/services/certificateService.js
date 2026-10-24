// Certificate of destruction (decided 24 Oct): issued automatically when a destruction order is completed, numbered
// (COD-000001), with its content frozen at issue -- client, order, every box destroyed, method, who authorised /
// approved / carried it out, witness, date and place. Kept for good as audit / compliance proof; the client can print
// it from the portal.
const prisma = require("../config/prisma");
const httpError = require("../utils/httpError");
const { nextSequence } = require("./counterService");
const { dateOnly } = require("../utils/serialize");
const { parsePagination } = require("../utils/pagination");

async function issueCertificate({ order, boxes, destruction, place, actor, signature }, tx) {
  const seq = await nextSequence("certificateSeq", tx);
  const certificateNumber = `COD-${String(seq).padStart(6, "0")}`;
  const content = {
    orderNumber: order.orderNumber,
    clientId: order.clientId,
    clientName: order.clientName,
    method: destruction.method,
    authorisedBy: destruction.authorisedBy,
    authorisedAt: destruction.authorisedAt,
    approvedBy: destruction.approvedBy?.name ?? destruction.approvedBy,
    approvedAt: destruction.approvedAt,
    destroyedBy: actor.name,
    // the signer's signature as it was at this moment (a later change never alters an issued certificate)
    destroyedBySignature: signature || undefined,
    destroyedAt: new Date().toISOString(),
    witness: destruction.witness || undefined,
    place: place || undefined,
    boxes: boxes.map((b) => ({
      boxNumber: b.boxNumber,
      barcode: b.barcode,
      description: b.description,
      reference: b.reference || undefined,
      filingDateFrom: dateOnly(b.filingDateFrom),
      filingDateTo: dateOnly(b.filingDateTo) || undefined,
      retentionCategory: b.retentionCategory || undefined,
    })),
  };
  return tx.destructionCertificate.create({
    data: { certificateNumber, orderId: order.id, clientId: order.clientId, clientName: order.clientName, content, issuedBy: actor },
  });
}

function serializeCertificate(c, { forClient = false } = {}) {
  const content = { ...c.content };
  // The client sees who authorised it (that's them) and the method / date / place, not staff names -- the destroyer's
  // signature stays (a signed certificate), without the name.
  if (forClient) {
    delete content.approvedBy;
    delete content.destroyedBy;
  }
  return {
    id: c.id,
    certificateNumber: c.certificateNumber,
    orderId: c.orderId,
    clientId: c.clientId,
    clientName: c.clientName,
    issuedAt: c.issuedAt.toISOString(),
    content,
  };
}

async function getForOrder(orderId, opts) {
  const cert = await prisma.destructionCertificate.findUnique({ where: { orderId } });
  if (!cert) throw httpError(404, "No certificate of destruction for this order (it is issued when the boxes are destroyed)");
  return serializeCertificate(cert, opts);
}

async function listCertificates({ clientId, page, pageSize } = {}, opts) {
  const where = clientId ? { clientId } : {};
  const { skip, take } = parsePagination({ page, pageSize });
  const [items, total] = await Promise.all([
    prisma.destructionCertificate.findMany({ where, orderBy: [{ issuedAt: "desc" }, { id: "asc" }], skip, take }),
    prisma.destructionCertificate.count({ where }),
  ]);
  return { items: items.map((c) => serializeCertificate(c, opts)), total };
}

module.exports = { issueCertificate, getForOrder, listCertificates, serializeCertificate };
