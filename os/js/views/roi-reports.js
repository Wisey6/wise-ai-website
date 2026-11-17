// ROI reports: the monthly proof of value. A list by client and period, and an
// editor with a live, printable one-page document (same pattern as a proposal).
// The calculations are pure functions, exported so the tests can check them.
import {
  el, clear, fill, icon, badge, toast, modal, confirmDialog, field, input, select, textarea, emptyState,
  money, num, plural, go, copyText, busy, dayKey
} from '../ui.js?v=20261118c';
import { state, saveRow, deleteRow, rowById } from '../api.js?v=20261118c';

/* ================================================================ dates
   Dates are YYYY-MM-DD strings; maths is done in UTC so a day is a day. */
export const today = () => dayKey();
const D = (k) => new Date(`${String(k).slice(0, 10)}T00:00:00Z`);
export const addDays = (k, n) => new Date(D(k).getTime() + n * 86400000).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((D(b) - D(a)) / 86400000);
/** "17 Nov 2026" (or other en-AU parts). Accepts a date key or a timestamp. */
export function fmtDate(v, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!v) return '';
  const k = String(v).length > 10 ? dayKey(v) : String(v);
  return D(k).toLocaleDateString('en-AU', { timeZone: 'UTC', ...opts });
}
/** Day key of a date column or a timestamp. */
export const keyOf = (v) => (!v ? '' : String(v).length > 10 ? dayKey(v) : String(v).slice(0, 10));
const ymd = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);

/** The calendar month before the one `todayKey` is in. */
export function lastMonth(todayKey = today()) {
  const [y, m] = todayKey.split('-').map(Number);
  return { start: ymd(y, m - 2, 1), end: ymd(y, m - 1, 0) };
}
export function isWholeMonth(start, end) {
  if (!start || !end) return false;
  const [y, m, d] = start.split('-').map(Number);
  return d === 1 && end === ymd(y, m, 0);
}
/** The period after this one: the next calendar month, or the same number of days. */
export function nextPeriod(start, end) {
  if (isWholeMonth(start, end)) {
    const [y, m] = start.split('-').map(Number);
    return { start: ymd(y, m, 1), end: ymd(y, m + 1, 0) };
  }
  const len = periodDays(start, end) || 30;
  return { start: addDays(end, 1), end: addDays(end, len) };
}
/** "October 2026", or "1 Oct – 15 Nov 2026". */
export function periodLabel(start, end) {
  if (!start && !end) return 'No period set';
  if (!start || !end) return fmtDate(start || end);
  if (isWholeMonth(start, end)) return fmtDate(start, { month: 'long', year: 'numeric' });
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  return `${fmtDate(start, sameYear ? { day: 'numeric', month: 'short' } : undefined)} – ${fmtDate(end)}`;
}
/** Inclusive number of days in a period (0 when unset or backwards). */
export function periodDays(start, end) {
  if (!start || !end) return 0;
  const d = daysBetween(start, end) + 1;
  return d > 0 ? d : 0;
}

/* ========================================================== calculations */
const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const has = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
/** "9", "2.5", "1,240" */
export const fmtNum = (v) => new Intl.NumberFormat('en-AU', { maximumFractionDigits: 2 }).format(n(v));

export const PER = [
  { id: 'period', label: 'for the period', mult: () => 1 },
  { id: 'week', label: 'a week', mult: (days) => days / 7 },
  { id: 'day', label: 'a day', mult: (days) => days }
];
export const BETTER = [{ id: 'lower', label: 'Lower is better' }, { id: 'higher', label: 'Higher is better' }];

/**
 * One results row. The dollar value is the improvement × value per unit × how many
 * times the measure repeats in the period (a weekly figure over a 31-day month counts 31/7 times).
 * A change the wrong way is a negative value: shown, not hidden.
 */
export function metricCalc(m = {}, days = 0) {
  const filled = has(m.before) && has(m.after);
  const before = n(m.before);
  const after = n(m.after);
  const diff = after - before;
  const gain = m.better === 'lower' ? -diff : diff;
  const per = PER.find((p) => p.id === m.per) || PER[0];
  const mult = per.mult(days);
  const value = filled ? gain * n(m.value_per_unit) * mult : 0;
  const unit = String(m.unit || '').trim();
  let change = '';
  if (filled) {
    if (diff === 0) change = 'No change';
    else if (!unit) change = `${fmtNum(Math.abs(diff))} ${diff < 0 ? 'fewer' : 'more'}`;
    else change = `${diff < 0 ? 'Down' : 'Up'} ${fmtNum(Math.abs(diff))} ${unit}`;
  }
  const pct = filled && before !== 0 ? (Math.abs(diff) / Math.abs(before)) * 100 : null;
  return { filled, before, after, diff, gain, mult, value, change, pct, good: filled && gain > 0, bad: filled && gain < 0 };
}

/** Everything the report adds up to. verdict: 'positive' | 'below' | 'nofee' | 'empty'. */
export function reportTotals(r = {}) {
  const days = periodDays(r.period_start, r.period_end);
  const rows = (Array.isArray(r.metrics) ? r.metrics : []).map((m) => ({ m, ...metricCalc(m, days) }));
  const metricsValue = rows.reduce((s, x) => s + x.value, 0);
  const hoursValue = n(r.hours_saved) * n(r.hourly_value);
  const revenue = n(r.revenue_gained);
  const costSaved = n(r.cost_saved);
  const fee = n(r.fee);
  const total = metricsValue + hoursValue + revenue + costSaved;
  const net = total - fee;
  const multiple = fee > 0 ? total / fee : null;
  const verdict = multiple === null ? (total > 0 ? 'nofee' : 'empty') : multiple >= 1 ? 'positive' : 'below';
  return { days, rows, metricsValue, hoursValue, revenue, costSaved, fee, total, net, multiple, verdict, hours: n(r.hours_saved) };
}

