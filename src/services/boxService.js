// Box registration, search, aur detail actions.
const prisma = require("../config/prisma");
const { Prisma } = prisma;
const { nextSequence } = require("./counterService");
const { appendAuditEvent } = require("./auditService");
const { appendMovement } = require("./movementService");
const { getBoxSizes, getBoxSizeDimensions, boxDimensionColumns, assertUsableSize } = require("./boxSizeService");
const { TX_OPTIONS, releaseBoxSlot, RELEASED_BOX_FIELDS, allocateBoxes, isActiveSlot } = require("./boxAllocationService");
const { recomputeLineSummary, goodsInPath, findBoxByCode } = require("./orderService");
const { recordException, refuseAndRecord } = require("./exceptionService");
const { resolveLocation } = require("./locationService");
const { resolveParts, hasLocationParts } = require("./locationParts");
const { boxVolumeCm3, formatVolume } = require("../utils/dimensions");
const { cleanValuesOrThrow } = require("./customFieldService");
const { resolveForBox } = require("./expedienteService");
const { serializeBox, serializeOrder, serializeSimple, dateOnly, toDate } = require("../utils/serialize");
const httpError = require("../utils/httpError");
const { parsePagination } = require("../utils/pagination");

const MAX_FIELD_CONDITIONS = 4; // Docbox Busqueda: "up to four search fields"
const MAX_ID_MATCHES = 30000; // an id list this long is still safe to pass back to the database

// "125" means BX00000125; a full number (BX00000125) is used as it is.
function boxNumberBound(v) {
  const t = String(v).trim().toUpperCase();
  return /^\d+$/.test(t) ? `BX${t.padStart(8, "0")}` : t;
}

// The client's own field conditions: [{ code: "C1", value: "Block 1", mode: "exact" | "contains" }], up to four.
// Accepts the JSON the screen sends in `cfs`, or the older single cfCode / cfValue / cfMode.
function parseFieldConditions(params) {
  let list = [];
  if (params.cfs) {
    try {
      list = JSON.parse(String(params.cfs));
    } catch {
      throw httpError(400, "cfs must be a JSON list of field conditions");
    }
    if (!Array.isArray(list)) throw httpError(400, "cfs must be a list");
  } else if (params.cfCode && params.cfValue) {
    list = [{ code: params.cfCode, value: params.cfValue, mode: params.cfMode }];
  }
  const out = [];
  for (const c of list) {
    const code = String(c?.code ?? "").trim();
    const value = String(c?.value ?? "").trim();
    if (!code || !value) continue; // an empty row is simply ignored
    if (!/^[A-Za-z0-9_]{1,20}$/.test(code)) throw httpError(400, `"${code}" is not a field code`);
    out.push({ code, value, mode: c.mode === "exact" ? "exact" : "contains" });
  }
  if (out.length > MAX_FIELD_CONDITIONS) throw httpError(400, `Search by ${MAX_FIELD_CONDITIONS} fields at most`);
  return out;
}

// Ids of the boxes whose own fields match (Like = contains, "=" = the whole value; letter case never matters).
// `join` is "or" (Docbox "O": any field) or "and" ("Y": every field).
async function boxIdsByFields(conditions, join, scope) {
  const parts = conditions.map((c) => {
    const text = Prisma.sql`("customFields" ->> ${c.code}::text)`;
    if (c.mode === "exact") return Prisma.sql`lower(${text}) = lower(${c.value})`;
    const like = `%${c.value.replace(/[\\%_]/g, (ch) => "\\" + ch)}%`;
    return Prisma.sql`${text} ILIKE ${like}`;
  });
  const glue = join === "or" ? " OR " : " AND ";
  const narrow = [];
  if (scope.clientId) narrow.push(Prisma.sql`"clientId" = ${String(scope.clientId)}`);
  if (scope.expedienteId) narrow.push(Prisma.sql`"expedienteId" = ${String(scope.expedienteId)}`);
  const scoped = narrow.length ? Prisma.sql` AND ${Prisma.join(narrow, " AND ")}` : Prisma.empty;
  const rows = await prisma.$queryRaw`SELECT "id" FROM "box" WHERE (${Prisma.join(parts, glue)})${scoped}`;
  return rows.map((r) => r.id);
}

// Whole-number range on a text column (pallet / container): a box whose value is not a number is left out.
function wholeNumber(v, name) {
  if (v === undefined || v === null || String(v).trim() === "") return undefined;
  if (!/^\d{1,15}$/.test(String(v).trim())) throw httpError(400, `${name} must be a whole number`);
  return BigInt(String(v).trim());
}
async function boxIdsByNumberRange(column, fromRaw, toRaw, label) {
  const from = wholeNumber(fromRaw, `${label} from`);
  const to = wholeNumber(toRaw, `${label} to`);
  if (from === undefined && to === undefined) return undefined;
  if (from !== undefined && to !== undefined && from > to) throw httpError(400, `The ${label} range ends before it starts`);
  const lo = from ?? 0n;
  const hi = to ?? 999999999999999n;
  const col = Prisma.raw(`"${column}"`);
  const rows = await prisma.$queryRaw`SELECT "id" FROM "box" WHERE ${col} ~ '^[0-9]{1,15}$' AND (${col})::bigint BETWEEN ${lo} AND ${hi}`;
  return rows.map((r) => r.id);
}

