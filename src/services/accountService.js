// Clients' standing accounts: from the invoices that went to Sage (status "issued"), per client --
//   in the period (invoice date from..to): invoices raised, how many are paid, invoiced / paid / still owed
//   overall: balance (everything still owed), of which overdue (past the due date)
// "Paid" comes from the invoice's amountPaid: card payments in the portal, payments staff record, and "Update from
// Sage" (orderBillingService.syncFromSage) -- Sage is where on-account clients' payments land.
const prisma = require("../config/prisma");
const httpError = require("../utils/httpError");
const { dateOnly } = require("../utils/serialize");
const { parsePagination } = require("../utils/pagination");

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const num = (d) => (d == null ? 0 : Number(d));
const round = (n) => Math.round(n * 100) / 100;

function period({ from, to }) {
  for (const [name, v] of [["from", from], ["to", to]]) if (v && !DATE.test(String(v))) throw httpError(400, `${name} must be a date (YYYY-MM-DD)`);
  if (from && to && to < from) throw httpError(400, "The period ends before it starts");
  return { from: from || null, to: to || null };
}

function invoiceFigures(inv, today) {
  const total = num(inv.grossTotal ?? inv.netTotal);
  const paid = Math.min(total, num(inv.amountPaid));
  const outstanding = round(Math.max(0, total - paid));
  return {
    total: round(total),
    paid: round(paid),
    outstanding,
    isPaid: outstanding === 0,
    overdue: outstanding > 0 && dateOnly(inv.dueDate) < today,
  };
}

function emptySummary(clientId, clientName) {
  return { clientId, clientName, invoices: 0, paidInvoices: 0, unpaidInvoices: 0, invoiced: 0, paid: 0, outstanding: 0, balance: 0, overdue: 0, lastInvoiceDate: undefined, lastSyncedAt: undefined };
}

function summarise(invoices, p) {
  const today = new Date().toISOString().slice(0, 10);
  const byClient = new Map();
  for (const inv of invoices) {
    const s = byClient.get(inv.clientId) ?? emptySummary(inv.clientId, inv.clientName);
    byClient.set(inv.clientId, s);
    const f = invoiceFigures(inv, today);
    s.balance += f.outstanding;
    if (f.overdue) s.overdue += f.outstanding;
    const date = dateOnly(inv.invoiceDate);
    if (!s.lastInvoiceDate || date > s.lastInvoiceDate) s.lastInvoiceDate = date;
    if (inv.sageSyncedAt && (!s.lastSyncedAt || inv.sageSyncedAt.toISOString() > s.lastSyncedAt)) s.lastSyncedAt = inv.sageSyncedAt.toISOString();
    if ((p.from && date < p.from) || (p.to && date > p.to)) continue;
    s.invoices++;
    if (f.isPaid) s.paidInvoices++;
    else s.unpaidInvoices++;
    s.invoiced += f.total;
    s.paid += f.paid;
    s.outstanding += f.outstanding;
  }
  for (const s of byClient.values()) for (const k of ["invoiced", "paid", "outstanding", "balance", "overdue"]) s[k] = round(s[k]);
  return byClient;
}

const ISSUED_FIELDS = { id: true, invoiceNumber: true, clientId: true, clientName: true, invoiceDate: true, dueDate: true, netTotal: true, grossTotal: true, amountPaid: true, paidAt: true, sageSyncedAt: true, sageInvoiceNumber: true, orderId: true, currency: true };

async function listAccounts(params = {}) {
  const p = period(params);
  const where = { status: "issued" };
  if (params.q) where.clientName = { contains: String(params.q).slice(0, 100), mode: "insensitive" };
  const invoices = await prisma.invoice.findMany({ where, select: ISSUED_FIELDS });
  const all = [...summarise(invoices, p).values()].sort((a, b) => b.balance - a.balance || a.clientName.localeCompare(b.clientName));
  const { skip, take } = parsePagination(params);
  const totals = all.reduce(
    (t, s) => ({ invoiced: t.invoiced + s.invoiced, paid: t.paid + s.paid, outstanding: t.outstanding + s.outstanding, balance: t.balance + s.balance, overdue: t.overdue + s.overdue }),
    { invoiced: 0, paid: 0, outstanding: 0, balance: 0, overdue: 0 }
  );
  for (const k of Object.keys(totals)) totals[k] = round(totals[k]);
  return { items: all.slice(skip, skip + take), total: all.length, totals, period: p };
}

// One client's statement: its summary plus the invoices of the period (newest first) and the unpaid ones from before.
async function clientAccount(clientId, params = {}) {
  const p = period(params);
  const today = new Date().toISOString().slice(0, 10);
  const [invoices, drafts] = await Promise.all([
    prisma.invoice.findMany({ where: { clientId, status: "issued" }, select: { ...ISSUED_FIELDS, payments: true }, orderBy: [{ invoiceDate: "desc" }, { invoiceNumber: "desc" }] }),
    prisma.invoice.count({ where: { clientId, status: { not: "issued" } } }),
  ]);
  const summary = summarise(invoices, p).get(clientId) ?? emptySummary(clientId, params.clientName || clientId);
  const inPeriod = (inv) => {
    const d = dateOnly(inv.invoiceDate);
    return !(p.from && d < p.from) && !(p.to && d > p.to);
  };
  const row = (inv) => {
    const f = invoiceFigures(inv, today);
    return {
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      sageInvoiceNumber: inv.sageInvoiceNumber ?? undefined,
      invoiceDate: dateOnly(inv.invoiceDate),
      dueDate: dateOnly(inv.dueDate),
      orderId: inv.orderId ?? undefined,
      currency: inv.currency ?? "GBP",
      ...f,
      paidAt: inv.paidAt?.toISOString(),
      lastPaymentVia: Array.isArray(inv.payments) && inv.payments.length ? inv.payments[inv.payments.length - 1].via : undefined,
    };
  };
  return {
    summary,
    drafts,
    items: invoices.filter(inPeriod).map(row),
    // still owed from before the period -- part of the balance
    earlierUnpaid: p.from
      ? invoices.filter((inv) => dateOnly(inv.invoiceDate) < p.from && invoiceFigures(inv, today).outstanding > 0).map(row)
      : [],
    period: p,
  };
}

// For "Update from Sage": the Sage ids of the issued invoices to check (all, or one client's).
async function sageInvoicesToSync({ clientId } = {}) {
  const rows = await prisma.invoice.findMany({
    where: { status: "issued", sageInvoiceId: { not: null }, ...(clientId && { clientId }) },
    select: { id: true, invoiceNumber: true, sageInvoiceId: true, sageContactId: true, invoiceDate: true },
  });
  return rows.map((r) => ({ invoiceId: r.id, invoiceNumber: r.invoiceNumber, sageInvoiceId: r.sageInvoiceId, sageContactId: r.sageContactId ?? undefined, invoiceDate: dateOnly(r.invoiceDate) }));
}

module.exports = { listAccounts, clientAccount, sageInvoicesToSync };
