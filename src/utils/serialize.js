// Prisma rows -> frontend ke zod schemas ka shape. Mongo ke toFrontendJSON plugin ka replacement:
//  * null columns hata deta hai (frontend `.optional()` hai, `.nullable()` nahi),
//  * "kis din" wali dates ko "YYYY-MM-DD" bana deta hai (precise timestamps full ISO rehte hain).
function dateOnly(d) {
  return d instanceof Date ? d.toISOString().slice(0, 10) : d;
}

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

function serializeBox(b) {
  if (!b) return b;
  const { openOrderId, ...rest } = b;
  return clean({
    ...rest,
    filingDateFrom: dateOnly(b.filingDateFrom),
    filingDateTo: dateOnly(b.filingDateTo),
    destroyAfter: dateOnly(b.destroyAfter),
    createdAt: dateOnly(b.createdAt),
  });
}

function serializeOrder(o) {
  if (!o) return o;
  const { collectionInfo, ...rest } = o;
  const destruction = o.destruction
    ? { ...o.destruction, authorisedAt: dateOnly(new Date(o.destruction.authorisedAt)) }
    : null;
  const digitization = o.digitization
    ? { ...o.digitization, authorisedAt: dateOnly(new Date(o.digitization.authorisedAt)) }
    : null;
  return clean({
    ...rest,
    scheduledFor: dateOnly(o.scheduledFor),
    completedAt: dateOnly(o.completedAt),
    createdAt: dateOnly(o.createdAt),
    destruction,
    digitization,
    collection: collectionInfo, // API me "collection" naam se aata hai
  });
}

function serializeOrderLine(l) {
  return l ? clean({ ...l }) : l;
}

function serializeAuditEvent(e) {
  return e ? clean({ ...e }) : e;
}

function serializeSimple(row) {
  return row ? clean({ ...row }) : row;
}

// "YYYY-MM-DD"/ISO string -> Date (Prisma DateTime/Date column ke liye). undefined -> undefined
// (field skip), null/"" -> null (column clear).
function toDate(v) {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  return v instanceof Date ? v : new Date(v);
}

module.exports = {
  dateOnly,
  clean,
  toDate,
  serializeBox,
  serializeOrder,
  serializeOrderLine,
  serializeAuditEvent,
  serializeSimple,
};