/** "$6.32 back for every $1" */
export const returnLine = (multiple) => `$${(Math.floor(multiple * 100) / 100).toFixed(2)} back for every $1`;
const signedMoney = (v) => (v < 0 ? `−${money(-v)}` : money(v));

/** A fresh report for the period after `r`: last period's "after" becomes the new "before". */
export function duplicateReport(r, client = null) {
  const p = nextPeriod(r.period_start || lastMonth().start, r.period_end || lastMonth().end);
  const c = client || rowById('clients', r.client_id);
  return {
    client_id: r.client_id || null,
    title: reportTitle(c, p.start, p.end),
    period_start: p.start,
    period_end: p.end,
    metrics: (r.metrics || []).map((m) => ({
      label: m.label || '', before: has(m.after) ? Number(m.after) : (has(m.before) ? Number(m.before) : null), after: null,
      unit: m.unit || '', value_per_unit: has(m.value_per_unit) ? Number(m.value_per_unit) : null,
      better: m.better || 'higher', per: m.per || 'period'
    })),
    hours_saved: 0,
    hourly_value: n(r.hourly_value),
    revenue_gained: 0,
    cost_saved: 0,
    fee: c ? n(c.monthly_value) : n(r.fee),
    summary: '',
    next_steps: '',
    status: 'draft',
    sent_on: null
  };
}

export const reportTitle = (client, start, end) => `${client?.name || 'Client'} · ${periodLabel(start, end)}`;
const clientName = (id) => rowById('clients', id)?.name || 'No client';
const lines = (t) => String(t || '').split(/\r?\n/).map((s) => s.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean);

/** Plain text for an email. */
export function reportText(r, settings = state.settings || {}) {
  const t = reportTotals(r);
  const c = rowById('clients', r.client_id);
  const out = [];
  out.push(`${c?.name || 'Your'} results: ${periodLabel(r.period_start, r.period_end)}`, '');
  if (c?.contact_name) out.push(`Hi ${c.contact_name.split(/\s+/)[0]},`, '');
  out.push(`Value delivered: ${money(t.total)}`);
  if (t.fee > 0) {
    out.push(`Fee for the period: ${money(t.fee)}`);
    out.push(`Net gain: ${signedMoney(t.net)}`);
    if (t.verdict === 'positive') out.push(`That is ${returnLine(t.multiple)}.`);
  }
  if (t.hours > 0) out.push(`Hours saved: ${fmtNum(t.hours)}`);
  const filled = t.rows.filter((x) => x.filled && (x.m.label || '').trim());
  if (filled.length) {
    out.push('', 'Results');
    for (const x of filled) {
      const u = x.m.unit ? ` ${x.m.unit}` : '';
      out.push(`- ${x.m.label}: ${fmtNum(x.before)}${u} → ${fmtNum(x.after)}${u} (${x.change.toLowerCase()})${x.value ? `, worth about ${signedMoney(x.value)}` : ''}`);
    }
  }
  const extra = [];
  if (t.hoursValue) extra.push(`- Time back: ${fmtNum(t.hours)} hours at ${money(r.hourly_value)} an hour = ${money(t.hoursValue)}`);
  if (t.revenue) extra.push(`- Extra revenue: ${money(t.revenue)}`);
  if (t.costSaved) extra.push(`- Costs saved: ${money(t.costSaved)}`);
  if (extra.length) out.push('', 'Where the value came from', ...extra);
  if ((r.summary || '').trim()) out.push('', 'Summary', r.summary.trim());
  const next = lines(r.next_steps);
  if (next.length) out.push('', 'What is next', ...next.map((x) => `- ${x}`));
  out.push('', 'Tyler', `${settings?.business_name || 'Wise AI'} · tyler@wise-ai.au · wise-ai.au`);
  return out.join('\n');
}

/* ======================================================== the document */
const LOGO = '../logo.svg';

