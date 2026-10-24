// Billing stage of an order (Request -> Billing -> Schedule -> In progress -> Complete). Approving an order puts it in
// "billing"; staff raise an invoice for it (invoiceService, sent to Sage by the browser), and only once billing is
// settled can it be scheduled. Settled = one of:
//   paid          the customer paid by card in the portal, or staff recorded the payment (bank transfer, ...)
//   acknowledged  "payment not required" (client billed monthly / annually on account): the customer only acknowledges
//                 the invoice in the portal (or staff record that on their behalf) -- it stays owed on their account
//   waived        no invoice at all (no charge), with a reason
//
// order.billing (JSON):
//   status        awaiting_invoice -> invoice_draft -> awaiting_payment         -> paid
//                                                  \-> awaiting_acknowledgement -> acknowledged
//                 (or -> waived from any not-settled status)
//   paymentNotRequired                                   the "payment not required" tick (on account)
//   invoiceId, invoiceNumber, sageInvoiceNumber          the invoice for this order
//   amount, currency                                     Sage's total incl. VAT
//   stripeCustomerId                                     the client's Stripe customer (DocuSoft card) -- portal card payment
//   payment       { method: card|bank_transfer|other, amount, currency, reference?, note?, via: portal|staff|sage, by, at }
//   acknowledged  { by, at, via: portal|staff, note? }
//   waived        { reason, by, at }
// Every payment is also added to the invoice (amountPaid / payments) -- that's what the clients' standing accounts read.
// Phase 1: staff type the invoice lines. Prefilling them from the rate card comes later (roadmap).
const prisma = require("../config/prisma");
const { Prisma } = prisma;
const httpError = require("../utils/httpError");
const { appendAdminEvent } = require("./adminAuditService");
const { notifyClientAboutOrder, notifyStaff } = require("./notificationService");
const { TX_OPTIONS } = require("./boxAllocationService");
const { serializeOrder } = require("../utils/serialize");

const BILLING = {
  awaitingInvoice: "awaiting_invoice",
  invoiceDraft: "invoice_draft",
  awaitingPayment: "awaiting_payment",
  awaitingAcknowledgement: "awaiting_acknowledgement",
  paid: "paid",
  acknowledged: "acknowledged",
  waived: "waived",
};
const SETTLED = [BILLING.paid, BILLING.acknowledged, BILLING.waived];
const WAITING_ON_CUSTOMER = [BILLING.awaitingPayment, BILLING.awaitingAcknowledgement];
const METHODS = ["card", "bank_transfer", "other"];

const fresh = () => ({ status: BILLING.awaitingInvoice });
const money = (n) => `£${Number(n).toFixed(2)}`;
const dec = (n) => new Prisma.Decimal(n).toDecimalPlaces(2);
const num = (d) => (d == null ? 0 : Number(d));
// Once the invoice is in Sage: pay it, or (payment not required) just acknowledge it.
const issuedStatus = (billing) => (billing.paymentNotRequired ? BILLING.awaitingAcknowledgement : BILLING.awaitingPayment);

// scheduleOrder: an order in billing waits until billing is settled. (Old "approved" orders pass.)
function assertBillingSettled(order) {
  if (order.status !== "billing") return;
  const status = order.billing?.status ?? BILLING.awaitingInvoice;
  if (SETTLED.includes(status)) return;
  const why = {
    [BILLING.awaitingInvoice]: "no invoice has been raised yet",
    [BILLING.invoiceDraft]: "its invoice hasn't been sent to Sage yet",
    [BILLING.awaitingPayment]: "its invoice hasn't been paid yet",
    [BILLING.awaitingAcknowledgement]: "the client hasn't acknowledged its invoice yet",
  }[status];
  throw httpError(409, `${order.orderNumber} can't be scheduled — ${why || "billing isn't finished"}. Record the payment or acknowledgement, or waive billing first.`);
}

async function billingOrderOrThrow(orderId, db) {
  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) throw httpError(404, "Order not found");
  if (order.status !== "billing") throw httpError(409, `${order.orderNumber} is not at the billing stage (it is ${order.status.replace(/_/g, " ")})`);
  return order;
}

// --- invoice payments (the standing account) ------------------------------------------------------------------------