async function searchBoxes(params) {
  const where = {};

  if (params.q) {
    const contains = { contains: params.q, mode: "insensitive" };
    where.OR = [
      { boxNumber: contains },
      { barcode: contains },
      { description: contains },
      { clientName: contains },
      { reference: contains },
      { department: contains },
      { comments: contains },
      { containerNo: contains },
    ];
  }
  if (params.clientId) where.clientId = params.clientId;
  if (params.expedienteId) where.expedienteId = String(params.expedienteId);
  if (params.status?.length) where.status = { in: params.status };
  else where.status = { not: "destroyed" }; // default: destroyed boxes hide rahte hain (spec §7)
  if (params.onHold !== undefined) where.onHold = params.onHold;
  if (params.orderId) where.openOrderId = params.orderId;
  // Docbox "Campo / Dato": up to four of the client's own fields, each "Like" or "=", joined by "O" (or) / "Y" (and).
  // Docbox "Num entre": a range of box, pallet or container numbers. Each of these narrows the same list of box ids.
  let idSets = [];
  const conditions = parseFieldConditions(params);
  if (conditions.length) idSets.push(await boxIdsByFields(conditions, params.cfJoin === "or" ? "or" : "and", params));
  const palletIds = await boxIdsByNumberRange("palletNo", params.palletFrom, params.palletTo, "pallet");
  if (palletIds) idSets.push(palletIds);
  const containerIds = await boxIdsByNumberRange("containerNo", params.containerFrom, params.containerTo, "container");
  if (containerIds) idSets.push(containerIds);
  if (idSets.length) {
    let ids = idSets[0];
    for (const next of idSets.slice(1)) {
      const keep = new Set(next);
      ids = ids.filter((id) => keep.has(id));
    }
    if (ids.length > MAX_ID_MATCHES) throw httpError(400, "Too many boxes match those fields. Pick a client or add another filter.");
    where.id = { in: ids };
  }
  if (params.boxFrom || params.boxTo) {
    where.boxNumber = { ...(params.boxFrom && { gte: boxNumberBound(params.boxFrom) }), ...(params.boxTo && { lte: boxNumberBound(params.boxTo) }) };
  }
  // Where it is: ids (the module page) or what a person types / a location link carries (code or name, any letter case).
  const t = (v) => String(v).trim();
  const eq = (v) => ({ equals: t(v), mode: "insensitive" });
  const codeOrName = (v) => ({ OR: [{ code: eq(v) }, { name: { contains: t(v), mode: "insensitive" } }] });
  const place = {};
  if (params.warehouseId) place.warehouseId = params.warehouseId;
  if (params.rackId) place.rackId = params.rackId;
  if (params.row) place.row = Number(params.row);
  const warehouseWhere = {};
  if (params.site) warehouseWhere.site = eq(params.site); // Sede
  if (params.warehouse) warehouseWhere.OR = [{ code: eq(params.warehouse) }, { name: eq(params.warehouse) }]; // Almacen
  if (Object.keys(warehouseWhere).length) place.warehouse = warehouseWhere;
  const rackWhere = {};
  if (params.zone) rackWhere.zone = codeOrName(params.zone); // Bloque / Planta
  if (params.aisle) rackWhere.aisle = codeOrName(params.aisle); // Pasillo
  if (params.module) rackWhere.OR = [{ code: eq(params.module) }, { label: { contains: t(params.module), mode: "insensitive" } }]; // Estanteria / Modulo
  if (Object.keys(rackWhere).length) place.rack = rackWhere;
  if (Object.keys(place).length) where.slot = place;
  if (params.palletNo) where.palletNo = { contains: t(params.palletNo), mode: "insensitive" }; // Nº Palet
  if (params.containerNo) where.containerNo = { contains: t(params.containerNo), mode: "insensitive" }; // Nº Contenedor
  if (params.containerType) where.containerType = { contains: t(params.containerType), mode: "insensitive" }; // Tipo Contenedor

  const { skip, take } = parsePagination(params);

  const [items, total] = await Promise.all([
    prisma.box.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }], // id = stable tie-break so pages never overlap
      skip,
      take,
    }),
    prisma.box.count({ where }),
  ]);

  return { items: items.map(serializeBox), total };
}

// The box page also gets the module (rack) and warehouse its position belongs to, to draw where it stands.
async function getBoxById(id) {
  const box = await prisma.box.findUnique({ where: { id }, include: { slot: { select: { rackId: true, warehouseId: true } } } });
  if (!box) return serializeBox(box);
  const { slot, ...row } = box;
  return { ...serializeBox(row), ...(slot && { rackId: slot.rackId, slotWarehouseId: slot.warehouseId }) };
}