/** The one-page branded report. Pure: rebuilt from the report on every edit. */
export function reportDoc(r, settings = state.settings || {}) {
  const t = reportTotals(r);
  const c = rowById('clients', r.client_id);
  const headline = [];
  headline.push({ k: 'Value delivered', v: money(t.total), s: 'in the period' });
  if (t.verdict === 'positive') headline.push({ k: 'Return', v: `${(Math.floor(t.multiple * 10) / 10).toFixed(1)}×`, s: returnLine(t.multiple) });
  if (t.fee > 0 && t.net > 0) headline.push({ k: 'Net gain', v: money(t.net), s: `after the ${money(t.fee)} fee` });
  if (t.hours > 0) headline.push({ k: 'Hours saved', v: fmtNum(t.hours), s: t.hoursValue ? `worth ${money(t.hoursValue)}` : 'back in your week' });
  const best = t.rows.filter((x) => x.good && (x.m.label || '').trim()).sort((a, b) => b.value - a.value)[0];
  if (headline.length < 3 && best) headline.push({ k: best.m.label, v: `${fmtNum(best.before)} → ${fmtNum(best.after)}`, s: best.change });

  const rows = t.rows.filter((x) => (x.m.label || '').trim() || x.filled);
  const next = lines(r.next_steps);
  const breakdown = [
    t.metricsValue ? ['Results above', signedMoney(t.metricsValue)] : null,
    t.hoursValue ? [`Time back: ${fmtNum(t.hours)} h at ${money(r.hourly_value)}/h`, money(t.hoursValue)] : null,
    t.revenue ? ['Extra revenue', money(t.revenue)] : null,
    t.costSaved ? ['Costs saved', money(t.costSaved)] : null
  ].filter(Boolean);

  return el('article', { class: 'rr-doc', 'aria-label': 'Report preview' },
    el('header', { class: 'rr-doc-top' },
      el('img', { class: 'rr-doc-logo', src: LOGO, alt: 'Wise AI' }),
      el('div', { class: 'rr-doc-kind' }, el('span', {}, 'Results report'), el('span', {}, periodLabel(r.period_start, r.period_end)))),
    el('div', { class: 'rr-doc-title' },
      el('p', { class: 'rr-doc-eyebrow' }, 'Prepared for'),
      el('h2', { class: 'rr-doc-h1' }, c?.name || 'Choose a client'),
      el('p', { class: 'rr-doc-sub' }, `What the work delivered in ${isWholeMonth(r.period_start, r.period_end) ? periodLabel(r.period_start, r.period_end) : 'this period'}`,
        c?.contact_name ? `, for ${c.contact_name}` : '', '.')),
    el('div', { class: `rr-doc-kpis n${Math.min(headline.length, 4)}` }, headline.slice(0, 4).map((h) => el('div', { class: 'rr-doc-kpi' },
      el('span', { class: 'rr-doc-k' }, h.k), el('b', { class: 'rr-doc-v' }, h.v), el('span', { class: 'rr-doc-s' }, h.s)))),
    rows.length ? el('section', { class: 'rr-doc-sec' },
      el('h3', { class: 'rr-doc-h' }, 'The numbers'),
      el('table', { class: 'rr-doc-table' },
        el('thead', {}, el('tr', {}, el('th', {}, 'What we measured'), el('th', { class: 'num' }, 'Before'), el('th', { class: 'num' }, 'After'), el('th', {}, 'Change'), el('th', { class: 'num' }, 'Worth'))),
        el('tbody', {}, rows.map((x) => el('tr', {},
          el('td', {}, x.m.label || '—', x.m.unit ? el('span', { class: 'rr-doc-unit' }, ` (${x.m.unit})`) : null),
          el('td', { class: 'num' }, x.filled ? fmtNum(x.before) : '—'),
          el('td', { class: 'num' }, x.filled ? fmtNum(x.after) : '—'),
          el('td', { class: x.good ? 'is-good' : x.bad ? 'is-bad' : '' }, x.change || '—'),
          el('td', { class: 'num' }, x.value ? signedMoney(x.value) : '—')))))) : null,
    breakdown.length || t.fee ? el('section', { class: 'rr-doc-sec' },
      el('h3', { class: 'rr-doc-h' }, 'Where the value came from'),
      el('dl', { class: 'rr-doc-sum' },
        breakdown.map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', {}, v))),
        el('div', { class: 'is-total' }, el('dt', {}, 'Total value delivered'), el('dd', {}, money(t.total))),
        t.fee ? el('div', {}, el('dt', {}, 'Fee for the period'), el('dd', {}, `−${money(t.fee)}`)) : null,
        t.fee ? el('div', { class: 'is-net' }, el('dt', {}, 'Net gain'), el('dd', {}, signedMoney(t.net))) : null)) : null,
    (r.summary || '').trim() ? el('section', { class: 'rr-doc-sec' },
      el('h3', { class: 'rr-doc-h' }, 'In short'),
      ...String(r.summary).trim().split(/\n{2,}/).map((p) => el('p', { class: 'rr-doc-p' }, p))) : null,
    next.length ? el('section', { class: 'rr-doc-sec' },
      el('h3', { class: 'rr-doc-h' }, 'What is next'),
      el('ul', { class: 'rr-doc-list' }, next.map((x) => el('li', {}, x)))) : null,
    el('footer', { class: 'rr-doc-foot' },
      el('span', {}, el('b', {}, 'Tyler'), ` · ${settings?.business_name || 'Wise AI'}`),
      el('span', {}, 'tyler@wise-ai.au · wise-ai.au'),
      settings?.abn ? el('span', {}, `ABN ${settings.abn}`) : null));
}

/* ================================================================= view */
const ui = { client: '', status: 'all' };
const UUID = /^[0-9a-f-]{36}$/i;
const reportDate = (r) => r.sent_on || keyOf(r.created_at);

/** Clients that have had no report in the last 35 days (and have been clients that long). */
export function clientsDueReport(st = state) {
  const cutoff = addDays(today(), -35);
  return st.clients.filter((c) => !c.archived && c.status === 'active'
    && (keyOf(c.started_on || c.created_at) <= cutoff)
    && !st.roi_reports.some((r) => r.client_id === c.id && reportDate(r) > cutoff));
}

export default function roiReportsView(ctx) {
  const { param } = ctx;
  if (param && param.startsWith('new')) return editorView(null, param.split('/')[1] || '');
  if (param && UUID.test(param)) return editorView(param, '');
  return listView();
}