const invoiceTotal = (inv) => num(inv.grossTotal ?? inv.netTotal);

// Adds one payment to the invoice; fully paid -> paidAt. Never more than what's still owed.
async function addInvoicePayment(inv, payment, db) {
  const outstanding = Math.max(0, invoiceTotal(inv) - num(inv.amountPaid));
  const amount = Math.min(Number(payment.amount), outstanding);
  if (!(amount > 0)) return inv;
  const amountPaid = dec(num(inv.amountPaid) + amount);
  const fullyPaid = amountPaid.gte(dec(invoiceTotal(inv)));
  return db.invoice.update({
    where: { id: inv.id },
    data: {
      amountPaid,
      paidAt: fullyPaid ? inv.paidAt ?? new Date() : null,
      payments: [...(Array.isArray(inv.payments) ? inv.payments : []), { ...payment, amount }],
    },
  });
}

// --- invoice hooks (invoiceService, inside its transaction) ---------------------------------------------------------

// A new invoice for an order: only one per order, same client, while billing hasn't started.
async function attachInvoice(orderId, clientId, db) {
  const order = await billingOrderOrThrow(orderId, db);
  if (order.clientId !== clientId) throw httpError(400, `${order.orderNumber} belongs to ${order.clientName} — the invoice must be for that client`);
  const status = order.billing?.status ?? BILLING.awaitingInvoice;
  if (status !== BILLING.awaitingInvoice) {
    throw httpError(409, `${order.orderNumber} already has invoice ${order.billing.invoiceNumber ?? ""}`.trim() + (status === BILLING.waived ? " (billing was waived)" : ""));
  }
  return order;
}

async function invoiceCreated(order, inv, db) {
  const billing = { ...(order.billing ?? {}), status: BILLING.invoiceDraft, invoiceId: inv.id, invoiceNumber: inv.invoiceNumber };
  await db.order.update({ where: { id: order.id }, data: { billing } });
}

// The draft invoice was deleted: the order needs a new one (the "payment not required" tick stays).
async function invoiceDeleted(inv, db) {
  if (!inv.orderId) return;
  const order = await db.order.findUnique({ where: { id: inv.orderId } });
  if (order?.billing?.invoiceId !== inv.id || order.billing.status !== BILLING.invoiceDraft) return;
  const billing = { ...fresh(), ...(order.billing.paymentNotRequired && { paymentNotRequired: true }) };
  await db.order.update({ where: { id: order.id }, data: { billing } });
}

function tellClientInvoiceReady(order, inv, billing, db) {
  return billing.status === BILLING.awaitingAcknowledgement
    ? notifyClientAboutOrder(
        order,
        "invoice_to_acknowledge",
        `Invoice ${inv.invoiceNumber} for ${order.orderNumber} (${money(billing.amount)}) — please acknowledge it`,
        "It goes on your account — no payment is needed now. We schedule your order once you acknowledge it.",
        db
      )
    : notifyClientAboutOrder(
        order,
        "invoice_ready",
        `Invoice ${inv.invoiceNumber} for ${order.orderNumber} is ready — ${money(billing.amount)} to pay`,
        "We schedule your order as soon as it is paid. You can pay by card on the order page.",
        db
      );
}

// Created in Sage: the customer can pay it now (or acknowledge it, when payment isn't required).
async function invoiceIssued(inv, { stripeCustomerId } = {}, db) {
  if (!inv.orderId) return;
  const order = await db.order.findUnique({ where: { id: inv.orderId } });
  if (!order || order.status !== "billing" || order.billing?.invoiceId !== inv.id) return;
  if (SETTLED.includes(order.billing.status)) return;
  const billing = {
    ...order.billing,
    status: issuedStatus(order.billing),
    sageInvoiceNumber: inv.sageInvoiceNumber ?? undefined,
    amount: invoiceTotal(inv),
    currency: inv.currency || "GBP",
    ...(stripeCustomerId && { stripeCustomerId: String(stripeCustomerId).trim().slice(0, 100) }),
  };
  await db.order.update({ where: { id: order.id }, data: { billing } });
  await tellClientInvoiceReady(order, inv, billing, db);
}

// --- payment / acknowledgement / waive -------------------------------------------------------------------------------