// Scan to see a box (Sprint 11): its current barcode or its box number, any case. (The box number is also the code of
// the box's first label, so an old label still finds the box here -- only for looking; scan operations use the current
// barcode only, see findBoxByCode.)
async function lookupBox(rawCode) {
  const code = String(rawCode || "").trim();
  if (!code) throw httpError(400, "Scan or type a box barcode");
  const box =
    (await findBoxByCode(code)) ??
    (await prisma.box.findFirst({
      where: { OR: [{ barcode: { equals: code, mode: "insensitive" } }, { boxNumber: { equals: code, mode: "insensitive" } }] },
    }));
  if (!box) throw httpError(404, `No box has the barcode ${code}`);
  return serializeBox(box);
}

// Jin orders me ye box kabhi shamil hua hai, unki list (box detail ka "Orders" tab).
async function getOrdersForBox(boxId) {
  const orders = await prisma.order.findMany({
    where: { lines: { some: { boxId } } },
    orderBy: { createdAt: "desc" },
  });
  return orders.map(serializeOrder);
}

// A retention category must be the code of a current retention rule (or empty).
const MAX_COMMENTS = 1000;
// Comments are free text (Docbox "Observaciones"); empty means none.
function clampComments(value) {
  const t = value === undefined || value === null ? "" : String(value).trim();
  if (t.length > MAX_COMMENTS) throw httpError(400, `comments are too long (${MAX_COMMENTS} characters at most)`);
  return t || undefined;
}

// Pallet number (Docbox "Nº Palet"): free text, optional.
function cleanPallet(value) {
  const t = value === undefined || value === null ? "" : String(value).trim();
  if (t.length > 40) throw httpError(400, "pallet number is too long (40 characters at most)");
  return t || undefined;
}

// Container number / type (Docbox "NºContenedor", "Tipo Contenedor"): free text, optional.
function cleanContainer(value, label) {
  const t = value === undefined || value === null ? "" : String(value).trim();
  if (t.length > 40) throw httpError(400, `${label} is too long (40 characters at most)`);
  return t || undefined;
}

// The filing period must run forwards (both are YYYY-MM-DD, so text order is date order).
function assertFilingPeriod(from, to) {
  if (from && to && String(to) < String(from)) throw httpError(400, "filing date to is before filing date from");
}

async function checkRetentionCategory(value) {
  if (value === undefined || value === null || value === "") return null;
  const code = String(value).trim().toUpperCase();
  const rule = await prisma.retentionRule.findFirst({ where: { code, isCurrent: true } });
  if (!rule) throw httpError(400, `Unknown retention category "${code}" — add it under Records → Retention rules first`);
  return code;
}