function listView() {
  const st = state;
  const root = el('div', { class: 'page dl-page' });
  const head = el('div', { class: 'page-head' },
    el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, 'Deliver'), el('h1', { class: 'h1' }, 'ROI reports'),
      el('p', { class: 'muted dl-lede' }, 'A short monthly note that shows each client what the work is worth. It is the reason they stay.')),
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'btn btn-primary', onClick: () => newReportFlow() }, icon('plus', 16), 'New ROI report')));
  const kpis = el('div');
  const due = el('div');
  const bar = el('div', { class: 'toolbar dl-bar' });
  const content = el('div');
  root.append(head, kpis, due, bar, content);

  function paint() {
    const reports = st.roi_reports;
    const cutoff = addDays(today(), -35);
    const yearAgo = addDays(today(), -365);
    const active = st.clients.filter((c) => !c.archived && c.status === 'active');
    const recent = new Set(reports.filter((r) => r.status === 'sent' && reportDate(r) > cutoff).map((r) => r.client_id));
    const covered = active.filter((c) => recent.has(c.id)).length;
    const shown = reports.filter((r) => r.status === 'sent' && (r.period_end || reportDate(r)) >= yearAgo).reduce((s, r) => s + reportTotals(r).total, 0);
    const dueList = clientsDueReport(st);
    fill(kpis, el('div', { class: 'grid cols-3 dl-kpis' },
      el('div', { class: 'kpi' }, el('span', { class: 'kpi-label' }, 'Sent in the last 35 days'),
        el('span', { class: 'kpi-value', dataset: { k: 'covered' } }, active.length ? `${num(covered)}/${num(active.length)}` : '0'),
        el('span', { class: 'kpi-sub' }, active.length ? 'active clients with a recent report' : 'no active clients yet')),
      el('div', { class: 'kpi' }, el('span', { class: 'kpi-label' }, 'Value shown, 12 months'),
        el('span', { class: 'kpi-value', dataset: { k: 'shown' } }, money(shown)), el('span', { class: 'kpi-sub' }, 'across sent reports')),
      el('div', { class: 'kpi' }, el('span', { class: 'kpi-label' }, 'Due a report'),
        el('span', { class: 'kpi-value', dataset: { k: 'due' } }, num(dueList.length)), el('span', { class: 'kpi-sub' }, 'nothing in 35 days'))));

    fill(due, dueList.length ? el('section', { class: 'section' },
      el('div', { class: 'section-head' }, el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, 'Due now'), el('h2', { class: 'h2' }, 'Clients waiting on their numbers'))),
      el('ul', { class: 'dl-due' }, dueList.map((c) => {
        const last = st.roi_reports.filter((r) => r.client_id === c.id).map(reportDate).sort().pop();
        return el('li', {},
          el('a', { href: `#clients/${c.id}`, class: 'dl-due-name' }, c.name),
          el('span', { class: 'muted small' }, last ? `Last report ${fmtDate(last)}` : 'No report yet'),
          el('a', { class: 'btn btn-ghost btn-sm', href: `#roi-reports/new/${c.id}` }, icon('edit', 13), 'Write it'));
      }))) : null);

    const clientOpts = [{ id: '', label: 'All clients' }, ...st.clients.filter((c) => reports.some((r) => r.client_id === c.id)).sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ id: c.id, label: c.name }))];
    const cSel = select('client', clientOpts, ui.client);
    cSel.classList.add('sm'); cSel.setAttribute('aria-label', 'Client');
    cSel.addEventListener('change', () => { ui.client = cSel.value; paint(); });
    const chip = (id, label, count) => el('button', { type: 'button', class: `chip${ui.status === id ? ' is-active' : ''}`, 'aria-pressed': String(ui.status === id), onClick: () => { ui.status = id; paint(); } }, label, el('span', { class: 'count' }, num(count)));
    fill(bar, reports.length ? [
      chip('all', 'All', reports.length), chip('draft', 'Drafts', reports.filter((r) => r.status === 'draft').length), chip('sent', 'Sent', reports.filter((r) => r.status === 'sent').length),
      el('span', { class: 'spacer' }), cSel] : null);

    const list = reports.filter((r) => (ui.status === 'all' || r.status === ui.status) && (!ui.client || r.client_id === ui.client))
      .sort((a, b) => String(b.period_end || '').localeCompare(String(a.period_end || '')) || String(b.created_at).localeCompare(String(a.created_at)));
    clear(content);
    if (!reports.length) {
      content.append(emptyState({
        icon: 'spark', title: 'No ROI reports yet',
        text: st.clients.length ? 'Once a month, put each client’s before and after numbers on one page: hours back, calls caught, money made. Takes ten minutes.' : 'Add a client first. Then, once a month, show them what the work was worth on one page.',
        action: st.clients.length ? el('button', { type: 'button', class: 'btn btn-primary', onClick: () => newReportFlow() }, icon('plus', 16), 'Write the first report')
          : el('a', { class: 'btn btn-primary', href: '#clients/new' }, icon('plus', 16), 'Add a client')
      }));
      return;
    }
    if (!list.length) { content.append(emptyState({ icon: 'search', title: 'Nothing matches', text: 'Try another client or status.' })); return; }
    content.append(el('div', { class: 'table-wrap' }, el('table', { class: 'table dl-table rr-table' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Client'), el('th', {}, 'Period'), el('th', { class: 'num' }, 'Value delivered'), el('th', { class: 'num' }, 'Return'), el('th', {}, 'Status'), el('th', {}, 'Sent'))),
      el('tbody', {}, list.map((r) => {
        const t = reportTotals(r);
        return el('tr', { class: 'is-click', dataset: { id: r.id }, onClick: () => go(`roi-reports/${r.id}`) },
          el('td', { class: 'dl-primary' }, el('a', { href: `#roi-reports/${r.id}`, class: 'dl-name', onClick: (e) => e.stopPropagation() }, clientName(r.client_id))),
          el('td', { 'data-label': 'Period' }, periodLabel(r.period_start, r.period_end)),
          el('td', { class: 'num', 'data-label': 'Value' }, money(t.total)),
          el('td', { class: 'num', 'data-label': 'Return' }, t.multiple === null ? el('span', { class: 'faint' }, '—')
            : el('span', { class: t.multiple < 1 ? 'dl-warn' : '' }, `${(Math.floor(t.multiple * 10) / 10).toFixed(1)}×`)),
          el('td', { 'data-label': 'Status' }, r.status === 'sent' ? badge('Sent', 'ok') : badge('Draft', 'mute')),
          el('td', { class: 'small muted nowrap', 'data-label': 'Sent' }, r.sent_on ? fmtDate(r.sent_on) : '—'));
      })))));
  }
  paint();
  root.onState = paint;
  return root;
}

