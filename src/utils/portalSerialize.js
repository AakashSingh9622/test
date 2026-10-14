// Portal (client-side) responses. Staff API ka data seedha client ko nahi diya jaata -- yahan har field jaan-boojhkar
// chuni gayi hai (allow-list), isliye staff ke naam, rack/slot codes, internal notes, hold ki wajah waghera
// kabhi client tak nahi pahunchte, chahe kal DB me naya internal column jud jaye.
const { dateOnly } = require("./serialize");

const iso = (d) => (d instanceof Date ? d.toISOString() : d);

// Box -- client ko sirf warehouse ka naam dikhta hai (rack/slot nahi).
// `showOrder`: is box ka open order ye contact dekh sakta hai (apna order ya main contact) -- warna chhupaya jaata hai.
function portalBox(box, { showOrder = true } = {}) {
  const warehouse = box.slot?.warehouse ? { code: box.slot.warehouse.code, name: box.slot.warehouse.name } : undefined;
  const open = showOrder ? box.openOrder : null;
  return strip({
    id: box.id,
    boxNumber: box.boxNumber,
    barcode: box.barcode,
    description: box.description,
    department: box.department,
    reference: box.reference,
    filingDateFrom: dateOnly(box.filingDateFrom),
    filingDateTo: dateOnly(box.filingDateTo),
    destroyAfter: dateOnly(box.destroyAfter),
    size: box.size,
    status: box.status,
    onHold: box.onHold,
    warehouse,
    openOrder: open ? { id: open.id, orderNumber: open.orderNumber, type: open.type, status: open.status } : undefined,
    receivedAt: dateOnly(box.createdAt),
  });
}

// Order -- staff ke naam (requestedBy), witness aur internal ids nahi.
// Accepts a raw DB row (collectionInfo) AND an already-serialized order from orderService (collection).
function portalOrder(o) {
  const d = o.destruction;
  const dg = o.digitization;
  const collection = o.collection ?? o.collectionInfo;
  return strip({
    id: o.id,
    orderNumber: o.orderNumber,
    type: o.type,
    status: o.status,
    clientId: o.clientId,
    clientName: o.clientName,
    requestedVia: o.requestedVia,
    contactName: o.contactName,
    contactEmail: o.contactEmail,
    contactPhone: o.contactPhone,
    address: o.address,
    scheduledFor: dateOnly(o.scheduledFor),
    completedAt: dateOnly(o.completedAt),
    notes: o.notes,
    boxCount: o.boxCount,
    lineSummary: o.lineSummary,
    destruction: d
      ? { method: d.method, authorisedBy: d.authorisedBy, authorisedAt: dateOnly(new Date(d.authorisedAt)) }
      : undefined,
    digitization: dg
      ? { name: dg.name, note: dg.note, authorisedBy: dg.authorisedBy, authorisedAt: dateOnly(new Date(dg.authorisedAt)) }
      : undefined,
    collection: collection ? { expectedNewBoxes: collection.expectedNewBoxes } : undefined,
    createdAt: dateOnly(o.createdAt),
  });
}

function portalOrderLine(l) {
  return strip({
    id: l.id,
    boxId: l.boxId,
    boxNumber: l.boxNumber,
    description: l.box?.description,
    status: l.status,
    updatedAt: iso(l.updatedAt),
  });
}

// Audit event -- kisne kiya (staff ka naam), kahan se kahan (rack/slot), kya badla, internal note: sab hata diya.
// Sirf wo note bacha hai jo client ke liye hi hai: dispatch ka recipient aur destruction ka method.
const NOTE_FOR_CLIENT = new Set(["dispatched", "destroyed"]);
function portalAuditEvent(e) {
  return strip({
    id: e.id,
    type: e.type,
    at: iso(e.at),
    orderId: e.orderId,
    orderNumber: e.orderNumber,
    note: NOTE_FOR_CLIENT.has(e.type) ? e.note : undefined,
  });
}

// null / undefined fields hata deta hai (frontend ko khaali keys nahi chahiye).
function strip(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

module.exports = { portalBox, portalOrder, portalOrderLine, portalAuditEvent };