// Naye boxes ek saath register karta hai (Register Boxes wizard, step 1) -- ek transaction me.
async function createBoxesBatch(input, actor) {
  const retentionCategory = await checkRetentionCategory(input.retentionCategory);
  assertFilingPeriod(input.filingDateFrom, input.filingDateTo);
  const palletNo = cleanPallet(input.palletNo);
  const containerNo = cleanContainer(input.containerNo, "container number");
  const containerType = cleanContainer(input.containerType, "container type");
  // A copy made with Duplicate: its History says which box it came from.
  const duplicateOf = /^[A-Za-z0-9._-]{1,40}$/.test(String(input.duplicateOf ?? "")) ? String(input.duplicateOf) : undefined;
  const sizeCode = input.size || "standard";
  await assertUsableSize(sizeCode); // a size from Settings → Box sizes that isn't retired
  // The client's own fields (same values on every box of the batch); mandatory ones must be filled.
  // The expediente (Docbox: the client's file): needed when the client has any; its own fields are the ones checked.
  const expediente = await resolveForBox(input.clientId, input.expedienteId);
  const customFields = await cleanValuesOrThrow(input.clientId, input.customFields, { expedienteId: expediente.id });

  // Docbox "New record" shows the location in the same form: when Module + Shelf (and optionally Site, Warehouse, Floor,
  // Aisle) are given, the boxes go onto that shelf right after they are registered -- one position at a time, the first
  // with room. Checked BEFORE anything is created, so a shelf with too little room registers nothing.
  let plan = null; // slot id for each box, in order
  const place = input.place && typeof input.place === "object" ? input.place : null;
  if (place && hasLocationParts(place)) {
    const lengths = await getBoxSizes();
    const needCm = lengths[sizeCode] ?? lengths.standard;
    const found = await resolveParts(place, { needCm });
    if (found.error) throw httpError(400, found.error);
    const positions = (found.found.positions ?? []).filter(isActiveSlot);
    const used = new Map();
    plan = [];
    for (let i = 0; i < input.quantity; i++) {
      const slot = positions.find((s) => s.capacity - s.used - (used.get(s.id) ?? 0) >= needCm);
      if (!slot) throw httpError(400, `That shelf has room for only ${i} of the ${input.quantity} boxes (${formatVolume(needCm)} each) — nothing was registered`);
      used.set(slot.id, (used.get(slot.id) ?? 0) + needCm);
      plan.push(slot.id);
    }
  }

  const created = await prisma.$transaction(async (tx) => {
    // Collection order ke liye register ho rahe hain to order pehle hi validate karo (galat/band
    // order par boxes bana kar fail hone se behtar hai ki shuru me hi 4xx mile).
    const linkedOrder = input.orderId ? await tx.order.findUnique({ where: { id: input.orderId } }) : null;
    if (input.orderId) {
      if (!linkedOrder) throw httpError(404, "Order not found");
      if (linkedOrder.type !== "collection") throw httpError(400, "New boxes can only be registered against a collection order");
      if (["completed", "cancelled", "rejected"].includes(linkedOrder.status)) {
        throw httpError(409, `Order ${linkedOrder.orderNumber} is ${linkedOrder.status}`);
      }
    }

    const sizeDims = await getBoxSizeDimensions();
    const created = [];
    for (let i = 0; i < input.quantity; i++) {
      const seq = await nextSequence("boxSeq", tx);
      const barcode = `BX${String(seq).padStart(8, "0")}`;
      const override = input.overrides?.find((o) => o.index === i);
      const box = await tx.box.create({
        data: {
          boxNumber: barcode,
          barcode,
          clientId: input.clientId,
          clientName: input.clientName,
          description: override?.description ?? input.description,
          department: input.department || undefined,
          reference: override?.reference ?? (input.reference || undefined),
          palletNo,
          containerNo,
          containerType,
          expedienteId: expediente.id ?? undefined,
          expedienteCode: expediente.code ?? undefined,
          comments: clampComments(input.comments),
          entryDate: toDate(input.entryDate) || toDate(new Date().toISOString().slice(0, 10)),
          filingDateFrom: toDate(input.filingDateFrom),
          filingDateTo: toDate(input.filingDateTo) || undefined,
          destroyAfter: toDate(input.destroyAfter) || undefined,
          retentionCategory: retentionCategory ?? undefined,
          customFields: Object.keys(customFields).length ? customFields : undefined,
          size: sizeCode,
          ...boxDimensionColumns(sizeDims, sizeCode),
          status: "unallocated",
          onHold: false,
          labelPrinted: false,
          createdBy: actor,
        },
      });
      await appendAuditEvent(
        box,
        "registered",
        actor,
        { orderId: input.orderId, orderNumber: input.orderNumber, note: duplicateOf ? `Duplicate of ${duplicateOf}` : undefined },
        tx
      );
      created.push(serializeBox(box));
    }

    // Order se link karo: har naye box ki ek OrderLine ("received" -- collection me box mil chuka hai),
    // phir order ka boxCount aur lineSummary refresh, taaki order screen par count/progress sahi dikhe.
    if (linkedOrder) {
      await tx.orderLine.createMany({
        data: created.map((box) => ({ orderId: linkedOrder.id, boxId: box.id, boxNumber: box.boxNumber, status: "received" })),
      });
      await tx.order.update({ where: { id: linkedOrder.id }, data: { boxCount: { increment: created.length } } });
      await recomputeLineSummary(linkedOrder.id, tx);
    }
    return created;
  }, TX_OPTIONS);

  if (!plan) return created;
  try {
    const moved = await allocateBoxes({ allocations: created.map((b, i) => ({ boxId: b.id, slotId: plan[i] })), reason: "Put on a shelf at registration" }, actor);
    const byId = new Map(moved.map((b) => [b.id, b]));
    return created.map((b) => byId.get(b.id) ?? b);
  } catch {
    // The boxes ARE registered; only the shelving failed (e.g. someone filled the shelf a moment ago): they stay unallocated.
    return created;
  }
}

async function markLabelsPrinted(boxIds, actor) {
  await prisma.$transaction(async (tx) => {
    for (const boxId of boxIds) {
      const box = await tx.box.findUnique({ where: { id: boxId } });
      if (!box || box.labelPrinted) continue;
      await tx.box.update({ where: { id: boxId }, data: { labelPrinted: true } });
      await appendAuditEvent(box, "label_printed", actor, {}, tx);
    }
  }, TX_OPTIONS);
}

const FIELD_LABELS = {
  description: "description",
  department: "department",
  reference: "reference",
  filingDateFrom: "filing date from",
  filingDateTo: "filing date to",
  destroyAfter: "destroy after",
  retentionCategory: "retention category",
  palletNo: "pallet number",
  containerNo: "container number",
  containerType: "container type",
  comments: "comments",
  entryDate: "entry date",
};
// Free-text fields that an empty value clears (stored as null).
const TEXT_CLEARS_TO_NULL = new Set(["comments", "palletNo", "containerNo", "containerType"]);
const DATE_FIELDS = new Set(["filingDateFrom", "filingDateTo", "destroyAfter", "entryDate"]);