// Staff record a payment (bank transfer, card over the phone, ...), or the portal reports a card payment.
async function recordPayment(orderId, input, actor, { via = "staff" } = {}) {
  return prisma.$transaction(async (tx) => {
    const order = await billingOrderOrThrow(orderId, tx);
    const billing = order.billing ?? fresh();
    const reference = input.reference ? String(input.reference).trim().slice(0, 200) : undefined;
    if (billing.status === BILLING.paid) {
      // the portal may report the same card payment twice (retry after a lost answer) -- that's fine
      if (reference && billing.payment?.reference === reference) return serializeOrder(order);
      throw httpError(409, `${order.orderNumber} is already paid`);
    }
    if (!WAITING_ON_CUSTOMER.includes(billing.status)) {
      const why = {
        [BILLING.waived]: `Billing for ${order.orderNumber} was waived`,
        [BILLING.acknowledged]: `${order.orderNumber}'s invoice was acknowledged — record the payment on the invoice instead`,
      }[billing.status];
      throw httpError(409, why || `${order.orderNumber} has no invoice in Sage to pay yet`);
    }
    const method = via === "portal" ? "card" : input.method;
    if (!METHODS.includes(method)) throw httpError(400, `method must be one of: ${METHODS.join(", ")}`);
    if (via === "portal") {
      if (!reference) throw httpError(400, "paymentIntentId is required");
      // Card payments: the amount charged (minor units) must be what the invoice asks for.
      const expected = Math.round(Number(billing.amount) * 100);
      if (Number(input.amountMinor) !== expected) throw httpError(400, `The amount paid doesn't match the invoice (${money(billing.amount)})`);
      if (input.currency && billing.currency && String(input.currency).toUpperCase() !== String(billing.currency).toUpperCase()) {
        throw httpError(400, "The payment currency doesn't match the invoice");
      }
    }
    const amount = input.amount !== undefined && via === "staff" ? Number(input.amount) : Number(billing.amount);
    if (!Number.isFinite(amount) || amount < 0) throw httpError(400, "amount must be a number");
    const payment = {
      method,
      amount,
      currency: billing.currency,
      ...(reference && { reference }),
      ...(input.note && { note: String(input.note).trim().slice(0, 500) }),
      via,
      by: actor,
      at: new Date().toISOString(),
    };
    const updated = await tx.order.update({ where: { id: order.id }, data: { billing: { ...billing, status: BILLING.paid, payment } } });
    const inv = billing.invoiceId && (await tx.invoice.findUnique({ where: { id: billing.invoiceId } }));
    if (inv) await addInvoicePayment(inv, payment, tx);
    await appendAdminEvent(
      "order_payment_recorded",
      actor,
      { entityType: "order", entityId: order.id, summary: `${order.orderNumber}: ${money(amount)} paid by ${method.replace("_", " ")}${via === "portal" ? " in the portal" : ""}${reference ? ` (${reference})` : ""}` },
      tx
    );
    await notifyClientAboutOrder(order, "payment_received", `Payment received for ${order.orderNumber} — thank you`, undefined, tx);
    if (via === "portal") {
      await notifyStaff(
        { kind: "order_paid", title: `${order.clientName} paid ${order.orderNumber} by card (${money(amount)}) — ready to schedule`, orderId: order.id, clientId: order.clientId },
        tx
      );
    }
    return serializeOrder(updated);
  }, TX_OPTIONS);
}

// The "payment not required" tick (client billed monthly / annually on account). Can change until billing is settled.
async function setPaymentRequired(orderId, required, actor) {
  if (typeof required !== "boolean") throw httpError(400, "required must be true or false");
  return prisma.$transaction(async (tx) => {
    const order = await billingOrderOrThrow(orderId, tx);
    const billing = order.billing ?? fresh();
    if (SETTLED.includes(billing.status)) throw httpError(409, `${order.orderNumber}'s billing is already ${billing.status}`);
    const next = { ...billing, paymentNotRequired: !required };
    if (!next.paymentNotRequired) delete next.paymentNotRequired;
    if (WAITING_ON_CUSTOMER.includes(billing.status)) next.status = issuedStatus(next);
    if (next.status === billing.status && !!next.paymentNotRequired === !!billing.paymentNotRequired) return serializeOrder(order);
    const updated = await tx.order.update({ where: { id: order.id }, data: { billing: next } });
    await appendAdminEvent(
      "order_payment_requirement_changed",
      actor,
      { entityType: "order", entityId: order.id, summary: `${order.orderNumber}: ${required ? "payment required" : "payment not required (on account) — the client only acknowledges the invoice"}` },
      tx
    );
    // the invoice is already with the client: tell them what's needed now
    if (next.status !== billing.status) {
      const inv = await tx.invoice.findUnique({ where: { id: billing.invoiceId } });
      if (inv) await tellClientInvoiceReady(order, inv, next, tx);
    }
    return serializeOrder(updated);
  }, TX_OPTIONS);
}

