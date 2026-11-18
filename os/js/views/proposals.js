// Proposals: the list, and an editor whose live preview is the real document Tyler sends.
// The ROI maths is the public calculator's (roi.js) so the numbers agree, with a payback
// period added against the proposal's own price. Drafts autosave; typed text is never
// replaced by live updates (the editor owns its copy while it is open).
import {
  el, fill, clear, icon, badge, toast, modal, confirmDialog, field, input, select, textarea,
  emptyState, money, num, plural, dayKey, go, busy, copyText, timeOnly
} from '../ui.js?v=20261118e';
import { state, saveRow, deleteRow, rowById, leadById, leadName, ai } from '../api.js?v=20261118e';

/* ------------------------------------------------------------- statuses */
export const PROPOSAL_STATUSES = [
  { id: 'draft', label: 'Draft', tone: 'mute' },
  { id: 'sent', label: 'Sent', tone: 'info' },
  { id: 'accepted', label: 'Accepted', tone: 'ok' },
  { id: 'declined', label: 'Declined', tone: 'bad' },
  { id: 'expired', label: 'Expired', tone: 'warn' }
];
export const PROPOSAL_STATUS = Object.fromEntries(PROPOSAL_STATUSES.map((s) => [s.id, s]));

const today = () => dayKey();
const addDays = (ymd, d) => new Date(Date.parse(`${ymd}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
const n = (v) => Number(v) || 0;

/** Sent and past its valid-until date reads as Expired. */
export function effectiveStatus(p, on = today()) {
  if (p.status === 'sent' && p.valid_until && p.valid_until < on) return 'expired';
  return p.status || 'draft';
}

/** Totals of the line items. GST (10%) only when registered. */
export function proposalTotals(p, settings = state.settings || {}) {
  const items = Array.isArray(p.line_items) ? p.line_items : [];
  const oneOff = items.filter((i) => !i.recurring).reduce((a, i) => a + n(i.amount), 0);
  const monthly = items.filter((i) => i.recurring).reduce((a, i) => a + n(i.amount), 0);
  const gst = Boolean(settings?.gst_registered);
  return {
    oneOff, monthly, gst,
    gstOneOff: gst ? oneOff * 0.1 : 0, gstMonthly: gst ? monthly * 0.1 : 0,
    oneOffInc: gst ? oneOff * 1.1 : oneOff, monthlyInc: gst ? monthly * 1.1 : monthly,
    firstYear: oneOff + monthly * 12
  };
}

/* ------------------------------------------------------------------ ROI
   Same maths as the public calculator (/roi.js), a month = 52/12 weeks:
     missed / month    = enquiries per week × missed share × 52/12
     jobs lost / month = missed / month × close rate
     revenue / month   = jobs lost / month × average job value      (× 12 for a year)
     admin / month     = admin hours per week × hourly cost × 52/12
     fixing half       = (revenue / month + admin / month) ÷ 2       (× 12 for a year)
   Added here: payback (months) = (one-off + monthly × 12) ÷ fixing half a month. */
export const ROI_DEFAULTS = Object.freeze({ enq: 15, miss: 20, job: 600, close: 30, hrs: 6, rate: 45 });
export const ROI_FIELDS = [
  { id: 'enq', label: 'Enquiries per week', step: 1 },
  { id: 'miss', label: 'Share missed or late (%)', step: 1 },
  { id: 'job', label: 'Average job value ($)', step: 50 },
  { id: 'close', label: 'Close rate (%)', step: 1 },
  { id: 'hrs', label: 'Admin hours per week', step: 1 },
  { id: 'rate', label: 'Hourly cost ($)', step: 5 }
];
const WEEKS_PER_MONTH = 52 / 12;

export function roiCompute(inp, price = { oneOff: 0, monthly: 0 }) {
  const s = { ...ROI_DEFAULTS, ...Object.fromEntries(Object.entries(inp || {}).map(([k, v]) => [k, Math.max(0, n(v))])) };
  const missedPerMonth = s.enq * (s.miss / 100) * WEEKS_PER_MONTH;
  const jobsLost = missedPerMonth * (s.close / 100);
  const revMonth = jobsLost * s.job;
  const adminMonth = s.hrs * s.rate * WEEKS_PER_MONTH;
  const halfMonth = (revMonth + adminMonth) / 2;
  const firstYearCost = n(price.oneOff) + n(price.monthly) * 12;
  const paybackMonths = halfMonth > 0 && firstYearCost > 0 ? firstYearCost / halfMonth : null;
  return {
    missedPerMonth, jobsLost, revMonth, revYear: revMonth * 12, adminMonth, halfMonth, halfYear: halfMonth * 12,
    firstYearCost, paybackMonths, firstYearNet: halfMonth * 12 - firstYearCost
  };
}
const fmt1 = (v) => (Math.round(v * 10) / 10).toLocaleString('en-AU', { maximumFractionDigits: 1 });
const plain = (v) => Number(v).toLocaleString('en-AU', { maximumFractionDigits: 2 });

/** The working, line by line, as the public calculator shows it. */
export function roiWorking(inp, r) {
  const s = { ...ROI_DEFAULTS, ...inp };
  const lines = [
    ['Missed or late enquiries a month', `${plain(s.enq)} a week × ${plain(s.miss)}% × 52 ÷ 12`, fmt1(r.missedPerMonth)],
    ['Jobs lost a month', `${fmt1(r.missedPerMonth)} × ${plain(s.close)}% close rate`, fmt1(r.jobsLost)],
    ['Work left on the table a month', `${fmt1(r.jobsLost)} jobs × ${money(s.job)}`, money(r.revMonth)],
    ['Admin time a month', `${plain(s.hrs)} hrs × ${money(s.rate)} × 52 ÷ 12`, money(r.adminMonth)],
    ['Fixing half of that, a month', `(${money(r.revMonth)} + ${money(r.adminMonth)}) ÷ 2`, money(r.halfMonth)],
    ['Fixing half, a year', `${money(r.halfMonth)} × 12`, money(r.halfYear)]
  ];
  if (r.paybackMonths !== null) {
    lines.push(['Pays for itself in', `${money(r.firstYearCost)} first-year cost ÷ ${money(r.halfMonth)} a month`, `${fmt1(r.paybackMonths)} months`]);
  }
  return lines;
}

/* ------------------------------------------------------- [check: …] markers
   AI drafts mark facts Tyler must confirm as "[check: …]". None may reach a client. */
export function checkMarkers(p) {
  const texts = [p.problem, p.solution, p.terms, ...(Array.isArray(p.scope) ? p.scope.flatMap((x) => [x.title, x.detail]) : [])];
  return texts.flatMap((t) => String(t || '').match(/\[check:[^\]]*\]?/gi) || []);
}
const aiReady = () => Boolean(state.ai?.configured && state.ai.enabled);

/* ---------------------------------------------------------- numbering */
export function suggestNumber(proposals = state.proposals, year = today().slice(0, 4)) {
  const prefix = `WA-${year}-`;
  const mine = proposals.filter((p) => String(p.number || '').startsWith(prefix));
  const max = mine.reduce((a, p) => Math.max(a, parseInt(String(p.number).slice(prefix.length), 10) || 0), 0);
  return `${prefix}${String(Math.max(max, mine.length) + 1).padStart(3, '0')}`;
}

export const DEFAULT_TERMS = [
  'Half of the one-off fee is due to start, and the balance once the system is live and working the way we agreed.',
  'Monthly fees are billed in advance and cover hosting, running costs and small changes. You can stop with 30 days\' notice.',
  'The accounts, numbers and data set up for your business are yours. Prices are in Australian dollars.'
].join('\n\n');
const termsDefault = () => (state.settings?.proposal_terms || '').trim() || DEFAULT_TERMS;

/** New proposal from a deal: recipient, problem and prices carried across. */
export async function createProposalFromDeal(deal) {
  const client = deal.client_id ? rowById('clients', deal.client_id) : null;
  const lead = deal.lead_id ? leadById(deal.lead_id) : null;
  const items = [];
  if (n(deal.value)) items.push({ label: 'Build and set-up', amount: n(deal.value), recurring: false });
  if (n(deal.monthly_value)) items.push({ label: 'Monthly running and support', amount: n(deal.monthly_value), recurring: true });
  return saveRow('proposals', {
    deal_id: deal.id, client_id: deal.client_id || null, lead_id: deal.lead_id || null,
    number: suggestNumber(), title: deal.title, status: 'draft',
    recipient_name: client?.contact_name || lead?.contact_name || null,
    recipient_business: client?.name || lead?.business || null,
    problem: lead?.pain || null, solution: null, scope: [], line_items: items,
    roi: { include: false, inputs: { ...ROI_DEFAULTS } },
    terms: termsDefault(), valid_until: addDays(today(), 14)
  });
}

async function createBlank(title) {
  return saveRow('proposals', {
    number: suggestNumber(), title, status: 'draft', scope: [], line_items: [],
    roi: { include: false, inputs: { ...ROI_DEFAULTS } }, terms: termsDefault(), valid_until: addDays(today(), 14)
  });
}

/* ---------------------------------------------------------- formatting */
function longDate(ymd) {
  if (!ymd) return '';
  const d = new Date(`${String(ymd).slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
}
function shortDate(ymd) {
  if (!ymd) return '';
  const d = new Date(`${String(ymd).slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}
const firstName = (s) => String(s || '').trim().split(/\s+/)[0] || '';
const businessOf = (p) => (p.recipient_business || '').trim() || (p.recipient_name || '').trim() || 'your business';

/** Plain text → paragraphs; a block whose lines all start with "- " becomes a list. Text nodes only. */
function paras(text) {
  const blocks = String(text || '').trim().split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((b) => {
    const lines = b.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.every((l) => /^[-•*]\s+/.test(l))) return el('ul', { class: 'pdoc-list' }, lines.map((l) => el('li', {}, l.replace(/^[-•*]\s+/, ''))));
    return el('p', {}, lines.flatMap((l, i) => (i ? [el('br'), l] : [l])));
  });
}

/* ============================================================ the document */
function docSections(p, settings) {
  const t = proposalTotals(p, settings);
  const roi = p.roi || {};
  const r = roi.include ? roiCompute(roi.inputs, t) : null;
  const scope = (Array.isArray(p.scope) ? p.scope : []).filter((s) => (s.title || '').trim() || (s.detail || '').trim());
  const items = (Array.isArray(p.line_items) ? p.line_items : []).filter((i) => (i.label || '').trim() || n(i.amount));
  return { t, r, roi, scope, items };
}

export function renderDoc(p, settings = state.settings || {}) {
  const { t, r, roi, scope, items } = docSections(p, settings);
  const biz = businessOf(p);
  const first = firstName(p.recipient_name);
  const bizName = (settings.business_name || 'Wise AI').trim();
  const dateStr = longDate(p.sent_on || today());
  const secs = [];
  const sec = (key, title, ...body) => secs.push({ key, title, body });

  if ((p.problem || '').trim() || r) {
    sec('problem', 'What it is costing you now',
      paras(p.problem),
      r ? el('div', { class: 'pdoc-figures' },
        el('div', {}, el('b', {}, fmt1(r.missedPerMonth)), el('span', {}, 'enquiries a month missed or answered late')),
        el('div', {}, el('b', {}, money(r.revMonth)), el('span', {}, 'of work a month that goes elsewhere')),
        el('div', {}, el('b', {}, money(r.adminMonth)), el('span', {}, 'a month of time on admin'))) : null);
  }
  if ((p.solution || '').trim()) sec('solution', 'What I will build', paras(p.solution));
  if (scope.length) {
    sec('scope', 'What is included', el('ol', { class: 'pdoc-scope' }, scope.map((s) => el('li', {},
      el('b', {}, s.title || ''), s.detail ? el('span', {}, s.detail) : null))));
  }
  if (r) {
    sec('roi', 'What it is worth to you',
      el('p', {}, 'Worked out from the numbers you gave me. If only half of the missed work and admin time is fixed, this is what it is worth:'),
      el('table', { class: 'pdoc-working' }, el('tbody', {}, roiWorking(roi.inputs, r).map(([k, eq, v]) => el('tr', {},
        el('th', { scope: 'row' }, k, el('span', {}, `= ${eq}`)), el('td', {}, v))))),
      r.paybackMonths !== null
        ? el('p', { class: 'pdoc-key' }, `On those numbers it pays for itself in about ${fmt1(r.paybackMonths)} month${Math.round(r.paybackMonths * 10) === 10 ? '' : 's'}`,
          r.firstYearNet > 0 ? `, and the first year is about ${money(r.firstYearNet)} ahead after paying for it.` : '.')
        : null,
      el('p', { class: 'pdoc-note' }, 'These are estimates from your own figures, not a promise. We measure the real numbers once it is running.'));
  }
  sec('investment', 'Investment',
    items.length ? el('table', { class: 'pdoc-invest' },
      el('tbody', {}, items.map((i) => el('tr', {},
        el('th', { scope: 'row' }, i.label || 'Item'),
        el('td', { class: 'pdoc-kind' }, i.recurring ? 'Monthly' : 'One-off'),
        el('td', {}, i.recurring ? `${money(i.amount)}/mo` : money(i.amount))))),
      el('tfoot', {},
        t.oneOff ? el('tr', {}, el('th', { scope: 'row' }, 'One-off total'), el('td', {}), el('td', {}, money(t.oneOff))) : null,
        t.monthly ? el('tr', {}, el('th', { scope: 'row' }, 'Monthly total'), el('td', {}), el('td', {}, `${money(t.monthly)}/mo`)) : null,
        t.gst && t.oneOff ? el('tr', { class: 'is-gst' }, el('th', { scope: 'row' }, 'GST (10%) on the one-off'), el('td', {}), el('td', {}, money(t.gstOneOff))) : null,
        t.gst && t.monthly ? el('tr', { class: 'is-gst' }, el('th', { scope: 'row' }, 'GST (10%) each month'), el('td', {}), el('td', {}, `${money(t.gstMonthly)}/mo`)) : null,
        t.gst ? el('tr', { class: 'is-total' }, el('th', { scope: 'row' }, 'Total including GST'), el('td', {}),
          el('td', {}, [t.oneOff ? money(t.oneOffInc) : null, t.monthly ? `${money(t.monthlyInc)}/mo` : null].filter(Boolean).join(' + '))) : null))
      : el('p', { class: 'pdoc-note' }, 'Pricing to follow.'),
    items.length && t.oneOff && t.monthly ? el('p', { class: 'pdoc-note' }, `First year: ${money(t.oneOff)} + ${money(t.monthly)} × 12 = ${money(t.firstYear)}${t.gst ? ' before GST' : ''}.`) : null,
    items.length && !t.gst ? el('p', { class: 'pdoc-note' }, `No GST applies: ${bizName} is not registered for GST.`) : null);
  if ((p.terms || '').trim()) sec('terms', 'Terms', paras(p.terms));
  sec('next', 'Next step',
    el('p', {}, `To go ahead, reply to this email or give me a call${p.valid_until ? ` before ${longDate(p.valid_until)}` : ''}, and we will lock in a start date.`),
    settings.booking_url ? el('p', {}, 'If you would rather talk it through first, book a time: ', el('span', { class: 'pdoc-url' }, settings.booking_url)) : null,
    el('div', { class: 'pdoc-sign' },
      el('p', { class: 'pdoc-sign-name' }, 'Tyler'),
      el('p', {}, bizName),
      el('p', {}, 'tyler@wise-ai.au'),
      settings.abn ? el('p', {}, `ABN ${settings.abn}`) : null));

  return el('article', { class: 'pdoc', 'aria-label': 'Proposal preview' },
    el('header', { class: 'pdoc-head' },
      el('img', { class: 'pdoc-logo', src: '../logo.svg', alt: bizName }),
      el('dl', { class: 'pdoc-meta' },
        el('div', {}, el('dt', {}, 'Proposal'), el('dd', {}, p.number || '—')),
        el('div', {}, el('dt', {}, 'Date'), el('dd', {}, dateStr)),
        p.valid_until ? el('div', {}, el('dt', {}, 'Valid until'), el('dd', {}, longDate(p.valid_until))) : null)),
    el('div', { class: 'pdoc-title' },
      el('p', { class: 'pdoc-eyebrow' }, 'Proposal for'),
      el('h1', {}, biz),
      (p.title || '').trim() ? el('p', { class: 'pdoc-sub' }, p.title) : null,
      p.recipient_name ? el('p', { class: 'pdoc-for' }, `Prepared for ${p.recipient_name}${p.recipient_business ? `, ${p.recipient_business}` : ''}`) : null),
    el('div', { class: 'pdoc-intro' },
      el('p', {}, first ? `Hi ${first},` : 'Hi,'),
      el('p', {}, `Thanks for the time. Below is what I would build for ${biz}, what it costs, and what it should be worth to you. It is written from what you told me, so if anything is off, tell me and I will fix it.`)),
    secs.map((s, i) => el('section', { class: `pdoc-sec pdoc-${s.key}` },
      el('h2', {}, el('span', { class: 'pdoc-n' }, String(i + 1).padStart(2, '0')), s.title),
      el('div', { class: 'pdoc-body' }, s.body))));
}

/** Plain text for an email body. */
export function proposalText(p, settings = state.settings || {}) {
  const { t, r, roi, scope, items } = docSections(p, settings);
  const biz = businessOf(p);
  const first = firstName(p.recipient_name);
  const bizName = (settings.business_name || 'Wise AI').trim();
  const out = [];
  const head = (s) => { out.push('', s.toUpperCase(), ''); };
  out.push(`Proposal for ${biz}${p.title ? `: ${p.title}` : ''}`);
  out.push([p.number, longDate(p.sent_on || today()), p.valid_until ? `valid until ${longDate(p.valid_until)}` : null].filter(Boolean).join(' · '));
  out.push('', first ? `Hi ${first},` : 'Hi,', '', `Thanks for the time. Below is what I would build for ${biz}, what it costs, and what it should be worth to you. It is written from what you told me, so if anything is off, tell me and I will fix it.`);
  if ((p.problem || '').trim() || r) {
    head('What it is costing you now');
    if ((p.problem || '').trim()) out.push(p.problem.trim());
    if (r) out.push(`${(p.problem || '').trim() ? '\n' : ''}In your numbers: about ${fmt1(r.missedPerMonth)} enquiries a month missed or late, ${money(r.revMonth)} of work a month going elsewhere, and ${money(r.adminMonth)} a month of admin time.`);
  }
  if ((p.solution || '').trim()) { head('What I will build'); out.push(p.solution.trim()); }
  if (scope.length) { head('What is included'); scope.forEach((s, i) => out.push(`${i + 1}. ${s.title || ''}${s.detail ? ` - ${s.detail}` : ''}`)); }
  if (r) {
    head('What it is worth to you');
    roiWorking(roi.inputs, r).forEach(([k, eq, v]) => out.push(`${k}: ${v} (${eq})`));
    out.push('', 'These are estimates from your own figures, not a promise. We measure the real numbers once it is running.');
  }
  head('Investment');
  if (!items.length) out.push('Pricing to follow.');
  items.forEach((i) => out.push(`${i.label || 'Item'}: ${i.recurring ? `${money(i.amount)}/mo` : `${money(i.amount)} one-off`}`));
  if (items.length) {
    if (t.oneOff) out.push(`One-off total: ${money(t.oneOff)}`);
    if (t.monthly) out.push(`Monthly total: ${money(t.monthly)}/mo`);
    if (t.gst) out.push(`GST (10%): ${[t.oneOff ? money(t.gstOneOff) : null, t.monthly ? `${money(t.gstMonthly)}/mo` : null].filter(Boolean).join(' + ')}`,
      `Total including GST: ${[t.oneOff ? money(t.oneOffInc) : null, t.monthly ? `${money(t.monthlyInc)}/mo` : null].filter(Boolean).join(' + ')}`);
    else out.push(`No GST applies: ${bizName} is not registered for GST.`);
  }
  if ((p.terms || '').trim()) { head('Terms'); out.push(p.terms.trim()); }
  head('Next step');
  out.push(`To go ahead, reply to this email or give me a call${p.valid_until ? ` before ${longDate(p.valid_until)}` : ''}, and we will lock in a start date.`);
  if (settings.booking_url) out.push(`If you would rather talk it through first, book a time: ${settings.booking_url}`);
  out.push('', 'Tyler', bizName, 'tyler@wise-ai.au');
  if (settings.abn) out.push(`ABN ${settings.abn}`);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ================================================================== view */
const ui = { status: 'all' };

export default function proposalsView(ctx) {
  const { param } = ctx;
  if (param && param !== 'new') return editorView(param);
  const root = listView();
  if (param === 'new') { history.replaceState(null, '', '#proposals'); setTimeout(() => openNewProposal(), 0); }
  return root;
}

export async function openNewProposal() {
  const open = state.deals.filter((d) => !d.archived && !['won', 'lost'].includes(d.stage));
  const dealSel = select('deal_id', [{ id: '', label: 'No deal: start blank' }, ...open.map((d) => ({ id: d.id, label: d.title }))], open[0]?.id || '');
  const titleIn = input('title', { placeholder: 'e.g. Missed-call text-back and booking flow', maxlength: 140 });
  const values = await modal({
    title: 'New proposal', confirmLabel: 'Start writing',
    body: [field('From a deal', dealSel, 'The recipient, their problem and the prices carry across.'), field('Title', titleIn, 'Leave blank to use the deal name.')]
  });
  if (!values) return null;
  try {
    const deal = values.deal_id ? rowById('deals', values.deal_id) : null;
    let p;
    if (deal) {
      p = await createProposalFromDeal(deal);
      if (values.title?.trim()) p = await saveRow('proposals', { id: p.id, title: values.title.trim() });
    } else {
      p = await createBlank(values.title?.trim() || 'Untitled proposal');
    }
    go(`proposals/${p.id}`);
    return p;
  } catch (e) { toast(e.message, 'bad'); return null; }
}

/* ----------------------------------------------------------------- list */
function listView() {
  const root = el('div', { class: 'page sell-page prop-list-page' });
  root.append(el('div', { class: 'page-head' },
    el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, 'Sell'), el('h1', { class: 'h1' }, 'Proposals')),
    el('div', { class: 'row' },
      el('a', { class: 'btn btn-ghost', href: '#pipeline' }, icon('tag', 16), 'Pipeline'),
      el('button', { type: 'button', class: 'btn btn-primary', onClick: () => openNewProposal() }, icon('plus', 16), 'New proposal'))));
  const kpis = el('div');
  const chips = el('div', { class: 'leads-chips', role: 'group', 'aria-label': 'Filter by status' });
  const content = el('div');
  root.append(kpis, chips, content);

  function paint() {
    const all = state.proposals;
    const live = all.filter((p) => !p.archived);
    clear(content);
    if (!live.length && ui.status !== 'archived') {
      clear(kpis); clear(chips);
      content.append(emptyState({
        icon: 'book', title: 'No proposals yet',
        text: 'Start one from a deal so the recipient, their problem and the prices carry across, then shape it into a letter worth sending.',
        action: el('div', { class: 'row' },
          el('button', { type: 'button', class: 'btn btn-primary', onClick: () => openNewProposal() }, icon('plus', 16), 'New proposal'),
          el('a', { class: 'btn btn-ghost', href: '#pipeline' }, 'Open the pipeline'))
      }));
      return;
    }
    const st = (p) => effectiveStatus(p);
    const year = today().slice(0, 4);
    const waiting = live.filter((p) => st(p) === 'sent');
    const accYear = live.filter((p) => p.status === 'accepted' && String(p.decided_on || '').startsWith(year));
    const acc = all.filter((p) => p.status === 'accepted').length;
    const dec = all.filter((p) => p.status === 'declined').length;
    const sumT = (list) => list.reduce((a, p) => { const t = proposalTotals(p); return { oneOff: a.oneOff + t.oneOff, monthly: a.monthly + t.monthly }; }, { oneOff: 0, monthly: 0 });
    const vText = (v) => [v.oneOff ? money(v.oneOff) : null, v.monthly ? `${money(v.monthly)}/mo` : null].filter(Boolean).join(' + ') || 'no prices yet';
    const cell = (label, value, sub, k) => el('div', { class: 'sell-kpi', dataset: { k } }, el('p', { class: 'kpi-label' }, label), el('div', { class: 'kpi-value' }, value), el('div', { class: 'kpi-sub' }, sub));
    fill(kpis, el('div', { class: 'sell-kpis', role: 'group', 'aria-label': 'Proposal numbers' },
      cell('Drafts', num(live.filter((p) => p.status === 'draft').length), 'being written', 'drafts'),
      cell('Waiting on a decision', num(waiting.length), waiting.length ? vText(sumT(waiting)) : 'none out', 'waiting'),
      cell(`Accepted in ${year}`, num(accYear.length), accYear.length ? vText(sumT(accYear)) : 'none yet', 'accepted'),
      acc + dec ? cell('Acceptance rate', `${Math.round((acc / (acc + dec)) * 100)}%`, `${acc} of ${acc + dec} decided`, 'rate') : null));

    const count = (id) => live.filter((p) => st(p) === id).length;
    const chip = (id, label, nn) => el('button', { type: 'button', class: `chip${ui.status === id ? ' is-active' : ''}`, 'aria-pressed': String(ui.status === id), onClick: () => { ui.status = id; paint(); } },
      label, nn !== undefined ? el('span', { class: 'count' }, num(nn)) : null);
    const archivedN = all.length - live.length;
    fill(chips, chip('all', 'All', live.length),
      PROPOSAL_STATUSES.map((s) => (count(s.id) || ui.status === s.id ? chip(s.id, s.label, count(s.id)) : null)),
      archivedN ? chip('archived', 'Archived', archivedN) : null);

    const list = ui.status === 'archived' ? all.filter((p) => p.archived) : ui.status === 'all' ? live : live.filter((p) => st(p) === ui.status);
    if (!list.length) { content.append(emptyState({ icon: 'search', title: 'Nothing here', text: 'No proposals with that status.' })); return; }
    const recip = (p) => [p.recipient_name, p.recipient_business].filter(Boolean).join(', ');
    const sBadge = (p) => { const s = PROPOSAL_STATUS[st(p)]; return badge(s.label, s.tone); };
    const table = el('table', { class: 'table prop-table' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Number'), el('th', {}, 'Proposal'), el('th', {}, 'Recipient'),
        el('th', { class: 'num' }, 'One-off'), el('th', { class: 'num' }, '$/mo'), el('th', {}, 'Status'), el('th', {}, 'Valid until'), el('th', {}, 'Sent'))),
      el('tbody', {}, list.map((p) => {
        const t = proposalTotals(p);
        return el('tr', { class: 'is-click', dataset: { id: p.id }, onClick: () => go(`proposals/${p.id}`) },
          el('td', { class: 'nowrap tnum' }, p.number || el('span', { class: 'faint' }, '—')),
          el('td', {}, el('a', { class: 'prop-title-link', href: `#proposals/${p.id}`, onClick: (e) => e.stopPropagation() }, p.title)),
          el('td', { class: 'small' }, recip(p) || el('span', { class: 'faint' }, '—')),
          el('td', { class: 'num' }, t.oneOff ? money(t.oneOff) : el('span', { class: 'faint' }, '—')),
          el('td', { class: 'num' }, t.monthly ? money(t.monthly) : el('span', { class: 'faint' }, '—')),
          el('td', {}, sBadge(p)),
          el('td', { class: `small nowrap${st(p) === 'expired' ? ' is-amber' : ''}` }, shortDate(p.valid_until) || '—'),
          el('td', { class: 'small nowrap muted' }, shortDate(p.sent_on) || '—'));
      })));
    const cards = el('div', { class: 'prop-cards' }, list.map((p) => {
      const t = proposalTotals(p);
      return el('a', { class: 'prop-card', href: `#proposals/${p.id}` },
        el('span', { class: 'prop-card-top' }, el('span', { class: 'tnum muted small' }, p.number || ''), sBadge(p)),
        el('b', {}, p.title),
        el('span', { class: 'small muted' }, [recip(p), [t.oneOff ? money(t.oneOff) : null, t.monthly ? `${money(t.monthly)}/mo` : null].filter(Boolean).join(' + ')].filter(Boolean).join(' · ')));
    }));
    content.append(el('div', { class: 'table-wrap prop-table-wrap' }, table), cards);
  }
  paint();
  root.onState = paint;
  return root;
}