// Register wizard, back on step 1 after registering: the same correction applied to every box of the batch, in one
// transaction (one "details_edited" history event per box that changed). Client and size can only change while a box is
// not on a shelf and not tied to an order (its order line / slot space would be wrong otherwise).
const CORRECTION_NOTE = "Corrected during registration";
async function correctRegisteredBoxes({ boxIds, patch }, actor) {
  if (!Array.isArray(boxIds) || boxIds.length === 0) throw httpError(400, "boxIds is required");
  if (boxIds.length > 200) throw httpError(400, "At most 200 boxes at a time");
  if (patch.retentionCategory !== undefined) {
    patch = { ...patch, retentionCategory: (await checkRetentionCategory(patch.retentionCategory)) ?? undefined };
  }
  if (patch.size !== undefined) await assertUsableSize(patch.size);
  if (patch.clientId !== undefined && !String(patch.clientId).trim()) throw httpError(400, "clientId can't be empty");
  if (patch.description !== undefined && !String(patch.description).trim()) throw httpError(400, "description can't be empty");
  if (patch.filingDateFrom !== undefined && !patch.filingDateFrom) throw httpError(400, "filing date from is required");
  if (patch.comments !== undefined) patch = { ...patch, comments: clampComments(patch.comments) ?? "" };
  if (patch.palletNo !== undefined) patch = { ...patch, palletNo: cleanPallet(patch.palletNo) ?? "" };
  if (patch.containerNo !== undefined) patch = { ...patch, containerNo: cleanContainer(patch.containerNo, "container number") ?? "" };
  if (patch.containerType !== undefined) patch = { ...patch, containerType: cleanContainer(patch.containerType, "container type") ?? "" };
  if (patch.entryDate !== undefined && !patch.entryDate) throw httpError(400, "entry date can't be empty");
  assertFilingPeriod(patch.filingDateFrom, patch.filingDateTo);
  const sizeDims = patch.size !== undefined ? await getBoxSizeDimensions() : null;

  return prisma.$transaction(async (tx) => {
    const boxes = await tx.box.findMany({ where: { id: { in: boxIds } }, include: { _count: { select: { orderLines: true } } } });
    if (boxes.length !== new Set(boxIds).size) throw httpError(404, "Some of these boxes don't exist");
    const out = [];
    for (const box of boxes) {
      const changes = [];
      const data = {};
      for (const key of Object.keys(FIELD_LABELS)) {
        const nextValue = patch[key];
        if (nextValue === undefined) continue;
        const currentValue = (DATE_FIELDS.has(key) ? dateOnly(box[key]) : box[key]) ?? "";
        if ((nextValue ?? "") === currentValue) continue;
        changes.push({ field: FIELD_LABELS[key], from: currentValue || undefined, to: nextValue || undefined });
        data[key] = DATE_FIELDS.has(key) ? toDate(nextValue) : nextValue || null;
      }
      const movesClient = patch.clientId !== undefined && patch.clientId !== box.clientId;
      const resizes = patch.size !== undefined && patch.size !== box.size;
      if (movesClient || resizes) {
        if (box.slotId || box.openOrderId || box._count.orderLines > 0 || !["unallocated", "received"].includes(box.status)) {
          throw httpError(409, `${box.boxNumber} is already filed or on an order — its ${movesClient ? "client" : "size"} can't change now`);
        }
      }
      if (movesClient) {
        changes.push({ field: "client", from: box.clientName, to: patch.clientName || patch.clientId });
        data.clientId = patch.clientId;
        data.clientName = patch.clientName || patch.clientId;
      }
      if (resizes) {
        changes.push({ field: "size", from: box.size, to: patch.size });
        data.size = patch.size;
        Object.assign(data, boxDimensionColumns(sizeDims, patch.size));
      }
      if (!changes.length) {
        out.push(serializeBox(box));
        continue;
      }
      const updated = await tx.box.update({ where: { id: box.id }, data });
      await appendAuditEvent(updated, "details_edited", actor, { changes, note: CORRECTION_NOTE }, tx);
      out.push(serializeBox(updated));
    }
    const order = new Map(boxIds.map((id, i) => [id, i]));
    return out.sort((a, b) => order.get(a.id) - order.get(b.id));
  }, TX_OPTIONS);
}