/** Ask which client, then open a new report for them. */
async function newReportFlow(clientId = '') {
  const clients = state.clients.filter((c) => !c.archived).sort((a, b) => a.name.localeCompare(b.name));
  if (!clients.length) { go('roi-reports/new'); return; }
  const v = await modal({
    title: 'New ROI report',
    body: [field('Client', select('client_id', clients.map((c) => ({ id: c.id, label: c.name })), clientId || clients[0].id)),
      el('p', { class: 'small muted' }, 'The period starts as last month. You can change it in the report.')],
    confirmLabel: 'Start the report'
  });
  if (v) go(`roi-reports/new/${v.client_id}`);
}

/* =============================================================== editor */
function editorView(id, newClientId) {
  const st = state;
  const existing = id ? rowById('roi_reports', id) : null;
  const root = el('div', { class: 'page dl-page rr-page' });
  if (id && !existing) {
    root.append(el('a', { href: '#roi-reports', class: 'dl-back' }, icon('chevron-left', 15), 'ROI reports'),
      emptyState({ icon: 'alert', title: 'That report is not here', text: 'It may have been deleted.', action: el('a', { class: 'btn btn-ghost', href: '#roi-reports' }, 'Back to ROI reports') }));
    return root;
  }
  const client0 = rowById('clients', existing?.client_id || newClientId);
  const lm = lastMonth();
  // The working copy. Inputs write to it; the preview and autosave read it.
  const draft = existing ? JSON.parse(JSON.stringify(existing)) : {
    client_id: client0?.id || null,
    title: reportTitle(client0, lm.start, lm.end),
    period_start: lm.start, period_end: lm.end,
    metrics: [{ label: '', before: null, after: null, unit: '', value_per_unit: null, better: 'higher', per: 'period' }],
    hours_saved: 0, hourly_value: 0, revenue_gained: 0, cost_saved: 0,
    fee: n(client0?.monthly_value), summary: '', next_steps: '', status: 'draft', sent_on: null
  };
  if (!Array.isArray(draft.metrics)) draft.metrics = [];
  let titleTouched = Boolean(existing) && draft.title !== reportTitle(rowById('clients', draft.client_id), draft.period_start, draft.period_end);

  /* ---------------------------------------------------- autosave */
  let saveTimer = 0;
  let saving = null;
  let dirty = false;
  const saveState = el('span', { class: 'rr-save small muted', role: 'status', 'aria-live': 'polite' }, existing ? 'Saved' : 'Not saved yet');
  const payload = () => ({
    client_id: draft.client_id || null, title: (draft.title || '').trim() || reportTitle(rowById('clients', draft.client_id), draft.period_start, draft.period_end),
    period_start: draft.period_start || null, period_end: draft.period_end || null,
    metrics: draft.metrics.map((m) => ({
      label: m.label || '', before: has(m.before) ? Number(m.before) : null, after: has(m.after) ? Number(m.after) : null,
      unit: m.unit || '', value_per_unit: has(m.value_per_unit) ? Number(m.value_per_unit) : null, better: m.better || 'higher', per: m.per || 'period'
    })),
    hours_saved: n(draft.hours_saved), hourly_value: n(draft.hourly_value), revenue_gained: n(draft.revenue_gained),
    cost_saved: n(draft.cost_saved), fee: n(draft.fee), summary: draft.summary || null, next_steps: draft.next_steps || null
  });
  async function flush() {
    clearTimeout(saveTimer);
    if (saving) { dirty = true; return saving; }
    if (!dirty && draft.id) return null;
    dirty = false;
    saveState.textContent = 'Saving…';
    saving = (async () => {
      try {
        const row = await saveRow('roi_reports', draft.id ? { id: draft.id, ...payload() } : { ...payload(), status: 'draft' });
        if (!draft.id) {
          draft.id = row.id;
          draft.status = row.status;
          history.replaceState(null, '', `#roi-reports/${row.id}`);
        }
        saveState.textContent = 'Saved';
        drawActions();
      } catch (e) {
        dirty = true;
        saveState.textContent = 'Not saved';
        toast(e.message, 'bad');
      } finally {
        saving = null;
      }
      if (dirty) return flush();
      return null;
    })();
    return saving;
  }
  const touch = () => {
    dirty = true;
    saveState.textContent = 'Editing…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 700);
    paintPreview();
  };
  const leave = () => { if (dirty) flush(); };
  window.addEventListener('hashchange', leave, { once: true });

  /* ---------------------------------------------------- header */
  const titleH = el('h1', { class: 'h1 rr-h1' });
  const eyebrow = el('p', { class: 'eyebrow' });
  const actions = el('div', { class: 'row rr-actions' });
  const paintHead = () => {
    titleH.textContent = (draft.title || '').trim() || 'New ROI report';
    const live = draft.id ? rowById('roi_reports', draft.id) : null;
    eyebrow.textContent = live?.status === 'sent' ? `ROI report · sent ${fmtDate(live.sent_on)}` : 'ROI report · draft';
  };
  function drawActions() {
    paintHead();
    const live = draft.id ? rowById('roi_reports', draft.id) : null;
    const sent = live?.status === 'sent';
    fill(actions,
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => copyText(reportText({ ...draft }), 'Report copied as text') }, icon('copy', 14), 'Copy as text'),
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: async () => { await flush(); window.print(); } }, icon('download', 14), 'Print or PDF'),
      el('button', {
        type: 'button', class: `btn btn-sm ${sent ? 'btn-ghost' : 'btn-primary'}`, dataset: { act: 'sent' },
        onClick: (e) => busy(e.currentTarget, async () => {
          await flush();
          if (!draft.id) { toast('Add something to the report first', 'warn'); return; }
          try {
            await saveRow('roi_reports', sent ? { id: draft.id, status: 'draft', sent_on: null } : { id: draft.id, status: 'sent', sent_on: today() });
            toast(sent ? 'Back to draft' : `Marked as sent ${fmtDate(today())}`);
            drawActions();
          } catch (err) { toast(err.message, 'bad'); }
        })
      }, icon(sent ? 'refresh' : 'check', 14), sent ? 'Mark as draft' : 'Mark as sent'),
      el('button', {
        type: 'button', class: 'btn btn-ghost btn-sm', dataset: { act: 'duplicate' },
        onClick: (e) => busy(e.currentTarget, async () => {
          await flush();
          try {
            const row = await saveRow('roi_reports', duplicateReport({ ...draft }));
            toast(`Started ${periodLabel(row.period_start, row.period_end)}`);
            go(`roi-reports/${row.id}`);
          } catch (err) { toast(err.message, 'bad'); }
        })
      }, icon('copy', 14), 'Duplicate for next period'),
      draft.id ? el('button', {
        type: 'button', class: 'icon-btn', 'aria-label': 'Delete this report', title: 'Delete this report',
        onClick: async () => {
          if (!await confirmDialog('Delete this report?', `${draft.title} goes for good. The client’s other reports stay.`)) return;
          try { clearTimeout(saveTimer); dirty = false; await deleteRow('roi_reports', draft.id); toast('Report deleted'); go('roi-reports'); } catch (err) { toast(err.message, 'bad'); }
        }
      }, icon('trash', 16)) : null);
  }

  /* ---------------------------------------------------- form */
  const clientOpts = () => [{ id: '', label: 'Choose a client' }, ...st.clients.filter((c) => !c.archived || c.id === draft.client_id).sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ id: c.id, label: c.name }))];
  const clientSel = select('client_id', clientOpts(), draft.client_id || '');
  const titleIn = input('title', { value: draft.title || '', placeholder: 'Client · October 2026' });
  const startIn = input('period_start', { type: 'date', value: draft.period_start || '' });
  const endIn = input('period_end', { type: 'date', value: draft.period_end || '' });
  const periodNote = el('span', { class: 'field-hint' });
  const feeIn = input('fee', { type: 'number', value: draft.fee ?? 0, min: 0, step: 50, inputmode: 'decimal' });
  const retitle = () => {
    if (titleTouched) return;
    draft.title = reportTitle(rowById('clients', draft.client_id), draft.period_start, draft.period_end);
    titleIn.value = draft.title;
  };
  const paintPeriodNote = () => {
    const d = periodDays(draft.period_start, draft.period_end);
    periodNote.textContent = d ? `${plural(d, 'day')} · ${periodLabel(draft.period_start, draft.period_end)}` : 'Set both dates';
  };
  clientSel.addEventListener('change', () => {
    const prev = rowById('clients', draft.client_id);
    draft.client_id = clientSel.value || null;
    const c = rowById('clients', draft.client_id);
    if (c && (n(draft.fee) === 0 || n(draft.fee) === n(prev?.monthly_value))) { draft.fee = n(c.monthly_value); feeIn.value = String(draft.fee); }
    retitle(); paintHead(); touch();
  });
  titleIn.addEventListener('input', () => { titleTouched = Boolean(titleIn.value.trim()); draft.title = titleIn.value; paintHead(); touch(); });
  startIn.addEventListener('input', () => { draft.period_start = startIn.value || null; retitle(); paintHead(); paintPeriodNote(); paintMetricsCalc(); touch(); });
  endIn.addEventListener('input', () => { draft.period_end = endIn.value || null; retitle(); paintHead(); paintPeriodNote(); paintMetricsCalc(); touch(); });
  feeIn.addEventListener('input', () => { draft.fee = feeIn.value; touch(); });
  const lastMonthBtn = el('button', {
    type: 'button', class: 'link-btn small', onClick: () => {
      const p = lastMonth(); draft.period_start = p.start; draft.period_end = p.end; startIn.value = p.start; endIn.value = p.end;
      retitle(); paintHead(); paintPeriodNote(); paintMetricsCalc(); touch();
    }
  }, 'Last month');

  // Results table
  const metricsBox = el('div', { class: 'rr-metrics' });
  const calcNodes = [];
  function paintMetricsCalc() {
    const days = periodDays(draft.period_start, draft.period_end);
    draft.metrics.forEach((m, i) => {
      const node = calcNodes[i];
      if (!node) return;
      const c = metricCalc(m, days);
      const per = PER.find((p) => p.id === m.per);
      fill(node, c.filled
        ? [el('span', { class: c.good ? 'rr-good' : c.bad ? 'rr-bad' : '' }, c.change), c.pct !== null ? el('span', { class: 'faint' }, ` (${fmtNum(Math.round(c.pct))}%)`) : null,
          has(m.value_per_unit) ? [' · ', el('b', {}, signedMoney(c.value)), per && per.id !== 'period' ? el('span', { class: 'faint' }, ` (${fmtNum(Math.abs(c.diff))} × ${money(m.value_per_unit)} × ${fmtNum(Math.round(c.mult * 100) / 100)} ${per.id === 'week' ? 'weeks' : 'days'})`) : null] : el('span', { class: 'faint' }, ' · add a $ value per unit to count it')]
        : el('span', { class: 'faint' }, 'Fill in before and after to see the change'));
    });
  }
  function drawMetrics() {
    calcNodes.length = 0;
    fill(metricsBox, draft.metrics.map((m, i) => {
      const set = (k, v) => { m[k] = v; paintMetricsCalc(); touch(); };
      const lab = input(`m-label-${i}`, { value: m.label || '', placeholder: 'e.g. Missed calls', 'aria-label': `Result ${i + 1}: what was measured` });
      const before = input(`m-before-${i}`, { type: 'number', value: m.before ?? '', step: 'any', inputmode: 'decimal', 'aria-label': `Result ${i + 1}: before` });
      const after = input(`m-after-${i}`, { type: 'number', value: m.after ?? '', step: 'any', inputmode: 'decimal', 'aria-label': `Result ${i + 1}: after` });
      const unit = input(`m-unit-${i}`, { value: m.unit || '', placeholder: 'calls', 'aria-label': `Result ${i + 1}: unit` });
      const vpu = input(`m-vpu-${i}`, { type: 'number', value: m.value_per_unit ?? '', min: 0, step: 'any', inputmode: 'decimal', placeholder: '0', 'aria-label': `Result ${i + 1}: dollar value of one unit` });
      const better = select(`m-better-${i}`, BETTER, m.better || 'higher');
      better.setAttribute('aria-label', `Result ${i + 1}: which way is better`);
      const per = select(`m-per-${i}`, PER.map((p) => ({ id: p.id, label: `Counted ${p.label}` })), m.per || 'period');
      per.setAttribute('aria-label', `Result ${i + 1}: how often the numbers happen`);
      [before, after, vpu, unit, better, per].forEach((x) => x.classList.add('sm'));
      lab.classList.add('sm');
      lab.addEventListener('input', () => set('label', lab.value));
      before.addEventListener('input', () => set('before', before.value));
      after.addEventListener('input', () => set('after', after.value));
      unit.addEventListener('input', () => set('unit', unit.value));
      vpu.addEventListener('input', () => set('value_per_unit', vpu.value));
      better.addEventListener('change', () => set('better', better.value));
      per.addEventListener('change', () => set('per', per.value));
      const calc = el('div', { class: 'rr-m-calc small', 'aria-live': 'polite' });
      calcNodes.push(calc);
      return el('div', { class: 'rr-m', dataset: { i } },
        el('div', { class: 'rr-m-row1' }, lab,
          el('button', { type: 'button', class: 'icon-btn sm', 'aria-label': `Remove result ${i + 1}`, onClick: () => { draft.metrics.splice(i, 1); drawMetrics(); touch(); } }, icon('x', 15))),
        el('div', { class: 'rr-m-grid' },
          el('label', { class: 'rr-m-f' }, el('span', {}, 'Before'), before),
          el('label', { class: 'rr-m-f' }, el('span', {}, 'After'), after),
          el('label', { class: 'rr-m-f' }, el('span', {}, 'Unit'), unit),
          el('label', { class: 'rr-m-f' }, el('span', {}, '$ per unit'), vpu)),
        el('div', { class: 'rr-m-grid2' }, better, per),
        calc);
    }), draft.metrics.length ? null : el('p', { class: 'small muted' }, 'No results yet. Add the numbers you tracked before and after: missed calls, response time, bookings, reviews.'));
    paintMetricsCalc();
  }
  const addMetric = el('button', {
    type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => {
      draft.metrics.push({ label: '', before: null, after: null, unit: '', value_per_unit: null, better: 'higher', per: 'period' });
      drawMetrics();
      metricsBox.querySelector('.rr-m:last-child input')?.focus();
    }
  }, icon('plus', 13), 'Add a result');

  const numIn = (k, label, hint, opts = {}) => {
    const x = input(k, { type: 'number', value: draft[k] ?? 0, min: 0, step: opts.step || 'any', inputmode: 'decimal' });
    x.addEventListener('input', () => { draft[k] = x.value; touch(); });
    return field(label, x, hint);
  };
  const summaryIn = textarea('summary', draft.summary || '', 'Two or three plain sentences: what changed for them, in their terms.');
  summaryIn.rows = 4;
  summaryIn.addEventListener('input', () => { draft.summary = summaryIn.value; touch(); });
  const nextIn = textarea('next_steps', draft.next_steps || '', 'One per line, e.g. Add after-hours booking to the website');
  nextIn.rows = 3;
  nextIn.addEventListener('input', () => { draft.next_steps = nextIn.value; touch(); });

  const verdictBox = el('div', { class: 'rr-verdict', 'aria-live': 'polite' });
  const paintVerdict = () => {
    const t = reportTotals(draft);
    fill(verdictBox,
      el('dl', { class: 'rr-sum' },
        el('div', {}, el('dt', {}, 'Results'), el('dd', { dataset: { k: 'metrics' } }, signedMoney(t.metricsValue))),
        el('div', {}, el('dt', {}, 'Hours saved × hourly value'), el('dd', { dataset: { k: 'hours' } }, money(t.hoursValue))),
        el('div', {}, el('dt', {}, 'Revenue gained + costs saved'), el('dd', { dataset: { k: 'extra' } }, money(t.revenue + t.costSaved))),
        el('div', { class: 'is-total' }, el('dt', {}, 'Total value delivered'), el('dd', { dataset: { k: 'total' } }, signedMoney(t.total))),
        el('div', {}, el('dt', {}, 'Fee for the period'), el('dd', { dataset: { k: 'fee' } }, money(t.fee))),
        el('div', { class: 'is-total' }, el('dt', {}, 'Net gain'), el('dd', { dataset: { k: 'net' } }, signedMoney(t.net))),
        el('div', {}, el('dt', {}, 'Return'), el('dd', { dataset: { k: 'multiple' } }, t.multiple === null ? '—' : returnLine(t.multiple)))),
      t.verdict === 'below' ? el('div', { class: 'callout is-warn rr-warn', role: 'alert' }, icon('alert', 16),
        el('span', {}, el('b', {}, 'Below the fee this period. '), `The work returned ${money(t.total)} against a ${money(t.fee)} fee, so $${(Math.floor(t.multiple * 100) / 100).toFixed(2)} for every $1. The report will not claim a return. Say it plainly in the summary and set out what changes next month.`)) : null,
      t.verdict === 'nofee' ? el('p', { class: 'small muted' }, 'No fee set for the period, so no return is shown.') : null);
  };

  const editor = el('form', { class: 'rr-editor', novalidate: true, onSubmit: (e) => e.preventDefault() },
    el('section', { class: 'rr-sec' },
      el('h2', { class: 'rr-sec-h' }, 'Client and period'),
      el('div', { class: 'form-grid' },
        el('div', { class: 'full' }, field('Client', clientSel)),
        field('From', startIn), field('To', endIn),
        el('div', { class: 'full rr-period-note' }, periodNote, lastMonthBtn),
        el('div', { class: 'full' }, field('Title', titleIn)))),
    el('section', { class: 'rr-sec' },
      el('div', { class: 'rr-sec-top' }, el('h2', { class: 'rr-sec-h' }, 'Results'), addMetric),
      el('p', { class: 'small muted' }, 'Each row is one number from before the work and after it. The $ per unit is what one more booking, or one fewer missed call, is worth to them.'),
      metricsBox),
    el('section', { class: 'rr-sec' },
      el('h2', { class: 'rr-sec-h' }, 'Time and money'),
      el('div', { class: 'form-grid' },
        numIn('hours_saved', 'Hours saved', 'In the period'),
        numIn('hourly_value', 'Value of an hour', 'What their time is worth, $'),
        numIn('revenue_gained', 'Revenue gained', 'Extra sales you can trace to the work, $'),
        numIn('cost_saved', 'Costs saved', 'Wages, software or fees no longer paid, $'),
        el('div', { class: 'full' }, field('Fee for the period', feeIn, 'What they paid you for this period. Starts as their monthly retainer.'))),
      el('p', { class: 'small muted' }, 'Count each saving once. If the hours are already inside a result above, leave them out here.')),
    el('section', { class: 'rr-sec' }, el('h2', { class: 'rr-sec-h' }, 'The return'), verdictBox),
    el('section', { class: 'rr-sec' },
      el('h2', { class: 'rr-sec-h' }, 'In words'),
      field('Summary', summaryIn), field('What is next', nextIn, 'One step per line.')));

  const docWrap = el('div', { class: 'rr-doc-wrap' });
  function paintPreview() {
    fill(docWrap, reportDoc(draft));
    paintVerdict();
  }

  const head = el('div', { class: 'page-head rr-head' },
    el('div', { class: 'stack' },
      el('a', { href: '#roi-reports', class: 'dl-back' }, icon('chevron-left', 15), 'ROI reports'),
      eyebrow, titleH,
      el('div', { class: 'row small muted' }, saveState,
        draft.client_id ? el('a', { href: `#clients/${draft.client_id}`, class: 'link-btn' }, 'Client page') : null)),
    actions);
  const removed = el('div');
  root.append(head, removed, el('div', { class: 'rr-split' }, editor, el('div', { class: 'rr-preview' }, el('p', { class: 'eyebrow rr-preview-label' }, 'Preview · prints to one A4 page'), docWrap)));

  drawMetrics();
  paintPeriodNote();
  drawActions();
  paintPreview();

  // Live updates never touch the inputs: only the select's options, the header and the preview.
  root.onState = () => {
    const opts = clientOpts();
    const cur = clientSel.value;
    if (document.activeElement !== clientSel) { fill(clientSel, opts.map((o) => el('option', { value: o.id }, o.label))); clientSel.value = cur; }
    if (draft.id && !rowById('roi_reports', draft.id) && !saving) {
      fill(removed, el('div', { class: 'callout is-warn' }, icon('alert', 16), 'This report was deleted elsewhere. Your text is still here; copy it if you need it.'));
    }
    drawActions();
    fill(docWrap, reportDoc(draft));
  };
  return root;
}
