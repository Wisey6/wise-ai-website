// Money and business figures for the chat agent's `numbers` tool. Pure (no Deno APIs).
//
// These are ports of the hub's own maths so the assistant quotes the same figures the
// hub shows: os/js/views/money-math.js (Income, Costs, Runway) and businessNumbers() in
// os/js/views/home.js. supabase/tests/chat.test.mjs runs both on one fixture and checks
// they agree, so a change on one side without the other fails the tests.
// Dates are ISO 'YYYY-MM-DD' strings throughout, so they compare as text.

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

/* ------------------------------------------------------------- numbers */
export const n0 = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
export const r2 = (n: unknown) => Math.round((n0(n) + Number.EPSILON) * 100) / 100;
const sum = <T>(list: T[], f: (x: T) => unknown) => r2(list.reduce((t, x) => t + n0(f(x)), 0));

/* --------------------------------------------------------------- dates */
const pad = (n: number) => String(n).padStart(2, "0");
export const monthKey = (iso: unknown) => String(iso || "").slice(0, 7);
export const monthStart = (mk: string) => `${mk}-01`;
export function monthEnd(mk: string): string {
  const [y, m] = mk.split("-").map(Number);
  return `${mk}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}
export function addMonths(mk: string, n: number): string {
  const [y, m] = mk.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}
export function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const inRange = (iso: unknown, from: string, to: string) => Boolean(iso) && String(iso) >= from && String(iso) <= to;
export function monthsBetween(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  for (let mk = monthKey(fromIso); mk <= monthKey(toIso); mk = addMonths(mk, 1)) out.push(mk);
  return out;
}
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthLabel = (mk: string) => `${MONTHS_LONG[Number(mk.slice(5, 7)) - 1]} ${mk.slice(0, 4)}`;
/** Australian financial year (1 July - 30 June) containing iso. */
export function fyRange(iso: string) {
  const y = Number(iso.slice(0, 4));
  const s = Number(iso.slice(5, 7)) >= 7 ? y : y - 1;
  return { from: `${s}-07-01`, to: `${s + 1}-06-30`, label: `FY ${s}–${String(s + 1).slice(2)}` };
}
/** BAS quarter containing iso. */
export function quarterRange(iso: string) {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const sm = Math.floor((m - 1) / 3) * 3 + 1;
  return { from: `${y}-${pad(sm)}-01`, to: monthEnd(`${y}-${pad(sm + 2)}`) };
}

/* -------------------------------------------------------------- income */
export const issuedOf = (r: Row) => r.issued_on || String(r.created_at || "").slice(0, 10);
export const isPaid = (r: Row) => r.status === "paid" && Boolean(r.paid_on);
export const isReceivable = (r: Row) => r.status === "invoiced";
export const isOverdue = (r: Row, today: string) => isReceivable(r) && Boolean(r.due_on) && r.due_on < today;
export const gstPart = (r: Row, settings: Row | null) => (settings && settings.gst_registered ? Math.min(n0(r.gst), n0(r.amount)) : 0);
export const netAmount = (r: Row, settings: Row | null) => r2(n0(r.amount) - gstPart(r, settings));

export function moneyIn(income: Row[], settings: Row | null, from: string, to: string) {
  const rows = income.filter((r) => isPaid(r) && inRange(r.paid_on, from, to));
  return {
    rows, count: rows.length,
    gross: sum(rows, (r) => r.amount), gst: sum(rows, (r) => gstPart(r, settings)), net: sum(rows, (r) => netAmount(r, settings)),
  };
}

export function receivables(income: Row[], today: string, range?: { from: string; to: string }) {
  const rows = income.filter((r) => isReceivable(r) && (!range || inRange(issuedOf(r), range.from, range.to)));
  const late = rows.filter((r) => isOverdue(r, today));
  return { rows, count: rows.length, total: sum(rows, (r) => r.amount), overdueRows: late, overdueCount: late.length, overdue: sum(late, (r) => r.amount) };
}

export function incomeByMonth(income: Row[], settings: Row | null, endMk: string, n = 12) {
  const out: { key: string; gross: number; gst: number; net: number; count: number }[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const key = addMonths(endMk, -i);
    const m = moneyIn(income, settings, monthStart(key), monthEnd(key));
    out.push({ key, gross: m.gross, gst: m.gst, net: m.net, count: m.count });
  }
  return out;
}

/** Next invoice number: highest INV-#### + 1, four digits. */
export function suggestInvoiceNo(income: Row[]): string {
  let max = 0;
  for (const r of income) {
    const m = /^INV-(\d+)$/i.exec(String(r.invoice_no || "").trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `INV-${String(max + 1).padStart(4, "0")}`;
}

export const isActiveClient = (c: Row) => Boolean(c) && c.status === "active" && !c.archived;
export const recurringRevenue = (clients: Row[]) => sum(clients.filter(isActiveClient), (c) => c.monthly_value);

/* --------------------------------------------------------------- costs */
export const isRecurring = (c: Row) => c.cadence === "monthly" || c.cadence === "yearly";
export const monthlyEquivalent = (c: Row) => (c.cadence === "monthly" ? n0(c.amount) : c.cadence === "yearly" ? n0(c.amount) / 12 : 0);
/** A recurring cost running on `today`: active, started (or no start), not ended (ended_on after today). */
export const isRunning = (c: Row, today: string) => isRecurring(c) && c.active !== false &&
  (!c.started_on || c.started_on <= today) && (!c.ended_on || c.ended_on > today);
export const monthlyBurn = (costs: Row[], today: string) => sum(costs.filter((c) => isRunning(c, today)), monthlyEquivalent);
/** Whether a recurring cost applies to month mk (overlaps it by its dates). Switched off with no end date: never. */
export const recurringInMonth = (c: Row, mk: string) => isRecurring(c) && (c.active !== false || Boolean(c.ended_on)) &&
  (!c.started_on || c.started_on <= monthEnd(mk)) && (!c.ended_on || c.ended_on >= monthStart(mk));
export const recurringForMonth = (costs: Row[], mk: string) => sum(costs.filter((c) => recurringInMonth(c, mk)), monthlyEquivalent);
export const oneOffRows = (costs: Row[], from: string, to: string) => costs.filter((c) => c.cadence === "one_off" && inRange(c.incurred_on, from, to));
export const oneOffs = (costs: Row[], from: string, to: string) => sum(oneOffRows(costs, from, to), (c) => c.amount);
export function costsForRange(costs: Row[], from: string, to: string) {
  const recurring = sum(monthsBetween(from, to), (mk) => recurringForMonth(costs, mk));
  const once = oneOffs(costs, from, to);
  return { recurring, oneOff: once, total: r2(recurring + once) };
}

/* ------------------------------------------------------- tax and runway */
export const taxSetAside = (rate: unknown, revenue: unknown, costs: unknown) => r2(Math.max(0, n0(rate) * (n0(revenue) - n0(costs))));

export function quarterToDate(income: Row[], costs: Row[], settings: Row | null, today: string) {
  const q = quarterRange(today);
  const m = moneyIn(income, settings, q.from, today);
  const c = costsForRange(costs, q.from, today);
  return { ...q, revenue: m.net, gst: m.gst, costs: c.total, profit: r2(m.net - c.total), tax: taxSetAside(settings ? settings.tax_rate : 0, m.net, c.total) };
}

export function monthSoFar(income: Row[], costs: Row[], settings: Row | null, today: string) {
  const mk = monthKey(today);
  const inn = moneyIn(income, settings, monthStart(mk), today).net;
  const out = r2(recurringForMonth(costs, mk) + oneOffs(costs, monthStart(mk), today));
  return { in: inn, out, net: r2(inn - out) };
}

export function averageIn(income: Row[], settings: Row | null, today: string, months = 3) {
  const end = addMonths(monthKey(today), -1);
  const list = incomeByMonth(income, settings, end, months);
  return { months: list, total: sum(list, (m) => m.net), average: r2(sum(list, (m) => m.net) / months) };
}

export function runway({ cash, avgIn, burn, draw }: { cash: unknown; avgIn: unknown; burn: unknown; draw: unknown }) {
  const need = r2(n0(burn) + n0(draw));
  const net = r2(n0(avgIn) - need);
  const shortfall = r2(Math.max(0, need - n0(avgIn)));
  const burning = shortfall > 0;
  return { need, net, shortfall, burning, months: burning ? Math.max(0, n0(cash)) / shortfall : null, spare: burning ? 0 : net };
}

export function projection({ cash, clients, income, costs, settings, draw, today, months = 6 }:
  { cash: unknown; clients: Row[]; income: Row[]; costs: Row[]; settings: Row | null; draw: unknown; today: string; months?: number }) {
  const rows: Row[] = [];
  let start = r2(cash);
  const first = addMonths(monthKey(today), 1);
  const open = income.filter(isReceivable);
  const active = clients.filter((c) => isActiveClient(c) && n0(c.monthly_value) > 0);
  let zeroKey: string | null = null;
  for (let i = 0; i < months; i += 1) {
    const key = addMonths(first, i);
    const from = monthStart(key);
    const to = monthEnd(key);
    const due = open.filter((r) => (i === 0 ? (r.due_on || today) <= to : inRange(r.due_on, from, to)));
    const invoiced = new Set(due.filter((r) => r.kind === "retainer" && inRange(r.due_on, from, to)).map((r) => r.client_id));
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

/* ------------------------------------------------- home.js businessNumbers */
const ymd = (d: unknown) => String(d || "").slice(0, 10);
const isOpenDeal = (d: Row) => !d.archived && !["won", "lost"].includes(d.stage);

/** The business at a glance, exactly as the hub's Today page computes it. */
export function businessNumbers(state: { deals?: Row[]; clients?: Row[]; income?: Row[]; settings?: Row | null }, today: string) {
  const month = today.slice(0, 7);
  const open = (state.deals || []).filter(isOpenDeal);
  const active = (state.clients || []).filter((c) => !c.archived && c.status === "active");
  const paid = (state.income || []).filter((i) => i.status === "paid" && ymd(i.paid_on || i.issued_on).slice(0, 7) === month);
  const unpaid = (state.income || []).filter((i) => i.status === "invoiced");
  const s = (rows: Row[], k: string) => rows.reduce((t, r) => t + (Number(r[k]) || 0), 0);
  const target = Number(state.settings?.monthly_target) || 0;
  const moneyIn = s(paid, "amount");
  return {
    pipeline: s(open, "value"), pipelineMonthly: s(open, "monthly_value"), openDeals: open.length,
    mrr: s(active, "monthly_value"), activeClients: active.length,
    moneyIn, target, targetPct: target ? Math.round((moneyIn / target) * 100) : null,
    unpaid: s(unpaid, "amount"), unpaidCount: unpaid.length,
    overdue: unpaid.filter((i) => i.due_on && ymd(i.due_on) < today).length,
    hasData: Boolean((state.clients || []).length || (state.deals || []).length || (state.income || []).length),
  };
}

/* ------------------------------------------------------ the numbers tool */

export const NUMBER_TOPICS = ["money", "costs", "runway", "pipeline", "tasks", "all"] as const;
export type NumberTopic = typeof NUMBER_TOPICS[number];

export type NumbersData = {
  settings: Row; income: Row[]; costs: Row[]; clients: Row[]; deals: Row[]; tasks: Row[]; leads: Row[];
  team: Row[]; clientNames: Record<string, string>;
};

const money = (n: unknown) => r2(n);

/**
 * Every figure the assistant may quote, computed here so the model never does arithmetic on raw rows.
 * Amounts are Australian dollars; "monthly" figures for yearly costs are amount / 12.
 */
export function computeNumbers(what: NumberTopic, d: NumbersData, today: string): Row {
  const st = d.settings ?? {};
  const out: Row = { today, currency: "AUD" };
  const mk = monthKey(today);
  const nextMk = addMonths(mk, 1);
  const income = d.income.filter((r) => r.status !== "void");
  const owner = (id: unknown) => (id ? d.team.find((m) => m.id === id)?.name ?? "someone not on the team" : "nobody");
  const want = (t: NumberTopic) => what === "all" || what === t;

  if (want("money")) {
    const fy = fyRange(today);
    const m = moneyIn(income, st, monthStart(mk), monthEnd(mk));
    const fyIn = moneyIn(income, st, fy.from, today);
    const rec = receivables(income, today);
    const biz = businessNumbers({ deals: d.deals, clients: d.clients, income, settings: st }, today);
    const q = quarterToDate(income, d.costs, st, today);
    out.money = {
      definitions: "Money in = invoices marked paid, by paid date. Net = less GST (only when GST registered). Unpaid = status invoiced. Overdue = unpaid past its due date.",
      gst_registered: st.gst_registered === true,
      this_month: { label: monthLabel(mk), paid_invoices: m.count, money_in_gross: m.gross, money_in_net: m.net, target: biz.target, percent_of_target: biz.targetPct },
      month_so_far: monthSoFar(income, d.costs, st, today),
      financial_year_to_date: { label: fy.label, from: fy.from, money_in_gross: fyIn.gross, money_in_net: fyIn.net, gst_collected: fyIn.gst },
      quarter_to_date: { from: q.from, revenue: q.revenue, costs: q.costs, profit: q.profit, rough_tax_set_aside: q.tax, tax_rate: n0(st.tax_rate) },
      unpaid: { count: rec.count, total: rec.total },
      overdue: {
        count: rec.overdueCount, total: rec.overdue,
        invoices: rec.overdueRows.slice(0, 10).map((r) => ({
          id: r.id, client: d.clientNames[r.client_id] ?? null, description: r.description, amount: money(r.amount), due_on: r.due_on, link: `#income/${r.id}`,
        })),
      },
      recurring_revenue_monthly: recurringRevenue(d.clients),
      active_clients: biz.activeClients,
      last_3_months_in_net: incomeByMonth(income, st, addMonths(mk, -1), 3).map((x) => ({ month: monthLabel(x.key), net: x.net })),
    };
  }

  if (want("costs")) {
    const running = d.costs.filter((c) => isRunning(c, today));
    const thisMonth = recurringForMonth(d.costs, mk);
    const nextMonth = recurringForMonth(d.costs, nextMk);
    const inThis = new Set(d.costs.filter((c) => recurringInMonth(c, mk)).map((c) => c.id));
    const inNext = new Set(d.costs.filter((c) => recurringInMonth(c, nextMk)).map((c) => c.id));
    const changes = d.costs.filter((c) => isRecurring(c) && inThis.has(c.id) !== inNext.has(c.id)).map((c) => ({
      id: c.id, name: c.name, monthly: r2(monthlyEquivalent(c)),
      change: inThis.has(c.id) ? `stops (ended_on ${c.ended_on})` : `starts (started_on ${c.started_on})`,
    }));
    const fy = fyRange(today);
    out.costs = {
      definitions: "Running = recurring (monthly or yearly), active, started, and ended_on (if set) after today. A recurring cost counts in a month when its dates overlap that month. Yearly costs count as amount / 12 a month.",
      monthly_burn_now: monthlyBurn(d.costs, today),
      recurring_this_month: { label: monthLabel(mk), total: thisMonth },
      recurring_next_month: { label: monthLabel(nextMk), total: nextMonth },
      difference_next_month: r2(nextMonth - thisMonth),
      what_changes_next_month: changes,
      running: running.sort((a, b) => monthlyEquivalent(b) - monthlyEquivalent(a)).map((c) => ({
        id: c.id, name: c.name, vendor: c.vendor ?? null, cadence: c.cadence, amount: money(c.amount), monthly: r2(monthlyEquivalent(c)),
        next_due: c.next_due ?? null, ended_on: c.ended_on ?? null,
      })),
      ending_within_60_days: d.costs.filter((c) => isRecurring(c) && c.ended_on && c.ended_on >= today && c.ended_on <= addDaysIso(today, 60))
        .map((c) => ({ id: c.id, name: c.name, ended_on: c.ended_on, monthly: r2(monthlyEquivalent(c)) })),
      due_within_14_days: d.costs.filter((c) => isRunning(c, today) && c.next_due && c.next_due >= today && c.next_due <= addDaysIso(today, 14))
        .map((c) => ({ id: c.id, name: c.name, next_due: c.next_due, amount: money(c.amount) })),
      one_offs_this_month: { total: oneOffs(d.costs, monthStart(mk), monthEnd(mk)), items: oneOffRows(d.costs, monthStart(mk), monthEnd(mk)).map((c) => ({ id: c.id, name: c.name, amount: money(c.amount), incurred_on: c.incurred_on })) },
      financial_year_to_date: { label: fy.label, ...costsForRange(d.costs, fy.from, today) },
    };
  }

  if (want("runway")) {
    const avg = averageIn(income, st, today, 3);
    const burn = monthlyBurn(d.costs, today);
    const rw = runway({ cash: st.cash_on_hand, avgIn: avg.average, burn, draw: st.owner_draw });
    const pr = projection({ cash: st.cash_on_hand, clients: d.clients, income, costs: d.costs, settings: st, draw: st.owner_draw, today, months: 6 });
    out.runway = {
      definitions: "Need = monthly burn + owner draw. Average in = net money in over the last 3 full months. Runway months = cash / (need - average in) when that is positive. Projection: from next month, retainers + unpaid invoices due in, recurring costs + draw + one-offs out.",
      cash_on_hand: money(st.cash_on_hand), cash_as_of: st.cash_as_of ?? null, owner_draw: money(st.owner_draw),
      average_in_last_3_months: avg.average, monthly_burn: burn,
      need_per_month: rw.need, net_per_month: rw.net, burning: rw.burning,
      runway_months: rw.months === null ? null : Math.round(rw.months * 10) / 10,
      projection: pr.rows.map((r) => ({ month: monthLabel(r.key), in: r.in, out: r.out, close: r.close })),
      cash_goes_negative_in: pr.zeroKey ? monthLabel(pr.zeroKey) : null,
    };
  }

  if (want("pipeline")) {
    const open = d.deals.filter(isOpenDeal);
    const byStage: Record<string, { count: number; value: number; monthly: number }> = {};
    for (const x of open) {
      const s = (byStage[x.stage] ??= { count: 0, value: 0, monthly: 0 });
      s.count++; s.value = r2(s.value + n0(x.value)); s.monthly = r2(s.monthly + n0(x.monthly_value));
    }
    const funnel: Record<string, number> = {};
    for (const l of d.leads) if (!l.archived) funnel[l.status] = (funnel[l.status] ?? 0) + 1;
    const month = monthKey(today);
    const closed = d.deals.filter((x) => (x.stage === "won" || x.stage === "lost") && monthKey(x.closed_on) === month);
    out.pipeline = {
      definitions: "Open = not won or lost, not archived. Weighted = value x probability.",
      open_deals: open.length, open_value_one_off: sum(open, (x) => x.value), open_value_monthly: sum(open, (x) => x.monthly_value),
      weighted_one_off: sum(open, (x) => n0(x.value) * n0(x.probability) / 100),
      weighted_monthly: sum(open, (x) => n0(x.monthly_value) * n0(x.probability) / 100),
      by_stage: byStage,
      next_steps_due: open.filter((x) => x.next_step_on && x.next_step_on <= addDaysIso(today, 7)).sort((a, b) => String(a.next_step_on).localeCompare(String(b.next_step_on)))
        .slice(0, 10).map((x) => ({ id: x.id, title: x.title, next_step: x.next_step ?? null, next_step_on: x.next_step_on, owner: owner(x.owner_id), link: `#pipeline/${x.id}` })),
      won_this_month: closed.filter((x) => x.stage === "won").length, lost_this_month: closed.filter((x) => x.stage === "lost").length,
      lead_funnel: funnel,
    };
  }

  if (want("tasks")) {
    const open = d.tasks.filter((t) => t.state !== "done");
    const per: Record<string, { open: number; overdue: number; due_today: number; due_this_week: number }> = {};
    const weekEnd = addDaysIso(today, 7);
    for (const t of open) {
      const p = (per[owner(t.owner_id)] ??= { open: 0, overdue: 0, due_today: 0, due_this_week: 0 });
      p.open++;
      if (t.due_on && t.due_on < today) p.overdue++;
      if (t.due_on === today) p.due_today++;
      if (t.due_on && t.due_on >= today && t.due_on <= weekEnd) p.due_this_week++;
    }
    out.tasks = {
      open: open.length,
      overdue: open.filter((t) => t.due_on && t.due_on < today).length,
      due_today: open.filter((t) => t.due_on === today).length,
      no_due_date: open.filter((t) => !t.due_on).length,
      per_person: per,
      overdue_list: open.filter((t) => t.due_on && t.due_on < today).sort((a, b) => String(a.due_on).localeCompare(String(b.due_on))).slice(0, 10)
        .map((t) => ({ id: t.id, title: t.title, due_on: t.due_on, owner: owner(t.owner_id), link: t.project_id ? `#projects/${t.project_id}` : "#projects/tasks" })),
    };
  }
  return out;
}