async function updateBoxDetails(boxId, patch, reason, actor) {
  const box = await prisma.box.findUnique({ where: { id: boxId } });
  if (!box) throw httpError(404, "Box not found");
  if (patch.retentionCategory !== undefined) patch = { ...patch, retentionCategory: (await checkRetentionCategory(patch.retentionCategory)) ?? undefined };
  if (patch.comments !== undefined) patch = { ...patch, comments: clampComments(patch.comments) ?? "" };
  if (patch.palletNo !== undefined) patch = { ...patch, palletNo: cleanPallet(patch.palletNo) ?? "" };
  if (patch.containerNo !== undefined) patch = { ...patch, containerNo: cleanContainer(patch.containerNo, "container number") ?? "" };
  if (patch.containerType !== undefined) patch = { ...patch, containerType: cleanContainer(patch.containerType, "container type") ?? "" };
  if (patch.entryDate !== undefined && !patch.entryDate) throw httpError(400, "entry date can't be empty");
  assertFilingPeriod(patch.filingDateFrom ?? dateOnly(box.filingDateFrom), patch.filingDateTo !== undefined ? patch.filingDateTo : dateOnly(box.filingDateTo));

  const changes = [];
  const data = {};
  for (const key of Object.keys(FIELD_LABELS)) {
    const nextValue = patch[key];
    if (nextValue === undefined) continue;
    const currentValue = (DATE_FIELDS.has(key) ? dateOnly(box[key]) : box[key]) ?? (TEXT_CLEARS_TO_NULL.has(key) ? "" : undefined);
    if (nextValue === currentValue) continue;
    changes.push({ field: FIELD_LABELS[key], from: currentValue || undefined, to: nextValue || undefined });
    data[key] = DATE_FIELDS.has(key) ? toDate(nextValue) : TEXT_CLEARS_TO_NULL.has(key) ? nextValue || null : nextValue;
  }

  // The client's own fields: only the codes sent change; the rest of the box's values stay.
  if (patch.customFields !== undefined) {
    const clean = await cleanValuesOrThrow(box.clientId, patch.customFields, { partial: true, expedienteId: box.expedienteId });
    const current = box.customFields && typeof box.customFields === "object" ? box.customFields : {};
    const defs = await prisma.customFieldDef.findMany({ where: { clientId: box.clientId } });
    const merged = { ...current };
    for (const code of Object.keys(patch.customFields || {})) {
      const name = defs.find((d) => d.code === code)?.name ?? code;
      const next = clean[code];
      if (next === undefined) delete merged[code];
      else merged[code] = next;
      if (current[code] !== next) changes.push({ field: name, from: current[code], to: next });
    }
    data.customFields = Object.keys(merged).length ? merged : Prisma.DbNull;
  }

  if (changes.length === 0) return serializeBox(box);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.box.update({ where: { id: boxId }, data });
    await appendAuditEvent(updated, "details_edited", actor, { changes, note: reason }, tx);
    return serializeBox(updated);
  }, TX_OPTIONS);
}

async function placeBoxHold(boxId, reason, actor) {
  const box = await prisma.box.findUnique({ where: { id: boxId } });
  if (!box) throw httpError(404, "Box not found");
  return prisma.$transaction(async (tx) => {
    const updated = await tx.box.update({ where: { id: boxId }, data: { onHold: true, holdReason: reason } });
    await appendAuditEvent(updated, "hold_placed", actor, { note: reason }, tx);
    return serializeBox(updated);
  }, TX_OPTIONS);
}

async function releaseBoxHold(boxId, actor, reason) {
  const box = await prisma.box.findUnique({ where: { id: boxId } });
  if (!box) throw httpError(404, "Box not found");
  const note = String(reason ?? "").trim().slice(0, 500) || undefined;
  return prisma.$transaction(async (tx) => {
    const updated = await tx.box.update({ where: { id: boxId }, data: { onHold: false, holdReason: null } });
    await appendAuditEvent(updated, "hold_released", actor, { note }, tx);
    return serializeBox(updated);
  }, TX_OPTIONS);
}

// A missing box stops counting as stored: its slot space is freed, it leaves the slot and can't go on any order.
// It stays visible (status "missing", with the reason) until someone finds it and places it in a slot again.
async function markBoxMissing(boxId, note, actor) {
  const reason = String(note || "").trim();
  if (!reason) throw httpError(400, "A reason is required to mark a box missing");
  return prisma.$transaction(async (tx) => {
    const box = await tx.box.findUnique({ where: { id: boxId }, include: { slot: { select: { id: true, warehouseId: true } } } });
    if (!box) throw httpError(404, "Box not found");
    if (box.status === "missing") throw httpError(409, `${box.boxNumber} is already marked missing`);
    if (box.status === "destroyed") throw httpError(400, `${box.boxNumber} is destroyed`);
    if (box.status === "permanently_withdrawn") throw httpError(400, `${box.boxNumber} was permanently withdrawn by the client`);
    // On an open order? Its line becomes "missing" so the order can still be finished without this box.
    const openOrder = box.openOrderId ? await tx.order.findUnique({ where: { id: box.openOrderId } }) : null;
    await releaseBoxSlot(box, tx);
    const updated = await tx.box.update({
      where: { id: boxId },
      data: {
        status: "missing",
        missingReason: reason,
        missingAt: new Date(),
        ...RELEASED_BOX_FIELDS,
        openOrderId: null,
        openOrder: Prisma.DbNull,
      },
    });
    if (openOrder) {
      await tx.orderLine.updateMany({ where: { orderId: openOrder.id, boxId }, data: { status: "missing" } });
      await recomputeLineSummary(openOrder.id, tx);
      await appendAuditEvent(
        updated,
        "removed_from_order",
        actor,
        { orderId: openOrder.id, orderNumber: openOrder.orderNumber, note: "Box is missing" },
        tx
      );
    }
    await appendAuditEvent(updated, "marked_missing", actor, { note: reason, fromLocation: box.locationPath ?? undefined }, tx);
    await appendMovement(box, "marked_missing", actor, { from: box.slot, fromLocation: box.locationPath, reason }, tx);
    return serializeBox(updated);
  }, TX_OPTIONS);
}