/* --------------------------------------------------------------- editor */
const EDIT_FIELDS = ['number', 'title', 'recipient_name', 'recipient_business', 'problem', 'solution', 'scope', 'line_items', 'roi', 'terms', 'valid_until', 'deal_id', 'client_id', 'lead_id'];

function editorView(id) {
  const root = el('div', { class: 'page sell-page prop-edit-page' });
  const row0 = rowById('proposals', id);
  if (!row0) {
    root.append(emptyState({ icon: 'book', title: 'Proposal not found', text: 'It may have been deleted.', action: el('a', { class: 'btn btn-ghost', href: '#proposals' }, 'All proposals') }));
    root.onState = () => { if (rowById('proposals', id)) go(`proposals/${id}`); };
    return root;
  }
  // The editor's own copy. Live updates never overwrite it.
  const doc = JSON.parse(JSON.stringify(row0));
  doc.scope = Array.isArray(doc.scope) ? doc.scope : [];
  doc.line_items = Array.isArray(doc.line_items) ? doc.line_items : [];
  doc.roi = doc.roi && typeof doc.roi === 'object' ? doc.roi : {};
  doc.roi.inputs = { ...ROI_DEFAULTS, ...(doc.roi.inputs || {}) };

  /* ------------------------------------------------- autosave */
  const saved = el('span', { class: 'prop-saved', role: 'status', 'aria-live': 'polite' });
  let timer = null; let saving = null; let dirty = false; let deleting = false; let lastSavedAt = row0.updated_at;
  const showSaved = (mode, msg) => {
    saved.dataset.state = mode;
    fill(saved, mode === 'error' ? icon('alert', 13) : mode === 'saved' ? icon('check', 13) : null,
      msg, mode === 'error' ? el('button', { type: 'button', class: 'link-btn', onClick: () => flush() }, 'Retry') : null);
  };
  showSaved('saved', `Saved ${timeOnly(lastSavedAt)}`);
  const payload = () => {
    const out = {};
    for (const k of EDIT_FIELDS) out[k] = doc[k];
    out.line_items = doc.line_items.map((i) => ({ label: i.label || '', amount: n(i.amount), recurring: Boolean(i.recurring) }));
    out.scope = doc.scope.map((s) => ({ title: s.title || '', detail: s.detail || '' }));
    const t = proposalTotals(doc);
    out.roi = { include: Boolean(doc.roi.include), inputs: doc.roi.inputs, results: roiCompute(doc.roi.inputs, t) };
    for (const k of ['number', 'recipient_name', 'recipient_business', 'valid_until', 'deal_id', 'client_id', 'lead_id']) out[k] = (out[k] || '').toString().trim() || null;
    out.title = (doc.title || '').trim() || 'Untitled proposal';
    return out;
  };
  async function flush() {
    clearTimeout(timer); timer = null;
    if (saving) { await saving; if (!dirty) return; }
    if (!dirty) return;
    dirty = false;
    showSaved('saving', 'Saving…');
    saving = (async () => {
      try {
        const r = await saveRow('proposals', { id, ...payload() });
        lastSavedAt = r.updated_at;
        if (!dirty) showSaved('saved', `Saved ${timeOnly(lastSavedAt)}`);
      } catch (e) {
        dirty = true;
        showSaved('error', `Not saved: ${e.message}`);
      } finally { saving = null; }
    })();
    await saving;
    if (dirty && !timer && saved.dataset.state !== 'error') await flush();
  }
  const changed = () => {
    drawChecks();
    dirty = true;
    showSaved('dirty', 'Unsaved changes');
    clearTimeout(timer);
    timer = setTimeout(flush, 700);
    schedulePreview();
  };
  const onUnload = (e) => { if (dirty || saving) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onUnload);
  const onHash = () => {
    if (location.hash === `#proposals/${id}`) return;
    window.removeEventListener('hashchange', onHash);
    window.removeEventListener('beforeunload', onUnload);
    if (dirty) flush();
  };
  window.addEventListener('hashchange', onHash);

  /* ------------------------------------------------- inputs */
  const bindText = (key, node) => { node.addEventListener('input', () => { doc[key] = node.value; changed(); }); return node; };
  const txt = (key, opts = {}) => bindText(key, input(key, { value: doc[key] || '', ...opts }));
  const area = (key, placeholder, rows = 5) => { const t = textarea(key, doc[key] || '', placeholder); t.rows = rows; return bindText(key, t); };

  const numberIn = txt('number', { maxlength: 40, placeholder: suggestNumber() });
  const titleIn = txt('title', { maxlength: 140, placeholder: 'e.g. Missed-call text-back and online booking' });
  const nameIn = txt('recipient_name', { maxlength: 120, placeholder: 'Dave Smith' });
  const bizIn = txt('recipient_business', { maxlength: 140, placeholder: 'Smith Plumbing' });
  const validIn = txt('valid_until', { type: 'date' });
  const dealOpts = [{ id: '', label: 'No deal' }, ...state.deals.filter((d) => !d.archived || d.id === doc.deal_id).map((d) => ({ id: d.id, label: d.title }))];
  const dealSel = select('deal_id', dealOpts, doc.deal_id || '');
  dealSel.addEventListener('change', () => {
    const d = rowById('deals', dealSel.value);
    doc.deal_id = d?.id || null;
    if (d) {
      doc.client_id = d.client_id || doc.client_id || null;
      doc.lead_id = d.lead_id || doc.lead_id || null;
      fillRecipient();
    }
    changed();
  });
  function fillRecipient() {
    const c = doc.client_id ? rowById('clients', doc.client_id) : null;
    const l = doc.lead_id ? leadById(doc.lead_id) : null;
    const nm = c?.contact_name || l?.contact_name || '';
    const bz = c?.name || l?.business || '';
    let did = false;
    if (!nameIn.value.trim() && nm) { nameIn.value = nm; doc.recipient_name = nm; did = true; }
    if (!bizIn.value.trim() && bz) { bizIn.value = bz; doc.recipient_business = bz; did = true; }
    return did;
  }
  const linkInfo = el('p', { class: 'field-hint prop-links' });
  const drawLinks = () => {
    const c = doc.client_id ? rowById('clients', doc.client_id) : null;
    const l = doc.lead_id ? leadById(doc.lead_id) : null;
    const d = doc.deal_id ? rowById('deals', doc.deal_id) : null;
    fill(linkInfo, [
      d ? el('a', { href: `#pipeline/${d.id}` }, `Deal: ${d.title}`) : null,
      c ? el('a', { href: `#clients/${c.id}` }, `Client: ${c.name}`) : null,
      l ? el('a', { href: `#leads/${l.id}` }, `Lead: ${leadName(l)}`) : null
    ].filter(Boolean).flatMap((x, i) => (i ? [' · ', x] : [x])));
  };

  const problemIn = area('problem', 'In their words: what is going wrong and what it costs. e.g. Calls come in while Dave is on the tools and about one in five never gets a call back.', 6);
  const solutionIn = area('solution', 'What you will set up, in plain words. Start a line with "- " for a list.', 6);
  const termsIn = area('terms', 'Payment, notice, ownership', 6);

  /* scope list */
  const scopeBox = el('div', { class: 'prop-rows' });
  const moveBtns = (list, i, redraw) => [
    el('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Move up', disabled: i === 0 || null, onClick: () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; changed(); redraw(i - 1); } }, el('span', { class: 'prop-rot-up' }, icon('chevron', 14))),
    el('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Move down', disabled: i === list.length - 1 || null, onClick: () => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; changed(); redraw(i + 1); } }, el('span', { class: 'prop-rot-down' }, icon('chevron', 14))),
    el('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Remove', onClick: () => { list.splice(i, 1); changed(); redraw(); } }, icon('x', 14))
  ];
  function drawScope(focusIdx) {
    fill(scopeBox, doc.scope.length ? doc.scope.map((s, i) => {
      const t = input(`scope-title-${i}`, { value: s.title || '', placeholder: 'e.g. Missed-call text-back', 'aria-label': `Scope item ${i + 1} title` });
      const dd = textarea(`scope-detail-${i}`, s.detail || '', 'One or two lines on what it does for them');
      dd.rows = 2; dd.setAttribute('aria-label', `Scope item ${i + 1} detail`);
      t.addEventListener('input', () => { s.title = t.value; changed(); });
      dd.addEventListener('input', () => { s.detail = dd.value; changed(); });
      return el('div', { class: 'prop-row prop-scope-row', dataset: { i } }, el('span', { class: 'prop-row-n' }, String(i + 1).padStart(2, '0')),
        el('div', { class: 'stack tight prop-row-main' }, t, dd), el('div', { class: 'prop-row-acts' }, moveBtns(doc.scope, i, drawScope)));
    }) : el('p', { class: 'small muted' }, 'Nothing yet. List each part they get, so there are no surprises.'));
    if (focusIdx !== undefined) scopeBox.querySelectorAll('.prop-scope-row input')[focusIdx]?.focus();
  }
  const addScope = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => { doc.scope.push({ title: '', detail: '' }); changed(); drawScope(doc.scope.length - 1); } }, icon('plus', 13), 'Add scope item');

  /* line items */
  const itemsBox = el('div', { class: 'prop-rows' });
  const totalsBox = el('div', { class: 'prop-totals tnum' });
  function drawTotals() {
    const t = proposalTotals(doc);
    fill(totalsBox,
      el('span', {}, 'One-off ', el('b', {}, money(t.oneOff))),
      el('span', {}, 'Monthly ', el('b', {}, `${money(t.monthly)}/mo`)),
      t.gst ? el('span', { class: 'muted' }, `Incl. GST ${[money(t.oneOffInc), `${money(t.monthlyInc)}/mo`].join(' + ')}`) : el('span', { class: 'muted' }, 'No GST (not registered)'));
  }
  function drawItems(focusIdx) {
    fill(itemsBox, doc.line_items.length ? doc.line_items.map((it, i) => {
      const lab = input(`item-label-${i}`, { value: it.label || '', placeholder: 'e.g. Build and set-up', 'aria-label': `Line ${i + 1} label` });
      const amt = input(`item-amount-${i}`, { type: 'number', value: n(it.amount) || '', min: 0, step: 50, inputmode: 'decimal', placeholder: '0', 'aria-label': `Line ${i + 1} amount` });
      const kind = select(`item-kind-${i}`, [{ id: 'one', label: 'One-off' }, { id: 'mo', label: 'Monthly' }], it.recurring ? 'mo' : 'one');
      kind.setAttribute('aria-label', `Line ${i + 1} one-off or monthly`);
      lab.addEventListener('input', () => { it.label = lab.value; changed(); });
      amt.addEventListener('input', () => { it.amount = amt.value === '' ? 0 : Math.max(0, n(amt.value)); changed(); drawTotals(); drawRoiOut(); });
      kind.addEventListener('change', () => { it.recurring = kind.value === 'mo'; changed(); drawTotals(); drawRoiOut(); });
      return el('div', { class: 'prop-row prop-item-row', dataset: { i } },
        el('div', { class: 'prop-item-grid' }, lab, el('label', { class: 'prop-amt' }, el('span', { 'aria-hidden': 'true' }, '$'), amt), kind),
        el('div', { class: 'prop-row-acts' }, moveBtns(doc.line_items, i, (f) => { drawItems(f); drawTotals(); drawRoiOut(); })));
    }) : el('p', { class: 'small muted' }, 'Add what it costs: a one-off build, a monthly fee, or both.'));
    if (focusIdx !== undefined) itemsBox.querySelectorAll('.prop-item-row input')[focusIdx]?.focus();
  }
  const addItem = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => { doc.line_items.push({ label: '', amount: 0, recurring: doc.line_items.some((x) => !x.recurring) }); changed(); drawItems(doc.line_items.length - 1); drawTotals(); } }, icon('plus', 13), 'Add line');

  /* ROI */
  const roiOn = el('input', { type: 'checkbox', class: 'check', checked: doc.roi.include || null, id: `roi-on-${id}` });
  const roiInputs = el('div', { class: 'roi-grid prop-roi-grid' }, ROI_FIELDS.map((f) => {
    const x = input(`roi-${f.id}`, { type: 'number', value: doc.roi.inputs[f.id], min: 0, step: f.step, inputmode: 'decimal' });
    x.addEventListener('input', () => { doc.roi.inputs[f.id] = x.value === '' ? 0 : Math.max(0, n(x.value)); changed(); drawRoiOut(); });
    return field(f.label, x);
  }));
  const roiOut = el('div', { class: 'prop-roi-out' });
  function drawRoiOut() {
    const r = roiCompute(doc.roi.inputs, proposalTotals(doc));
    fill(roiOut,
      el('div', { class: 'roi-out' }, el('b', { class: 'tnum' }, `${money(r.halfMonth)}/mo`), el('span', { class: 'small muted' }, 'fixing half of it is worth this')),
      el('ul', { class: 'prop-working' }, roiWorking(doc.roi.inputs, r).map(([k, eq, v]) => el('li', {}, el('span', {}, k, el('span', { class: 'eq' }, ` = ${eq}`)), el('b', { class: 'tnum' }, v)))),
      r.paybackMonths === null ? el('p', { class: 'small muted' }, 'Add prices under Investment to show the payback period.') : null);
    roiInputs.hidden = !doc.roi.include; roiOut.hidden = !doc.roi.include;
  }
  roiOn.addEventListener('change', () => { doc.roi.include = roiOn.checked; changed(); drawRoiOut(); });

  const resetTerms = el('button', { type: 'button', class: 'link-btn small', onClick: () => { termsIn.value = termsDefault(); doc.terms = termsIn.value; changed(); } }, 'Use the standard terms');

  const sec = (eyebrow, title, ...body) => el('section', { class: 'prop-sec' },
    el('div', { class: 'prop-sec-head' }, el('p', { class: 'eyebrow' }, eyebrow), el('h2', { class: 'h3' }, title)), ...body);

  const archiveBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, icon('archive', 13), row0.archived ? 'Restore' : 'Archive');
  archiveBtn.addEventListener('click', () => busy(archiveBtn, async () => {
    const r = rowById('proposals', id);
    try { await flush(); await saveRow('proposals', { id, archived: !r.archived }); toast(r.archived ? 'Restored' : 'Archived'); fill(archiveBtn, icon('archive', 13), r.archived ? 'Archive' : 'Restore'); } catch (e) { toast(e.message, 'bad'); }
  }));
  const delBtn = el('button', {
    type: 'button', class: 'btn btn-ghost btn-sm is-danger', onClick: async () => {
      const ok = await confirmDialog('Delete this proposal?', `${doc.number || ''} ${doc.title || ''} will be deleted. This cannot be undone.`.trim());
      if (!ok) return;
      try { deleting = true; clearTimeout(timer); dirty = false; if (saving) await saving; await deleteRow('proposals', id); toast('Proposal deleted'); go('proposals'); } catch (e) { deleting = false; toast(e.message, 'bad'); }
    }
  }, icon('trash', 13), 'Delete');

  /* AI draft panel */
  const aiNotes = textarea('ai-notes', '', 'What they do, what is going wrong, what they asked for, anything they said about numbers');
  aiNotes.rows = 6;
  const aiPanel = el('section', { class: 'prop-ai', hidden: true, 'aria-label': 'Draft with AI' });
  const aiGo = el('button', { type: 'button', class: 'btn btn-primary btn-sm' }, icon('spark', 13), 'Draft');
  function openAi() {
    if (!aiNotes.value.trim()) {
      const d = doc.deal_id ? rowById('deals', doc.deal_id) : null;
      const l = doc.lead_id ? leadById(doc.lead_id) : (d?.lead_id ? leadById(d.lead_id) : null);
      aiNotes.value = [d?.notes, l?.pain, l?.hook].map((x) => String(x || '').trim()).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join('\n\n');
    }
    aiPanel.hidden = false;
    aiPanel.scrollIntoView({ block: 'nearest' });
    aiNotes.focus();
  }
  aiGo.addEventListener('click', () => busy(aiGo, async () => {
    const notes = aiNotes.value.trim();
    if (!notes) { toast('Add a few notes on the business first', 'warn'); aiNotes.focus(); return; }
    const ctx = { recipient: { name: doc.recipient_name || null, business: doc.recipient_business || null }, notes };
    if (doc.roi.include) ctx.roi = roiCompute(doc.roi.inputs, proposalTotals(doc));
    const res = await ai('proposal', ctx);
    if (!res.ok) { toast(res.message, 'bad'); return; }
    const r = res.result || {};
    const scope = (Array.isArray(r.scope) ? r.scope : []).map((x) => ({ title: String(x?.title || ''), detail: String(x?.detail || '') }));
    const hasText = (doc.problem || '').trim() || (doc.solution || '').trim() || doc.scope.some((x) => (x.title || '').trim() || (x.detail || '').trim());
    if (hasText) {
      const ok = await confirmDialog('Replace what is there?', 'The draft will replace the problem, what you will build and the scope you have written. Terms, prices and ROI stay as they are.', { confirmLabel: 'Replace', danger: false });
      if (!ok) return;
    }
    problemIn.value = String(r.problem || ''); doc.problem = problemIn.value;
    solutionIn.value = String(r.solution || ''); doc.solution = solutionIn.value;
    doc.scope = scope;
    drawScope();
    changed();
    aiPanel.hidden = true;
    const n = checkMarkers(doc).length;
    toast(n ? `Draft in. Read it through and fill the ${n} [check: …] item${n === 1 ? '' : 's'} before sending.` : 'Draft in. Read it through and make it yours before sending.', n ? 'warn' : 'ok');
  }));
  fill(aiPanel,
    el('div', { class: 'prop-sec-head' }, el('p', { class: 'eyebrow' }, 'Draft with AI'), el('h2', { class: 'h3' }, 'Your notes on this business')),
    field('Notes', aiNotes, 'The AI drafts the problem, what you will build and the scope from these. Anything it is unsure of comes back as [check: …] for you to fill.'),
    el('div', { class: 'row' }, aiGo, el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => { aiPanel.hidden = true; } }, 'Cancel')));

  const checksBox = el('div', { class: 'prop-checks', 'aria-live': 'polite' });
  function drawChecks() {
    const n = checkMarkers(doc).length;
    fill(checksBox, n ? el('div', { class: 'callout is-warn' }, icon('alert', 16),
      el('span', {}, `${n} [check: …] item${n === 1 ? '' : 's'} to fill before sending. Replace each one with the real detail.`)) : null);
    [problemIn, solutionIn, termsIn].forEach((t) => t.classList.toggle('has-check', /\[check:/i.test(t.value)));
    scopeBox.querySelectorAll('input, textarea').forEach((t) => t.classList.toggle('has-check', /\[check:/i.test(t.value)));
  }

  const editor = el('div', { class: 'prop-editor' },
    aiPanel, checksBox,
    sec('1 · Who it is for', 'Recipient',
      el('div', { class: 'form-grid' },
        el('div', { class: 'full' }, field('From deal', dealSel, null), linkInfo),
        field('Their name', nameIn), field('Business', bizIn),
        el('div', { class: 'full' }, field('Title', titleIn)),
        field('Number', numberIn, `Next free: ${suggestNumber()}`), field('Valid until', validIn))),
    sec('2 · The problem', 'What it is costing them now', field('In their numbers', problemIn, 'Lead with what is in it for them: money, hours, missed work.')),
    sec('3 · The fix', 'What I will build', field('What you will set up', solutionIn)),
    sec('4 · Scope', 'What is included', scopeBox, el('div', { class: 'row' }, addScope)),
    sec('5 · ROI', 'What it is worth to them',
      el('label', { class: 'check-row', for: `roi-on-${id}` }, roiOn, 'Include the worked numbers in the proposal'),
      el('p', { class: 'field-hint' }, 'The same maths as the public calculator at wise-ai.au/roi. Use their figures, not the starting ones.'),
      roiInputs, roiOut),
    sec('6 · Investment', 'Prices', itemsBox, el('div', { class: 'row' }, addItem), totalsBox),
    sec('7 · Terms', 'Terms', field('Terms', termsIn), el('div', {}, resetTerms)),
    el('div', { class: 'prop-danger row' }, archiveBtn, el('span', { class: 'spacer' }), delBtn));

  /* ------------------------------------------------- preview */
  const sheet = el('div', { class: 'prop-sheet' });
  let previewQueued = false;
  function drawPreview() { previewQueued = false; fill(sheet, renderDoc(doc)); }
  function schedulePreview() { if (previewQueued) return; previewQueued = true; requestAnimationFrame(drawPreview); }
  const preview = el('div', { class: 'prop-preview', 'aria-label': 'Live preview' }, el('p', { class: 'eyebrow prop-preview-label' }, 'Preview: exactly what prints'), sheet);

  /* ------------------------------------------------- top bar + status */
  const top = el('div', { class: 'prop-top' });
  const statusBox = el('div', { class: 'row prop-status' });
  async function setStatus(status) {
    if (status === 'sent') {
      const n = checkMarkers(doc).length;
      if (n) { drawChecks(); toast(`Not sent: ${n} [check: …] item${n === 1 ? ' is' : 's are'} still in the proposal. Fill ${n === 1 ? 'it' : 'them'} in first.`, 'bad'); return; }
    }
    await flush();
    const patch = { id, status };
    if (status === 'sent') { patch.sent_on = doc.sent_on || today(); patch.decided_on = null; }
    if (status === 'accepted' || status === 'declined') patch.decided_on = today();
    if (status === 'draft') { patch.sent_on = null; patch.decided_on = null; }
    try {
      const r = await saveRow('proposals', patch);
      Object.assign(doc, { status: r.status, sent_on: r.sent_on, decided_on: r.decided_on });
      drawTop(); schedulePreview();
      toast(`Marked ${PROPOSAL_STATUS[status].label.toLowerCase()}`);
      if (status === 'accepted') {
        const deal = doc.deal_id ? rowById('deals', doc.deal_id) : null;
        if (deal && deal.stage !== 'won') {
          const ok = await confirmDialog('Move the deal to Won?', `${deal.title} is still in ${deal.stage}. Mark it won, and make the client and project from it.`, { confirmLabel: 'Move to Won', danger: false });
          if (ok) { const pl = await import('./pipeline.js?v=20261118e'); await pl.moveDeal(deal, 'won'); }
        }
      }
    } catch (e) { toast(e.message, 'bad'); }
  }
  function drawTop() {
    const st = effectiveStatus(doc);
    const s = PROPOSAL_STATUS[st];
    const b = (label, status, primary) => el('button', { type: 'button', class: `btn btn-sm ${primary ? 'btn-primary' : 'btn-ghost'}`, dataset: { status }, onClick: (e) => busy(e.currentTarget, () => setStatus(status)) }, label);
    fill(statusBox,
      badge(s.label, s.tone),
      doc.sent_on && st !== 'draft' ? el('span', { class: 'small muted' }, `sent ${shortDate(doc.sent_on)}`) : null,
      doc.decided_on && (st === 'accepted' || st === 'declined') ? el('span', { class: 'small muted' }, `decided ${shortDate(doc.decided_on)}`) : null,
      st === 'expired' ? el('span', { class: 'small is-amber' }, 'past its valid-until date') : null);
    fill(top,
      el('a', { class: 'prop-back', href: '#proposals' }, el('span', { class: 'prop-rot-back' }, icon('chevron', 14)), 'Proposals'),
      el('div', { class: 'prop-top-main' },
        el('div', { class: 'stack tight', style: 'min-width:0' },
          el('p', { class: 'eyebrow' }, doc.number || 'Proposal'),
          el('h1', { class: 'h1 prop-h1' }, (doc.title || '').trim() || 'Untitled proposal')),
        el('div', { class: 'prop-actions' },
          aiReady() ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm prop-ai-btn', onClick: openAi }, icon('spark', 13), 'Draft with AI') : null,
          st === 'draft' ? b('Mark as sent', 'sent', true) : null,
          st === 'sent' || st === 'expired' ? [b('Accepted', 'accepted', true), b('Declined', 'declined'), b('Back to draft', 'draft')] : null,
          st === 'accepted' || st === 'declined' ? b('Reopen', 'sent') : null,
          el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: async () => { await flush(); copyText(proposalText(doc), 'Copied as plain text'); } }, icon('copy', 13), 'Copy as text'),
          el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: async () => { await flush(); drawPreview(); window.print(); } }, icon('download', 13), 'Print or save as PDF'))),
      el('div', { class: 'prop-top-meta' }, statusBox, saved));
  }
  titleIn.addEventListener('input', () => { const h = top.querySelector('.prop-h1'); if (h) h.textContent = titleIn.value.trim() || 'Untitled proposal'; });
  numberIn.addEventListener('input', () => { const e = top.querySelector('.prop-top-main .eyebrow'); if (e) e.textContent = numberIn.value || 'Proposal'; });

  root.append(top, el('div', { class: 'prop-split' }, editor, preview));
  drawTop(); drawLinks(); drawScope(); drawItems(); drawTotals(); drawRoiOut(); drawPreview();
  if (fillRecipient()) changed();
  drawChecks();
  let aiShown = aiReady();

  root.onState = () => {
    const r = rowById('proposals', id);
    if (!r) { if (deleting || !saved.isConnected) return; toast('This proposal was deleted', 'warn'); go('proposals'); return; }
    if (r.status !== doc.status || r.sent_on !== doc.sent_on || r.decided_on !== doc.decided_on) {
      Object.assign(doc, { status: r.status, sent_on: r.sent_on, decided_on: r.decided_on });
      drawTop();
      schedulePreview();
    } else if (aiReady() !== aiShown) drawTop();
    aiShown = aiReady();
    if (!aiShown) aiPanel.hidden = true;
    drawLinks();
  };
  return root;
}