// Payment not required: the customer acknowledges the invoice in the portal, or staff record that they did.
async function acknowledgeInvoice(orderId, actor, { via = "staff", note } = {}) {
  return prisma.$transaction(async (tx) => {
    const order = await billingOrderOrThrow(orderId, tx);
    const billing = order.billing ?? fresh();
    if (billing.status === BILLING.acknowledged) return serializeOrder(order);
    if (billing.status !== BILLING.awaitingAcknowledgement) {
      throw httpError(409, billing.status === BILLING.awaitingPayment ? `${order.orderNumber}'s invoice has to be paid` : `${order.orderNumber} has no invoice to acknowledge`);
    }
    const acknowledged = { by: actor, at: new Date().toISOString(), via, ...(note && { note: String(note).trim().slice(0, 500) }) };
    const updated = await tx.order.update({ where: { id: order.id }, data: { billing: { ...billing, status: BILLING.acknowledged, acknowledged } } });
    await appendAdminEvent(
      "order_invoice_acknowledged",
      actor,
      { entityType: "order", entityId: order.id, summary: `${order.orderNumber}: invoice ${billing.invoiceNumber} acknowledged${via === "portal" ? " by the client in the portal" : " (recorded by staff)"} — on account` },
      tx
    );
    if (via === "portal") {
      await notifyStaff(
        { kind: "invoice_acknowledged", title: `${order.clientName} acknowledged the invoice for ${order.orderNumber} — ready to schedule`, orderId: order.id, clientId: order.clientId },
        tx
      );
    }
    return serializeOrder(updated);
  }, TX_OPTIONS);
}

async function waiveBilling(orderId, reason, actor) {
  const why = String(reason || "").trim();
  if (!why) throw httpError(400, "A reason is required (e.g. no charge)");
  return prisma.$transaction(async (tx) => {
    const order = await billingOrderOrThrow(orderId, tx);
    const billing = order.billing ?? fresh();
    if (SETTLED.includes(billing.status)) throw httpError(409, `${order.orderNumber} is already ${billing.status}`);
    const updated = await tx.order.update({
      where: { id: order.id },
      data: { billing: { ...billing, status: BILLING.waived, waived: { reason: why.slice(0, 500), by: actor, at: new Date().toISOString() } } },
    });
    await appendAdminEvent(
      "order_billing_waived",
      actor,
      { entityType: "order", entityId: order.id, summary: `${order.orderNumber}: billing waived — ${why.slice(0, 200)}` },
      tx
    );
    return serializeOrder(updated);
  }, TX_OPTIONS);
}

// An order whose invoice got fully paid outside the order page (invoice page, or seen in Sage) -> the order is paid too.
async function markOrderPaidFromInvoice(inv, payment, tx) {
  if (!inv.orderId || !inv.paidAt) return false;
  const order = await tx.order.findUnique({ where: { id: inv.orderId } });
  if (!order || order.status !== "billing" || order.billing?.invoiceId !== inv.id) return false;
  if (!WAITING_ON_CUSTOMER.includes(order.billing.status)) return false;
  await tx.order.update({ where: { id: order.id }, data: { billing: { ...order.billing, status: BILLING.paid, payment } } });
  await notifyClientAboutOrder(order, "payment_received", `Payment received for ${order.orderNumber} — thank you`, undefined, tx);
  return true;
}