// --- Goods-In, put-away by barcode (spec §6.1) ----------------------------------------------------------------------

// A registered box arrives at a warehouse: it waits at that warehouse's Goods-In ("received") until it is put away.
// Scanning it again at the same Goods-In is fine.
async function receiveAtGoodsIn(rawCode, warehouseId, actor) {
  const code = String(rawCode || "").trim();
  if (!code) throw httpError(400, "Scan or type a box barcode");
  if (!warehouseId) throw httpError(400, "Choose the warehouse the box arrived at");
  const warehouse = await prisma.warehouse.findUnique({ where: { id: warehouseId } });
  if (!warehouse) throw httpError(404, "Warehouse not found");
  const box = await findBoxByCode(code);
  if (!box) await refuseAndRecord(404, "box_not_found", actor, { boxBarcode: code, message: `No box has the barcode ${code}` });
  if (box.status === "received" && box.goodsInWarehouseId === warehouse.id) return { box: serializeBox(box), alreadyReceived: true };
  if (box.status === "return_pending") {
    throw httpError(409, `${box.boxNumber} is coming back on order ${box.openOrder?.orderNumber ?? ""} — receive it on that collection`);
  }
  if (box.status !== "unallocated") {
    throw httpError(409, `${box.boxNumber} is ${box.status.replace(/_/g, " ")} — only newly registered boxes are received at Goods-In`);
  }

  return prisma.$transaction(async (tx) => {
    const toLocation = goodsInPath(warehouse);
    const changed = await tx.box.updateMany({
      where: { id: box.id, status: "unallocated" },
      data: { status: "received", goodsInWarehouseId: warehouse.id, locationPath: toLocation },
    });
    if (changed.count !== 1) throw httpError(409, `${box.boxNumber} was changed by someone else — scan it again`);
    const updated = await tx.box.findUnique({ where: { id: box.id } });
    await appendMovement(box, "received", actor, { to: { id: undefined, warehouseId: warehouse.id }, toLocation }, tx);
    await appendAuditEvent(updated, "goods_in", actor, { toLocation, note: `Goods-In ${warehouse.code}` }, tx);
    return { box: serializeBox(updated), alreadyReceived: false };
  }, TX_OPTIONS);
}

