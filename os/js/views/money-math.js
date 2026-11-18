// Wise AI OS: Money maths. Pure functions only (no DOM, no state), shared by
// Income, Costs and Runway and unit-tested in os/tests/money.test.mjs.
//
// Definitions (the views print these in small type next to each figure):
//  - Money in: income rows with status 'paid', dated by paid_on.
//  - Receivable: status 'invoiced' (not draft, paid or void). Overdue: receivable
//    whose due_on is before today.
//  - GST: when settings.gst_registered, income.gst is the GST inside amount.
//    Revenue = amount - gst. When not registered, gst is ignored (0).
//  - Recurring cost: cadence monthly or yearly, active, started and not ended.
//    Monthly equivalent = amount (monthly) or amount / 12 (yearly).
//    One-off cost: counts only in the month of incurred_on.
//  - Tax set-aside = tax_rate x (revenue - costs) for the period, floor 0.
// Dates are ISO 'YYYY-MM-DD' strings throughout, so they compare as text.

/* ------------------------------------------------------------- numbers */
export const n0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
/** Round to cents. */
export const r2 = (n) => Math.round((n0(n) + Number.EPSILON) * 100) / 100;
const sum = (list, f) => r2(list.reduce((t, x) => t + n0(f(x)), 0));

/* --------------------------------------------------------------- dates */
const pad = (n) => String(n).padStart(2, '0');
/** Local (browser) date as YYYY-MM-DD. */
export function isoDate(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export const todayIso = () => isoDate(new Date());
export const monthKey = (iso) => String(iso || '').slice(0, 7);
export const monthStart = (mk) => `${mk}-01`;
export function monthEnd(mk) {
  const [y, m] = mk.split('-').map(Number);
  return `${mk}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}
export function addMonths(mk, n) {
  const [y, m] = mk.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}
export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Same day next month / year, clamped to the month's last day (31 Jan -> 28/29 Feb). */
export function addMonthsToDate(iso, n) {
  const mk = addMonths(monthKey(iso), n);
  const day = Math.min(Number(iso.slice(8, 10)), Number(monthEnd(mk).slice(8, 10)));
  return `${mk}-${pad(day)}`;
}
/** Whole days from a to b (b - a). */
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
export const inRange = (iso, from, to) => Boolean(iso) && iso >= from && iso <= to;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthLabel = (mk, long = false) => `${(long ? MONTHS_LONG : MONTHS)[Number(mk.slice(5, 7)) - 1]} ${mk.slice(0, 4)}`;
export const monthShort = (mk) => MONTHS[Number(mk.slice(5, 7)) - 1];

/** Calendar month containing iso. */
export function monthRange(iso) {
  const mk = monthKey(iso);
  return { from: monthStart(mk), to: monthEnd(mk), label: monthLabel(mk, true) };
}
/** Australian financial year (1 July - 30 June) containing iso. */
export function fyRange(iso) {
  const y = Number(iso.slice(0, 4));
  const s = Number(iso.slice(5, 7)) >= 7 ? y : y - 1;
  return { from: `${s}-07-01`, to: `${s + 1}-06-30`, label: `FY ${s}–${String(s + 1).slice(2)}`, startYear: s };
}
/** BAS quarter (Jul-Sep, Oct-Dec, Jan-Mar, Apr-Jun) containing iso. */
export function quarterRange(iso) {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const sm = Math.floor((m - 1) / 3) * 3 + 1;
  const from = `${y}-${pad(sm)}-01`;
  const to = monthEnd(`${y}-${pad(sm + 2)}`);
  return { from, to, label: `${MONTHS[sm - 1]}–${MONTHS[sm + 1]} ${y}` };
}
/** Month keys from a's month to b's month inclusive. */
export function monthsBetween(fromIso, toIso) {
  const out = [];
  for (let mk = monthKey(fromIso); mk <= monthKey(toIso); mk = addMonths(mk, 1)) out.push(mk);
  return out;
}

/* -------------------------------------------------------------- income */
/** The date an invoice belongs to for period filters: issued_on, else the day it was entered. */
export const issuedOf = (r) => r.issued_on || String(r.created_at || '').slice(0, 10);
export const isPaid = (r) => r.status === 'paid' && Boolean(r.paid_on);
export const isReceivable = (r) => r.status === 'invoiced';
export const isOverdue = (r, today) => isReceivable(r) && Boolean(r.due_on) && r.due_on < today;
/** GST inside an invoice (0 when not registered; never more than the amount). */
export const gstPart = (r, settings) => (settings && settings.gst_registered ? Math.min(n0(r.gst), n0(r.amount)) : 0);
/** Revenue: the amount less its GST. */
export const netAmount = (r, settings) => r2(n0(r.amount) - gstPart(r, settings));
/** Suggested GST for a GST-inclusive amount: 1/11. */
export const suggestGst = (amount, settings) => (settings && settings.gst_registered ? r2(n0(amount) / 11) : 0);

/** Paid income with paid_on in [from, to]. gross = as invoiced, net = revenue ex GST. */
export function moneyIn(income, settings, from, to) {
  const rows = income.filter((r) => isPaid(r) && inRange(r.paid_on, from, to));
  return {
    rows,
    count: rows.length,
    gross: sum(rows, (r) => r.amount),
    gst: sum(rows, (r) => gstPart(r, settings)),
    net: sum(rows, (r) => netAmount(r, settings))
  };
}

/** Invoiced and unpaid, optionally limited to invoices issued in [from, to]. Amounts as invoiced. */
export function receivables(income, today, range) {
  const rows = income.filter((r) => isReceivable(r) && (!range || inRange(issuedOf(r), range.from, range.to)));
  const late = rows.filter((r) => isOverdue(r, today));
  return { rows, count: rows.length, total: sum(rows, (r) => r.amount), overdueRows: late, overdueCount: late.length, overdue: sum(late, (r) => r.amount) };
}

/** Money in per month for the n months ending at endMk, oldest first. */
export function incomeByMonth(income, settings, endMk, n = 12) {
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const key = addMonths(endMk, -i);
    const m = moneyIn(income, settings, monthStart(key), monthEnd(key));
    out.push({ key, gross: m.gross, gst: m.gst, net: m.net, count: m.count });
  }
  return out;
}

/** Next invoice number: highest INV-#### + 1, four digits. */
export function suggestInvoiceNo(income) {
  let max = 0;
  for (const r of income) {
    const m = /^INV-(\d+)$/i.exec(String(r.invoice_no || '').trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `INV-${String(max + 1).padStart(4, '0')}`;
}
/** Invoice numbers for a batch, in order. */
export function nextInvoiceNos(income, count) {
  const first = Number(suggestInvoiceNo(income).slice(4));
  return Array.from({ length: count }, (_, i) => `INV-${String(first + i).padStart(4, '0')}`);
}

export const isActiveClient = (c) => c && c.status === 'active' && !c.archived;

/** Active clients on a retainer with no retainer invoice (other than void) issued in today's month. */
export function dueRetainers(clients, income, today) {
  const mk = monthKey(today);
  return clients
    .filter((c) => isActiveClient(c) && n0(c.monthly_value) > 0)
    .filter((c) => !income.some((r) => r.client_id === c.id && r.kind === 'retainer' && r.status !== 'void' && monthKey(issuedOf(r)) === mk))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/**
 * A draft retainer invoice for a client. monthly_value is the retainer before GST:
 * when GST registered the invoice adds 10% on top and records it as the GST portion.
 */
export function retainerInvoice(client, settings, today, invoiceNo, dueDays = 14) {
  const value = r2(client.monthly_value);
  const gst = settings && settings.gst_registered ? r2(value * 0.1) : 0;
  return {
    client_id: client.id,
    description: `${client.name} retainer, ${monthLabel(monthKey(today), true)}`,
    amount: r2(value + gst),
    gst,
    kind: 'retainer',
    status: 'draft',
    invoice_no: invoiceNo,
    issued_on: today,
    due_on: addDays(today, dueDays)
  };
}

/* --------------------------------------------------------------- costs */
export const isRecurring = (c) => c.cadence === 'monthly' || c.cadence === 'yearly';
export const monthlyEquivalent = (c) => (c.cadence === 'monthly' ? n0(c.amount) : c.cadence === 'yearly' ? n0(c.amount) / 12 : 0);
/** A recurring cost running on `today`: active, started (or no start), not ended (ended_on after today). */
export const isRunning = (c, today) => isRecurring(c) && c.active !== false
  && (!c.started_on || c.started_on <= today) && (!c.ended_on || c.ended_on > today);
/** Monthly burn: sum of monthly equivalents of running recurring costs. */
export const monthlyBurn = (costs, today) => sum(costs.filter((c) => isRunning(c, today)), monthlyEquivalent);
/**
 * Whether a recurring cost applies to month mk: it overlaps the month by its dates.
 * A cost switched off with no end date never counts.
 */
export const recurringInMonth = (c, mk) => isRecurring(c) && (c.active !== false || Boolean(c.ended_on))
  && (!c.started_on || c.started_on <= monthEnd(mk)) && (!c.ended_on || c.ended_on >= monthStart(mk));
export const recurringForMonth = (costs, mk) => sum(costs.filter((c) => recurringInMonth(c, mk)), monthlyEquivalent);
/** One-off costs with incurred_on in [from, to]. */
export const oneOffRows = (costs, from, to) => costs.filter((c) => c.cadence === 'one_off' && inRange(c.incurred_on, from, to));
export const oneOffs = (costs, from, to) => sum(oneOffRows(costs, from, to), (c) => c.amount);
/** All costs for a span: each month's recurring costs (whole months) + one-offs dated in the span. */
export function costsForRange(costs, from, to) {
  const recurring = sum(monthsBetween(from, to), (mk) => recurringForMonth(costs, mk));
  const once = oneOffs(costs, from, to);
  return { recurring, oneOff: once, total: r2(recurring + once) };
}
/** 'overdue' | 'soon' (within 7 days) | 'later' | null */
export function dueState(c, today) {
  if (!c.next_due) return null;
  const d = daysBetween(today, c.next_due);
  return d < 0 ? 'overdue' : d <= 7 ? 'soon' : 'later';
}
/** next_due moved on by one cadence period. */
export const rollNextDue = (c) => (c.next_due ? addMonthsToDate(c.next_due, c.cadence === 'yearly' ? 12 : 1) : null);
/** The n biggest running recurring costs by monthly equivalent. */
export const biggestRecurring = (costs, today, n = 3) => costs.filter((c) => isRunning(c, today))
  .sort((a, b) => monthlyEquivalent(b) - monthlyEquivalent(a)).slice(0, n);

/** Per client with any running cost linked: retainer vs linked monthly costs. */
export function clientMargins(clients, costs, today) {
  const running = costs.filter((c) => c.client_id && isRunning(c, today));
  const ids = [...new Set(running.map((c) => c.client_id))];
  return ids.map((id) => {
    const client = clients.find((c) => c.id === id) || null;
    const linked = running.filter((c) => c.client_id === id);
    const value = r2(client ? client.monthly_value : 0);
    const cost = sum(linked, monthlyEquivalent);
    const margin = r2(value - cost);
    return { id, client, value, cost, margin, pct: value > 0 ? margin / value : null, count: linked.length };
  }).sort((a, b) => a.margin - b.margin);
}

/* ------------------------------------------------------- tax and runway */
export const taxSetAside = (rate, revenue, costs) => r2(Math.max(0, n0(rate) * (n0(revenue) - n0(costs))));

/** Quarter to date: revenue, GST collected, costs, rough tax set-aside. */
export function quarterToDate(income, costs, settings, today) {
  const q = quarterRange(today);
  const m = moneyIn(income, settings, q.from, today);
  const c = costsForRange(costs, q.from, today);
  return {
    ...q, revenue: m.net, gst: m.gst, costs: c.total, profit: r2(m.net - c.total),
    tax: taxSetAside(settings ? settings.tax_rate : 0, m.net, c.total)
  };
}

/** This month so far: revenue in, costs out (this month's recurring + one-offs to today), net. */
export function monthSoFar(income, costs, settings, today) {
  const mk = monthKey(today);
  const inn = moneyIn(income, settings, monthStart(mk), today).net;
  const out = r2(recurringForMonth(costs, mk) + oneOffs(costs, monthStart(mk), today));
  return { in: inn, out, net: r2(inn - out) };
}

/** Average monthly revenue over the `months` full months before today's month. */
export function averageIn(income, settings, today, months = 3) {
  const end = addMonths(monthKey(today), -1);
  const list = incomeByMonth(income, settings, end, months);
  return { months: list, total: sum(list, (m) => m.net), average: r2(sum(list, (m) => m.net) / months) };
}

/** Sum of active clients' monthly_value. */
export const recurringRevenue = (clients) => sum(clients.filter(isActiveClient), (c) => c.monthly_value);

/**
 * need = burn + draw (the break-even month); net = avgIn - need.
 * Burning when net < 0: runway months = cash / (need - avgIn). Otherwise months is null.
 */
export function runway({ cash, avgIn, burn, draw }) {
  const need = r2(n0(burn) + n0(draw));
  const net = r2(n0(avgIn) - need);
  const shortfall = r2(Math.max(0, need - n0(avgIn)));
  const burning = shortfall > 0;
  return { need, net, shortfall, burning, months: burning ? Math.max(0, n0(cash)) / shortfall : null, spare: burning ? 0 : net };
}

/**
 * Six-month cash projection from next month, starting from cash on hand. Figures exclude GST
 * (it passes through to the ATO). In = active retainers + receivables (ex GST) due that month;
 * the first month also collects anything overdue or due before it. A retainer is not counted
 * twice: when a client already has a retainer invoice due that month, the invoice counts instead.
 * Out = recurring costs for that month + owner draw + one-offs dated in that month.
 */
export function projection({ cash, clients, income, costs, settings, draw, today, months = 6 }) {
  const rows = [];
  let start = r2(cash);
  const first = addMonths(monthKey(today), 1);
  const open = income.filter(isReceivable);
  const active = clients.filter((c) => isActiveClient(c) && n0(c.monthly_value) > 0);
  let zeroKey = null;
  for (let i = 0; i < months; i += 1) {
    const key = addMonths(first, i);
    const from = monthStart(key);
    const to = monthEnd(key);
    const due = open.filter((r) => (i === 0 ? (r.due_on || today) <= to : inRange(r.due_on, from, to)));
    const invoiced = new Set(due.filter((r) => r.kind === 'retainer' && inRange(r.due_on, from, to)).map((r) => r.client_id));
    const retainers = sum(active.filter((c) => !invoiced.has(c.id)), (c) => c.monthly_value);
    const recv = sum(due, (r) => netAmount(r, settings));
    const recurring = recurringForMonth(costs, key);
    const once = oneOffs(costs, from, to);
    const inn = r2(retainers + recv);
    const out = r2(recurring + n0(draw) + once);
    const close = r2(start + inn - out);
    if (zeroKey === null && close < 0) zeroKey = key;
    rows.push({ key, start, retainers, receivables: recv, in: inn, recurring, draw: r2(draw), oneOff: once, out, close });
    start = close;
  }
  return { rows, zeroKey };
}