// Staff record a payment against any invoice in Sage (period invoice, billing-run invoice or an order's).
async function recordInvoicePayment(invoiceId, input, actor) {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, "amount must be more than 0");
  if (!METHODS.includes(input.method)) throw httpError(400, `method must be one of: ${METHODS.join(", ")}`);
  return prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw httpError(404, "Invoice not found");
    if (inv.status !== "issued") throw httpError(409, `Invoice ${inv.invoiceNumber} isn't in Sage yet`);
    const outstanding = invoiceTotal(inv) - num(inv.amountPaid);
    if (outstanding <= 0) throw httpError(409, `Invoice ${inv.invoiceNumber} is already paid`);
    if (amount > outstanding + 0.005) throw httpError(400, `Only ${money(outstanding)} is still owed on ${inv.invoiceNumber}`);
    const payment = {
      method: input.method,
      amount,
      currency: inv.currency || "GBP",
      ...(input.reference && { reference: String(input.reference).trim().slice(0, 200) }),
      ...(input.note && { note: String(input.note).trim().slice(0, 500) }),
      via: "staff",
      by: actor,
      at: input.date ? new Date(`${input.date}T12:00:00.000Z`).toISOString() : new Date().toISOString(),
    };
    const updated = await addInvoicePayment(inv, payment, tx);
    await markOrderPaidFromInvoice(updated, payment, tx);
    await appendAdminEvent(
      "invoice_payment_recorded",
      actor,
      { entityType: "invoice", entityId: inv.id, summary: `${inv.invoiceNumber} (${inv.clientName}): ${money(amount)} paid by ${input.method.replace("_", " ")}` },
      tx
    );
    return updated.id;
  }, TX_OPTIONS);
}

// "Update from Sage": the browser read each invoice's total / outstanding amount from Sage and sends them here. Sage
// is the record of what was paid (payments for on-account clients go into Sage), so amountPaid follows it.
async function syncFromSage(items, actor) {
  if (!Array.isArray(items) || items.length === 0) throw httpError(400, "items is required");
  if (items.length > 1000) throw httpError(400, "At most 1000 invoices at a time");
  let updated = 0;
  let ordersPaid = 0;
  await prisma.$transaction(async (tx) => {
    for (const item of items) {
      const total = Number(item.totalAmount);
      const outstanding = Number(item.outstandingAmount);
      if (!item.invoiceId || !Number.isFinite(total) || !Number.isFinite(outstanding) || total < 0 || outstanding < 0) continue;
      const inv = await tx.invoice.findUnique({ where: { id: String(item.invoiceId) } });
      if (!inv || inv.status !== "issued") continue;
      const paid = Math.max(0, Math.min(total, total - outstanding));
      const before = num(inv.amountPaid);
      const fullyPaid = outstanding <= 0.005;
      const payments = Array.isArray(inv.payments) ? [...inv.payments] : [];
      const sagePayment = { method: "other", amount: Math.round((paid - before) * 100) / 100, currency: inv.currency || "GBP", via: "sage", by: actor, at: new Date().toISOString(), note: "Seen in Sage" };
      if (Math.abs(paid - before) >= 0.005) payments.push(sagePayment);
      const row = await tx.invoice.update({
        where: { id: inv.id },
        data: {
          grossTotal: dec(total),
          amountPaid: dec(paid),
          paidAt: fullyPaid ? inv.paidAt ?? new Date() : null,
          payments,
          sageSyncedAt: new Date(),
        },
      });
      updated++;
      if (fullyPaid && (await markOrderPaidFromInvoice(row, { ...sagePayment, amount: total }, tx))) ordersPaid++;
    }
    await appendAdminEvent(
      "invoices_synced_from_sage",
      actor,
      { entityType: "invoice", summary: `Updated ${updated} invoice(s) from Sage${ordersPaid ? `; ${ordersPaid} order(s) now paid` : ""}` },
      tx
    );
  }, TX_OPTIONS);
  return { updated, ordersPaid };
}

module.exports = {
  BILLING,
  freshBilling: fresh,
  assertBillingSettled,
  attachInvoice,
  invoiceCreated,
  invoiceDeleted,
  invoiceIssued,
  recordPayment,
  setPaymentRequired,
  acknowledgeInvoice,
  waiveBilling,
  recordInvoicePayment,
  syncFromSage,
};