// Scan the box, then the slot barcode -- or type a shelf / position code ("B04-3", "B04-3-2", Sprint 10): the box goes
// there (a shelf: its best-fitting position). Any mismatch is refused AND queued for a supervisor.
async function putAwayByBarcode({ boxBarcode, slotBarcode, reason }, actor) {
  const boxCode = String(boxBarcode || "").trim();
  const slotCode = String(slotBarcode || "").trim();
  if (!boxCode || !slotCode) throw httpError(400, "Scan the box and then the slot");
  const box = await findBoxByCode(boxCode);
  if (!box) await refuseAndRecord(404, "box_not_found", actor, { boxBarcode: boxCode, slotBarcode: slotCode, message: `No box has the barcode ${boxCode}` });
  const need = boxVolumeCm3(box);
  const ref = { boxId: box.id, boxBarcode: boxCode, slotBarcode: slotCode };
  let slot = await prisma.slot.findUnique({ where: { barcode: slotCode } });
  if (!slot) {
    const found = await resolveLocation(slotCode, { needCm: need });
    if (found.kind === "position") slot = found.positions[0];
    else if (found.kind === "shelf") {
      if (!found.suggestedSlotId) {
        await refuseAndRecord(409, "slot_full", actor, { ...ref, message: `No position on shelf ${slotCode} has ${formatVolume(need)} free for ${box.boxNumber}` });
      }
      slot = found.positions.find((p) => p.id === found.suggestedSlotId);
    } else if (found.kind === "ambiguous") {
      await refuseAndRecord(409, "slot_not_found", actor, { ...ref, message: `${found.message} — scan the position label instead` });
    }
  }
  if (!slot) await refuseAndRecord(404, "slot_not_found", actor, { ...ref, message: `No slot or shelf has the code ${slotCode}` });
  ref.slotId = slot.id;
  if (!isActiveSlot(slot)) {
    await refuseAndRecord(409, "slot_unavailable", actor, { ...ref, message: `Slot ${slot.barcode} is ${slot.status} — choose another slot` });
  }
  if (["destroyed", "permanently_withdrawn", "return_pending"].includes(box.status)) {
    await refuseAndRecord(409, "box_unavailable", actor, {
      ...ref,
      message: `${box.boxNumber} is ${box.status.replace(/_/g, " ")} and can't be put away`,
    });
  }
  const free = slot.capacity - slot.used;
  if (box.slotId !== slot.id && free < need) {
    await refuseAndRecord(409, "slot_full", actor, { ...ref, message: `Slot ${slot.barcode} has ${formatVolume(free)} free, ${box.boxNumber} needs ${formatVolume(need)}` });
  }
  try {
    const [updated] = await allocateBoxes({ allocations: [{ boxId: box.id, slotId: slot.id }], reason }, actor);
    return { box: updated, slot: serializeSimple(await prisma.slot.findUnique({ where: { id: slot.id } })) };
  } catch (err) {
    // Filled up between the check and the move (someone else put a box there) -- still an exception to look at.
    if (/doesn't have room/.test(err.message)) await recordException("slot_full", actor, { ...ref, message: err.message });
    throw err;
  }
}

// --- Quarantine, re-label ------------------------------------------------------------------------------------------

// Damaged / under investigation: the box stays where it is but can't go on any order until released (spec §4.1).
async function quarantineBox(boxId, rawReason, actor) {
  const reason = String(rawReason || "").trim();
  if (!reason) throw httpError(400, "A reason is required to quarantine a box");
  return prisma.$transaction(async (tx) => {
    const box = await tx.box.findUnique({ where: { id: boxId } });
    if (!box) throw httpError(404, "Box not found");
    if (box.status === "quarantined") throw httpError(409, `${box.boxNumber} is already quarantined`);
    if (box.openOrderId) throw httpError(409, `${box.boxNumber} is on order ${box.openOrder?.orderNumber ?? ""} — take it off the order first`);
    if (!["stored", "digitized", "unallocated", "received"].includes(box.status)) {
      throw httpError(409, `${box.boxNumber} is ${box.status.replace(/_/g, " ")} — only a box that is with us can be quarantined`);
    }
    const updated = await tx.box.update({
      where: { id: boxId },
      data: { status: "quarantined", quarantineReason: reason.slice(0, 1000), quarantinedAt: new Date() },
    });
    await appendAuditEvent(updated, "quarantined", actor, { note: reason }, tx);
    return serializeBox(updated);
  }, TX_OPTIONS);
}

// Back to where it was: on a shelf -> stored (digitized if it was), at Goods-In -> received, else registered.
async function releaseQuarantine(boxId, actor) {
  return prisma.$transaction(async (tx) => {
    const box = await tx.box.findUnique({ where: { id: boxId } });
    if (!box) throw httpError(404, "Box not found");
    if (box.status !== "quarantined") throw httpError(409, `${box.boxNumber} is not quarantined`);
    const status = box.slotId ? (box.digitizedAt ? "digitized" : "stored") : box.goodsInWarehouseId ? "received" : "unallocated";
    const updated = await tx.box.update({ where: { id: boxId }, data: { status, quarantineReason: null, quarantinedAt: null } });
    await appendAuditEvent(updated, "quarantine_released", actor, { note: box.quarantineReason ?? undefined }, tx);
    return serializeBox(updated);
  }, TX_OPTIONS);
}

// A damaged / unreadable label: new barcode, SAME box (id, number, history). The old barcode stops working.
async function relabelBox(boxId, rawReason, actor) {
  const reason = String(rawReason || "").trim();
  if (!reason) throw httpError(400, "A reason is required to re-label a box");
  return prisma.$transaction(async (tx) => {
    const box = await tx.box.findUnique({ where: { id: boxId } });
    if (!box) throw httpError(404, "Box not found");
    if (box.status === "destroyed") throw httpError(400, `${box.boxNumber} is destroyed`);
    const seq = await nextSequence("boxSeq", tx);
    const barcode = `BX${String(seq).padStart(8, "0")}`;
    const updated = await tx.box.update({ where: { id: boxId }, data: { barcode, labelPrinted: false } });
    await appendAuditEvent(updated, "relabelled", actor, { changes: [{ field: "barcode", from: box.barcode, to: barcode }], note: reason }, tx);
    return serializeBox(updated);
  }, TX_OPTIONS);
}

module.exports = {
  parseFieldConditions,
  boxIdsByFields,
  receiveAtGoodsIn,
  putAwayByBarcode,
  correctRegisteredBoxes,
  quarantineBox,
  releaseQuarantine,
  relabelBox,
  searchBoxes,
  getBoxById,
  lookupBox,
  getOrdersForBox,
  createBoxesBatch,
  markLabelsPrinted,
  updateBoxDetails,
  placeBoxHold,
  releaseBoxHold,
  markBoxMissing,
};
