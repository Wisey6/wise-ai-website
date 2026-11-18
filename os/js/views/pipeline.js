// Pipeline: deals after a lead is warm. Board by stage (drag, or the stage select in the
// drawer on touch), a table, the numbers that matter, and the deal drawer where the next
// step is first-class. Winning a deal turns it into a client and a project.
import {
  el, fill, clear, icon, badge, toast, modal, confirmDialog, field, input, select, textarea,
  emptyState, money, num, plural, timeAgo, dayKey, go, busy, trapFocus
} from '../ui.js?v=20261118c';
import { state, saveRow, deleteRow, rowById, leadById, leadName, leadToClient, onChange } from '../api.js?v=20261118c';
import { ownerPicker, ownerBadge, saveOwner, meId, ownerFilterSelect, matchesOwner } from '../owners.js?v=20261118c';
import { createProposalFromDeal, proposalTotals, effectiveStatus, PROPOSAL_STATUS } from './proposals.js?v=20261118c';

/* ------------------------------------------------------------- constants */
export const STAGES = [
  { id: 'qualified', label: 'Qualified', tone: 'info', prob: 30 },
  { id: 'proposal', label: 'Proposal', tone: 'violet', prob: 50 },
  { id: 'negotiation', label: 'Negotiation', tone: 'warn', prob: 70 },
  { id: 'won', label: 'Won', tone: 'ok', prob: 100 },
  { id: 'lost', label: 'Lost', tone: 'mute', prob: 0 }
];
export const STAGE = Object.fromEntries(STAGES.map((s) => [s.id, s]));
const OPEN = ['qualified', 'proposal', 'negotiation'];
const isOpen = (d) => OPEN.includes(d.stage);
const MODE_KEY = 'wiseos.pipeline.view';
const ui = {
  mode: (() => { try { return localStorage.getItem(MODE_KEY) || 'board'; } catch { return 'board'; } })(),
  showClosed: false,
  archived: false,
  owner: ''
};

/* --------------------------------------------------------------- helpers */
const n = (v) => Number(v) || 0;
const prob = (d) => Math.min(100, Math.max(0, n(d.probability))) / 100;
export const todayKey = () => dayKey();
export function addDays(ymd, days) {
  const t = Date.parse(`${ymd}T00:00:00Z`) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
/** "12 Dec" (this year) or "12 Dec 2027". Date-only strings are calendar days, no time zone shift. */
export function shortDate(ymd) {
  if (!ymd) return '';
  const d = new Date(`${String(ymd).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = String(ymd).slice(0, 4) === todayKey().slice(0, 4);
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}
function relDay(ymd) {
  if (!ymd) return '';
  const diff = Math.round((Date.parse(`${ymd}T00:00:00Z`) - Date.parse(`${todayKey()}T00:00:00Z`)) / 86400000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff < 0 && diff > -14) return `${-diff} days ago`;
  return shortDate(ymd);
}

/** 'none' (no next step), 'overdue', or null. Only open deals stall. */
export function dealFlag(d, today = todayKey()) {
  if (!isOpen(d)) return null;
  if (!String(d.next_step || '').trim()) return 'none';
  if (d.next_step_on && d.next_step_on < today) return 'overdue';
  return null;
}

/**
 * Header numbers. Weighted value = one-off × probability, plus recurring counted as a year
 * (monthly × 12 × probability). Win rate is all time: won ÷ (won + lost), null with none closed.
 */
export function pipelineStats(deals, today = todayKey()) {
  const live = deals.filter((d) => !d.archived);
  const open = live.filter(isOpen);
  const sum = (list, f) => list.reduce((a, d) => a + f(d), 0);
  const oneOff = sum(open, (d) => n(d.value));
  const monthly = sum(open, (d) => n(d.monthly_value));
  const wOneOff = sum(open, (d) => n(d.value) * prob(d));
  const wMonthly = sum(open, (d) => n(d.monthly_value) * prob(d));
  const month = today.slice(0, 7);
  const wonMonth = deals.filter((d) => d.stage === 'won' && String(d.closed_on || '').startsWith(month));
  const won = deals.filter((d) => d.stage === 'won').length;
  const lost = deals.filter((d) => d.stage === 'lost').length;
  return {
    open: open.length, oneOff, monthly, wOneOff, wMonthly, wRecurringYear: wMonthly * 12,
    weighted: wOneOff + wMonthly * 12,
    wonMonth: wonMonth.length, wonMonthOneOff: sum(wonMonth, (d) => n(d.value)), wonMonthMonthly: sum(wonMonth, (d) => n(d.monthly_value)),
    won, lost, winRate: won + lost ? won / (won + lost) : null,
    stalled: open.filter((d) => dealFlag(d, today)).length
  };
}

/** "$5,000 + $400/mo", "$400/mo", "$5,000" or "No value yet". */
export function dealValue(d) {
  const a = n(d.value); const m = n(d.monthly_value);
  if (a && m) return `${money(a)} + ${money(m)}/mo`;
  if (m) return `${money(m)}/mo`;
  if (a) return money(a);
  return '';
}
const weightedOf = (d) => n(d.value) * prob(d) + n(d.monthly_value) * 12 * prob(d);

/** The record a deal points at: {label, href} for the client, else the lead. */
export function dealLink(d) {
  const c = d.client_id ? rowById('clients', d.client_id) : null;
  if (c) return { label: c.name, href: `#clients/${c.id}`, kind: 'Client' };
  const l = d.lead_id ? leadById(d.lead_id) : null;
  if (l) return { label: leadName(l), href: `#leads/${l.id}`, kind: 'Lead' };
  return null;
}

const stageBadge = (s) => badge(STAGE[s]?.label || s, STAGE[s]?.tone || 'mute');

function nextStepLine(d, { compact = false } = {}) {
  const flag = dealFlag(d);
  if (!isOpen(d)) {
    if (d.stage === 'won') return el('span', { class: 'deal-next' }, `Won ${d.closed_on ? shortDate(d.closed_on) : ''}`.trim());
    return el('span', { class: 'deal-next muted' }, `Lost${d.lost_reason ? `: ${d.lost_reason}` : ''}`);
  }
  if (flag === 'none') return el('span', { class: 'deal-next is-flag' }, icon('alert', 13), 'No next step');
  return el('span', { class: `deal-next${flag === 'overdue' ? ' is-flag' : ''}` },
    icon(flag === 'overdue' ? 'alert' : 'arrow', 13),
    el('span', { class: 'deal-next-text' }, d.next_step),
    d.next_step_on ? el('span', { class: 'deal-next-when' }, compact ? shortDate(d.next_step_on) : relDay(d.next_step_on)) : null);
}

/* ================================================================== view */
export default function pipelineView(ctx) {
  const { param } = ctx;
  const root = el('div', { class: 'page sell-page pipe-page' });

  let deferred = null;
  if (param === 'new') { deferred = () => openNewDeal(); history.replaceState(null, '', '#pipeline'); }
  else if (param && /^[0-9a-f-]{36}$/i.test(param)) deferred = () => openDeal(param);

  const modeTabs = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Layout' });
  const drawTabs = () => fill(modeTabs, ...[['board', 'board', 'Board'], ['table', 'list', 'Table']].map(([id, ic, label]) =>
    el('button', {
      type: 'button', role: 'tab', class: `tab${ui.mode === id ? ' is-active' : ''}`, 'aria-selected': String(ui.mode === id),
      onClick: () => { ui.mode = id; try { localStorage.setItem(MODE_KEY, id); } catch { /* */ } drawTabs(); paint(); }
    }, icon(ic, 14), label)));
  drawTabs();

  const head = el('div', { class: 'page-head' },
    el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, 'Sell'), el('h1', { class: 'h1' }, 'Pipeline')),
    el('div', { class: 'row' },
      el('a', { class: 'btn btn-ghost', href: '#proposals' }, icon('book', 16), 'Proposals'),
      el('button', { type: 'button', class: 'btn btn-primary', onClick: () => openNewDeal() }, icon('plus', 16), 'New deal')));
  const kpis = el('div');
  const bar = el('div', { class: 'pipe-bar' });
  const content = el('div', { class: 'pipe-content' });
  root.append(head, kpis, bar, content);

  function drawKpis(deals) {
    const s = pipelineStats(deals);
    const cell = (label, value, sub, extra) => el('div', { class: 'sell-kpi', dataset: { k: extra } },
      el('p', { class: 'kpi-label' }, label), el('div', { class: 'kpi-value' }, value), sub ? el('div', { class: 'kpi-sub' }, sub) : null);
    fill(kpis, el('div', { class: 'sell-kpis', role: 'group', 'aria-label': 'Pipeline numbers' },
      cell('Open deals', num(s.open), s.stalled ? el('span', { class: 'is-warn' }, `${s.stalled} need a next step`) : s.open ? 'Every one has a next step' : 'Nothing open', 'open'),
      cell('Open value', money(s.oneOff), s.monthly ? `one-off, plus ${money(s.monthly)}/mo` : 'one-off', 'value'),
      cell('Weighted', money(s.weighted), `${money(s.wOneOff)} one-off + ${money(s.wMonthly)}/mo × 12, by probability`, 'weighted'),
      cell('Won this month', num(s.wonMonth), s.wonMonth ? dealValue({ value: s.wonMonthOneOff, monthly_value: s.wonMonthMonthly }) || 'no value set' : 'None yet', 'won'),
      s.winRate === null ? null : cell('Win rate', `${Math.round(s.winRate * 100)}%`, `${s.won} won of ${s.won + s.lost} closed, all time`, 'rate')));
  }

  function drawBar(deals) {
    const live = deals.filter((d) => !d.archived);
    const won = live.filter((d) => d.stage === 'won');
    const lost = live.filter((d) => d.stage === 'lost');
    const archivedN = deals.filter((d) => d.archived).length;
    const sumV = (l) => dealValue({ value: l.reduce((a, d) => a + n(d.value), 0), monthly_value: l.reduce((a, d) => a + n(d.monthly_value), 0) });
    const tally = (stage, list) => {
      const t = el('div', { class: 'pipe-tally-item', dataset: { stage } },
        stageBadge(stage), el('b', { class: 'tnum' }, num(list.length)),
        list.length && stage === 'won' ? el('span', { class: 'muted small tnum' }, sumV(list)) : null);
      dropZone(t, stage);
      return t;
    };
    fill(bar,
      el('div', { class: 'pipe-tally', 'aria-label': 'Closed deals' },
        tally('won', won), tally('lost', lost),
        won.length + lost.length ? el('button', {
          type: 'button', class: 'link-btn small', 'aria-pressed': String(ui.showClosed),
          onClick: () => { ui.showClosed = !ui.showClosed; ui.archived = false; paint(); }
        }, ui.showClosed ? 'Hide won and lost' : 'Show won and lost') : null,
        archivedN ? el('button', {
          type: 'button', class: 'link-btn small', 'aria-pressed': String(ui.archived),
          onClick: () => { ui.archived = !ui.archived; paint(); }
        }, ui.archived ? 'Back to the pipeline' : `Archived (${archivedN})`) : null),
      el('span', { class: 'spacer' }), ownerFilterSelect(ui.owner, (v) => { ui.owner = v; paint(); }, { label: 'Owner' }), modeTabs);
  }

  function paint() {
    const deals = state.deals;
    clear(content);
    if (!deals.some((d) => !d.archived) && !ui.archived) {
      clear(kpis); clear(bar);
      content.append(emptyState({
        icon: 'tag', title: 'No deals yet',
        text: 'A deal starts once a lead is warm: they replied, booked a call or asked what it would cost. Track the value, the odds and the next step here until it is won or lost.',
        action: el('button', { type: 'button', class: 'btn btn-primary', onClick: () => openNewDeal() }, icon('plus', 16), 'Add the first deal')
      }));
      if (deals.length) content.append(el('p', { class: 'small muted', style: 'text-align:center' },
        el('button', { type: 'button', class: 'link-btn', onClick: () => { ui.archived = true; paint(); } }, `See ${plural(deals.length, 'archived deal')}`)));
      return;
    }
    drawKpis(deals);
    drawBar(deals);
    const mineOnly = (list) => list.filter((d) => matchesOwner(ui.owner, d));
    if (ui.archived) { content.append(drawTable(mineOnly(deals.filter((d) => d.archived)), true)); return; }
    const live = mineOnly(deals.filter((d) => !d.archived));
    content.append(ui.mode === 'table' ? drawTable(live.filter((d) => ui.showClosed || isOpen(d))) : drawBoard(live));
  }

  /* ----------------------------------------------------------- board */
  function card(d, { drag = true } = {}) {
    const link = dealLink(d);
    const flag = dealFlag(d);
    const c = el('article', { class: `deal-card${flag ? ' is-flagged' : ''}`, draggable: drag ? 'true' : null, dataset: { id: d.id } },
      el('button', { type: 'button', class: 'deal-open', onClick: () => openDeal(d.id), 'aria-label': `${d.title}. Open deal` }, el('b', {}, d.title)),
      link ? el('a', { class: 'deal-link', href: link.href }, link.label) : null,
      el('div', { class: 'deal-vals tnum' },
        dealValue(d) ? el('span', { class: 'deal-money' }, dealValue(d)) : el('span', { class: 'faint' }, 'No value yet'),
        isOpen(d) ? el('span', { class: 'muted' }, `${n(d.probability)}%`) : null,
        el('span', { class: 'deal-owner' }, ownerBadge(d.owner_id, { size: 'sm' }))),
      nextStepLine(d, { compact: true }),
      d.expected_close && isOpen(d) ? el('span', { class: 'deal-close muted' }, `Expected close ${shortDate(d.expected_close)}`) : null);
    if (drag) {
      c.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', d.id); e.dataTransfer.effectAllowed = 'move'; c.classList.add('is-dragging'); });
      c.addEventListener('dragend', () => c.classList.remove('is-dragging'));
    }
    return c;
  }

  function dropZone(node, stage) {
    node.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; node.classList.add('is-over'); });
    node.addEventListener('dragleave', (e) => { if (!node.contains(e.relatedTarget)) node.classList.remove('is-over'); });
    node.addEventListener('drop', async (e) => {
      e.preventDefault();
      node.classList.remove('is-over');
      const d = rowById('deals', e.dataTransfer.getData('text/plain'));
      if (d && d.stage !== stage) await moveDeal(d, stage);
    });
  }

  function drawBoard(live) {
    const cols = ui.showClosed ? STAGES : STAGES.filter((s) => OPEN.includes(s.id));
    return el('div', { class: `board pipe-board${ui.showClosed ? ' is-wide' : ''}`, 'aria-label': 'Deals by stage' }, cols.map((s) => {
      const items = live.filter((d) => d.stage === s.id)
        .sort((a, b) => String(a.next_step_on || '9').localeCompare(String(b.next_step_on || '9')));
      const total = dealValue({ value: items.reduce((a, d) => a + n(d.value), 0), monthly_value: items.reduce((a, d) => a + n(d.monthly_value), 0) });
      const col = el('section', { class: 'board-col pipe-col', dataset: { stage: s.id }, 'aria-label': `${s.label}: ${items.length}` },
        el('div', { class: 'board-head' }, stageBadge(s.id), el('span', { class: 'count' }, num(items.length))),
        el('div', { class: 'pipe-col-sum tnum' }, total || ' '),
        items.length ? items.map((d) => card(d)) : el('div', { class: 'board-empty' }, 'Drag a deal here'));
      dropZone(col, s.id);
      return col;
    }));
  }

  /* ----------------------------------------------------------- table */
  function drawTable(list, archived = false) {
    if (!list.length) return emptyState({ icon: 'tag', title: archived ? 'Nothing archived' : 'Nothing open', text: archived ? '' : 'Every deal is won or lost. Add the next one when a lead warms up.' });
    const rows = [...list].sort((a, b) => STAGES.findIndex((s) => s.id === a.stage) - STAGES.findIndex((s) => s.id === b.stage) || weightedOf(b) - weightedOf(a));
    const table = el('table', { class: 'table pipe-table' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Deal'), el('th', { class: 'pipe-owner-h' }, 'Owner'), el('th', {}, 'Stage'), el('th', { class: 'num' }, 'One-off'), el('th', { class: 'num' }, '$/mo'),
        el('th', { class: 'num' }, 'Prob.'), el('th', { class: 'num', title: 'One-off plus 12 months, times probability' }, 'Weighted'),
        el('th', {}, 'Next step'), el('th', {}, 'Close'))),
      el('tbody', {}, rows.map((d) => {
        const link = dealLink(d);
        return el('tr', { class: 'is-click', dataset: { id: d.id }, onClick: (e) => { if (!e.target.closest('a')) openDeal(d.id); } },
          el('td', {}, el('div', { class: 'lead-cell' },
            el('button', { type: 'button', class: 'lead-name-btn', onClick: (e) => { e.stopPropagation(); openDeal(d.id); } }, el('b', {}, d.title)),
            link ? el('a', { class: 'deal-link', href: link.href }, link.label) : el('span', {}, ' '))),
          el('td', { class: 'pipe-owner-cell' }, ownerPicker({ value: d.owner_id || null, compact: true, label: `Owner: ${d.title}`, onChange: (oid) => saveOwner('deals', d.id, oid) })),
          el('td', {}, stageBadge(d.stage)),
          el('td', { class: 'num' }, n(d.value) ? money(d.value) : el('span', { class: 'faint' }, '—')),
          el('td', { class: 'num' }, n(d.monthly_value) ? money(d.monthly_value) : el('span', { class: 'faint' }, '—')),
          el('td', { class: 'num' }, isOpen(d) ? `${n(d.probability)}%` : el('span', { class: 'faint' }, '—')),
          el('td', { class: 'num' }, isOpen(d) ? money(weightedOf(d)) : el('span', { class: 'faint' }, '—')),
          el('td', { class: 'pipe-next-cell' }, nextStepLine(d, { compact: true })),
          el('td', { class: 'small nowrap muted' }, isOpen(d) ? shortDate(d.expected_close) || '—' : shortDate(d.closed_on) || '—'));
      })));
    return el('div', {},
      el('div', { class: 'table-wrap pipe-table-wrap' }, table),
      el('div', { class: 'pipe-cards' }, rows.map((d) => card(d, { drag: false }))));
  }

  paint();
  root.onState = paint;
  if (deferred) setTimeout(deferred, 0);
  return root;
}

/* ========================================================= stage changes */

/** Move a deal to a stage. Won and Lost ask first. Resolves the saved row, or null if cancelled. */
export async function moveDeal(deal, stage) {
  if (!deal || deal.stage === stage) return deal;
  if (stage === 'won') return markWon(deal);
  if (stage === 'lost') return markLost(deal);
  const patch = { id: deal.id, stage, closed_on: null, lost_reason: null };
  const wasDefault = !isOpen(deal) || n(deal.probability) === STAGE[deal.stage]?.prob;
  if (wasDefault) patch.probability = STAGE[stage].prob;
  try {
    const row = await saveRow('deals', patch);
    toast(`${deal.title} moved to ${STAGE[stage].label}`);
    return row;
  } catch (e) { toast(e.message, 'bad'); return null; }
}

async function markWon(deal) {
  const hasProject = state.projects.some((p) => p.deal_id === deal.id);
  const lead = deal.lead_id ? leadById(deal.lead_id) : null;
  const needsName = !deal.client_id && !lead;
  const values = await modal({
    title: `Won: ${deal.title}`,
    confirmLabel: 'Mark as won',
    body: [
      field('Closed on', input('closed_on', { type: 'date', value: todayKey(), required: true })),
      !deal.client_id ? el('label', { class: 'check-row' }, input('make_client', { type: 'checkbox', checked: true, value: '1' }),
        lead ? `Make ${leadName(lead)} a client` : 'Make this a client') : null,
      needsName ? field('Client business name', input('client_name', { value: deal.title, maxlength: 120 }), 'Used if you make this a client.') : null,
      !hasProject ? el('label', { class: 'check-row' }, input('start_project', { type: 'checkbox', checked: true, value: '1' }), 'Start a project for it') : null,
      el('p', { class: 'small muted' }, 'A project needs a client, so starting one also makes the client.')
    ]
  });
  if (!values) return null;
  try {
    let row = await saveRow('deals', { id: deal.id, stage: 'won', closed_on: values.closed_on || todayKey(), probability: 100, lost_reason: null });
    toast(`${deal.title} won`);
    if (values.start_project) {
      const p = await startProject(row, { name: values.client_name });
      if (p) go(`projects/${p.id}`);
    } else if (values.make_client) {
      await ensureClient(row, { name: values.client_name });
    }
    row = rowById('deals', deal.id) || row;
    return row;
  } catch (e) { toast(e.message, 'bad'); return null; }
}

async function markLost(deal) {
  const values = await modal({
    title: `Lost: ${deal.title}`,
    confirmLabel: 'Mark as lost',
    danger: false,
    body: [
      field('Why was it lost?', (() => { const t = textarea('lost_reason', '', 'e.g. went with a cheaper quote, timing, no budget this year'); t.required = true; return t; })(),
        'One honest line. It is how you spot a pattern later.'),
      field('Closed on', input('closed_on', { type: 'date', value: todayKey(), required: true }))
    ]
  });
  if (!values) return null;
  const reason = String(values.lost_reason || '').trim();
  if (!reason) { toast('Add a reason so the pattern shows up later', 'warn'); return null; }
  try {
    const row = await saveRow('deals', { id: deal.id, stage: 'lost', lost_reason: reason, closed_on: values.closed_on || todayKey(), probability: 0 });
    toast(`${deal.title} marked lost`);
    return row;
  } catch (e) { toast(e.message, 'bad'); return null; }
}

/** The deal's client: the linked one, one made from its lead, or a new one. Links client_id. */
export async function ensureClient(deal, { name } = {}) {
  const linked = deal.client_id ? rowById('clients', deal.client_id) : null;
  if (linked) return linked;
  const lead = deal.lead_id ? leadById(deal.lead_id) : null;
  let client;
  if (lead) {
    client = await leadToClient(lead);
    const carry = lead.owner_id || deal.owner_id || null;
    if (carry && !client.owner_id) client = await saveRow('clients', { id: client.id, owner_id: carry });
  } else {
    client = await saveRow('clients', {
      name: String(name || deal.title || 'New client').trim(), status: 'active', started_on: todayKey(),
      monthly_value: n(deal.monthly_value), notes: deal.notes || null, owner_id: deal.owner_id || meId()
    });
  }
  if (lead && n(deal.monthly_value) && !n(client.monthly_value)) client = await saveRow('clients', { id: client.id, monthly_value: n(deal.monthly_value) });
  await saveRow('deals', { id: deal.id, client_id: client.id });
  toast(`${client.name} is now a client`);
  return client;
}

/** Create a project for a won deal, linked to its client (made if needed) and the deal. */
export async function startProject(deal, opts = {}) {
  const client = await ensureClient(deal, opts);
  const p = await saveRow('projects', {
    name: deal.title, client_id: client.id, deal_id: deal.id, status: 'planned', owner_id: deal.owner_id || client.owner_id || meId(),
    started_on: todayKey(), value: n(deal.value), description: deal.notes || null
  });
  toast('Project started');
  return p;
}

/** From a deal: create a proposal, move a qualified deal to Proposal, open the editor. */
export async function writeProposal(deal) {
  try {
    const p = await createProposalFromDeal(deal);
    if (deal.stage === 'qualified') await saveRow('deals', { id: deal.id, stage: 'proposal', probability: n(deal.probability) === STAGE.qualified.prob ? STAGE.proposal.prob : n(deal.probability) });
    go(`proposals/${p.id}`);
    return p;
  } catch (e) { toast(e.message, 'bad'); return null; }
}

/* ============================================================== forms */
function leadOptions(current) {
  const warm = new Set(['contacted', 'replied', 'interested', 'booked', 'won']);
  const list = state.leads.filter((l) => (!l.archived && warm.has(l.status)) || l.id === current)
    .sort((a, b) => leadName(a).localeCompare(leadName(b)));
  return [{ id: '', label: 'No lead' }, ...list.map((l) => ({ id: l.id, label: leadName(l) }))];
}
function clientOptions(current) {
  const list = state.clients.filter((c) => !c.archived || c.id === current).sort((a, b) => a.name.localeCompare(b.name));
  return [{ id: '', label: 'Not a client yet' }, ...list.map((c) => ({ id: c.id, label: c.name }))];
}
const moneyInput = (name, value, placeholder) => input(name, { type: 'number', value: n(value) || '', min: 0, step: 50, inputmode: 'decimal', placeholder });

function dealFields(d = {}, { isNew = false } = {}) {
  const lead = select('lead_id', leadOptions(d.lead_id), d.lead_id || '');
  const title = input('title', { value: d.title || '', required: true, maxlength: 140, placeholder: 'e.g. Smith Plumbing: missed-call text-back', autocomplete: 'off' });
  if (isNew) lead.addEventListener('change', () => { if (!title.value.trim() && lead.value) title.value = leadName(leadById(lead.value)); });
  return el('div', { class: 'form-grid' },
    el('div', { class: 'full' }, field('Deal', title)),
    field('Lead', lead, isNew ? 'Warm leads: contacted, replied, interested or booked' : null),
    field('Client', select('client_id', clientOptions(d.client_id), d.client_id || '')),
    field('One-off value ($)', moneyInput('value', d.value, '4500')),
    field('Monthly value ($/mo)', moneyInput('monthly_value', d.monthly_value, '300')),
    field('Probability (%)', input('probability', { type: 'number', value: d.probability ?? STAGE.qualified.prob, min: 0, max: 100, step: 5, inputmode: 'numeric' })),
    field('Expected close', input('expected_close', { type: 'date', value: d.expected_close || '' })),
    isNew ? field('Next step', input('next_step', { value: d.next_step || 'Intro call', maxlength: 160 })) : null,
    isNew ? field('Next step by', input('next_step_on', { type: 'date', value: d.next_step_on || addDays(todayKey(), 2) })) : null,
    isNew ? el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Owner'), ownerPicker({ value: d.owner_id || meId(), name: 'owner_id', label: 'Deal owner' })) : null);
}

function cleanDeal(v) {
  const out = {};
  for (const k of ['title', 'next_step', 'notes', 'lost_reason']) if (k in v) out[k] = String(v[k] || '').trim() || null;
  for (const k of ['lead_id', 'client_id', 'expected_close', 'next_step_on', 'closed_on']) if (k in v) out[k] = v[k] || null;
  for (const k of ['value', 'monthly_value']) if (k in v) out[k] = Math.max(0, n(v[k]));
  if ('probability' in v) out.probability = Math.round(Math.min(100, Math.max(0, n(v.probability))));
  return out;
}

export async function openNewDeal(preset = {}) {
  const values = await modal({ title: 'New deal', body: dealFields(preset, { isNew: true }), confirmLabel: 'Add deal', wide: true });
  if (!values) return null;
  const row = cleanDeal(values);
  if (!row.title) { toast('Give the deal a name', 'bad'); return null; }
  try {
    const saved = await saveRow('deals', { ...row, stage: 'qualified', owner_id: values.owner_id || null });
    toast('Deal added');
    openDeal(saved.id);
    return saved;
  } catch (e) { toast(e.message, 'bad'); return null; }
}

/* ============================================================== drawer */
let openDrawer = null;

export function openDeal(id) {
  if (openDrawer) openDrawer.close(true);
  const d0 = rowById('deals', id);
  if (!d0) { toast('That deal no longer exists', 'warn'); if (location.hash.startsWith('#pipeline/')) history.replaceState(null, '', '#pipeline'); return null; }
  if (location.hash !== `#pipeline/${id}` && location.hash.startsWith('#pipeline')) history.replaceState(null, '', `#pipeline/${id}`);
  const cleanup = [];
  const prevFocus = document.activeElement;
  const titleId = `deal-${id}`;
  const nameH = el('h1', { class: 'h1', id: titleId });
  const eyebrow = el('p', { class: 'eyebrow' });
  const stageSel = select('stage', STAGES.map((s) => ({ id: s.id, label: s.label })), d0.stage);
  stageSel.classList.add('sm');
  stageSel.style.width = 'auto';
  stageSel.setAttribute('aria-label', 'Stage');
  stageSel.addEventListener('change', async () => {
    const d = rowById('deals', id);
    const res = await moveDeal(d, stageSel.value);
    if (!res) stageSel.value = rowById('deals', id)?.stage || d.stage;
  });
  const sub = el('div', { class: 'ld-sub' });
  const actions = el('div', { class: 'ld-actions' });
  const ownerSel = ownerPicker({ value: d0.owner_id || null, label: 'Deal owner', onChange: (oid) => saveOwner('deals', id, oid) });

  const drawHead = () => {
    const d = rowById('deals', id);
    if (!d) return;
    ownerSel.setValue(d.owner_id || null);
    nameH.textContent = d.title;
    if (document.activeElement !== stageSel) stageSel.value = d.stage;
    eyebrow.textContent = `Deal · added ${timeAgo(d.created_at)}${d.archived ? ' · archived' : ''}`;
    const link = dealLink(d);
    const flag = dealFlag(d);
    fill(sub,
      link ? el('span', {}, `${link.kind}: `, el('a', { href: link.href }, link.label)) : el('span', { class: 'faint' }, 'Not linked to a lead or client'),
      dealValue(d) ? el('span', { class: 'tnum' }, dealValue(d)) : null,
      isOpen(d) ? el('span', { class: 'tnum' }, `${n(d.probability)}% likely`) : null,
      flag ? badge(flag === 'none' ? 'No next step' : 'Next step overdue', 'warn') : null);
    const props = state.proposals.filter((p) => p.deal_id === id);
    fill(actions,
      el('button', { type: 'button', class: 'btn btn-primary btn-sm', onClick: (e) => busy(e.currentTarget, () => writeProposal(rowById('deals', id))) }, icon('edit', 14), 'Write proposal'),
      props.length ? el('a', { class: 'btn btn-ghost btn-sm', href: `#proposals/${props[0].id}` }, icon('book', 14), props.length > 1 ? `Latest proposal (${props.length})` : 'Open proposal') : null,
      d.lead_id && leadById(d.lead_id) ? el('a', { class: 'btn btn-ghost btn-sm', href: `#leads/${d.lead_id}` }, icon('leads', 14), 'Lead') : null,
      d.client_id && rowById('clients', d.client_id) ? el('a', { class: 'btn btn-ghost btn-sm', href: `#clients/${d.client_id}` }, icon('user', 14), 'Client') : null);
  };

  /* next step: first-class */
  const nextIn = input('next_step', { value: d0.next_step || '', maxlength: 160, placeholder: 'e.g. Send the proposal, call Dave to walk through it' });
  const nextOn = input('next_step_on', { type: 'date', value: d0.next_step_on || '' });
  const nextWarn = el('div');
  const drawNextWarn = () => {
    const d = rowById('deals', id);
    const flag = d && dealFlag({ ...d, next_step: nextIn.value, next_step_on: nextOn.value || null });
    fill(nextWarn, flag ? el('div', { class: 'callout is-warn' }, icon('alert', 16),
      el('span', {}, flag === 'none' ? 'No next step. Deals without one are the ones that quietly stall.' : 'The next step is overdue. Do it today or set a new date.')) : null);
  };
  [nextIn, nextOn].forEach((x) => x.addEventListener('input', drawNextWarn));
  const quick = (label, days) => el('button', { type: 'button', class: 'chip', onClick: () => { nextOn.value = addDays(todayKey(), days); drawNextWarn(); } }, label);
  const nextSec = el('section', { class: 'ld-section deal-next-sec', 'aria-label': 'Next step' },
    el('div', { class: 'ld-section-head' }, el('div', { class: 'stack tight' }, el('p', { class: 'eyebrow' }, 'What moves it forward'), el('h2', { class: 'h2' }, 'Next step'))),
    nextWarn,
    el('div', { class: 'form-grid' },
      el('div', { class: 'full' }, field('Next step', nextIn)),
      field('By', nextOn),
      el('div', { class: 'field deal-quick' }, el('span', { class: 'field-label' }, 'Quick dates'), el('div', { class: 'row nowrap' }, quick('Tomorrow', 1), quick('In 3 days', 3), quick('Next week', 7)))));

  /* outcome (won / lost) */
  const outcome = el('section', { class: 'ld-section', 'aria-label': 'Outcome' });
  let outcomeStage = null;
  let closedIn = null; let reasonIn = null;
  const drawOutcome = () => {
    const d = rowById('deals', id);
    if (!d) return;
    const proj = state.projects.find((p) => p.deal_id === id);
    const key = `${d.stage}|${d.client_id || ''}|${proj?.id || ''}|${d.closed_on || ''}`;
    if (key === outcomeStage) return;
    outcomeStage = key;
    closedIn = null; reasonIn = null;
    if (isOpen(d)) { clear(outcome); outcome.hidden = true; return; }
    outcome.hidden = false;
    closedIn = input('closed_on', { type: 'date', value: d.closed_on || '' });
    if (d.stage === 'won') {
      fill(outcome,
        el('div', { class: 'ld-section-head' }, el('div', { class: 'stack tight' }, el('p', { class: 'eyebrow' }, 'Outcome'), el('h2', { class: 'h2' }, 'Won'))),
        el('div', { class: 'callout is-ok' }, icon('check', 16), el('span', {}, 'Won. Turn it into a client and a project so delivery starts in the same place.')),
        el('div', { class: 'row' },
          d.client_id ? null : el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: (e) => busy(e.currentTarget, async () => { try { await ensureClient(rowById('deals', id)); } catch (err) { toast(err.message, 'bad'); } }) }, icon('user', 14), 'Make this a client'),
          proj ? el('a', { class: 'btn btn-ghost btn-sm', href: `#projects/${proj.id}` }, icon('deliver', 14), 'Open the project')
            : el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: (e) => busy(e.currentTarget, async () => { try { const p = await startProject(rowById('deals', id)); go(`projects/${p.id}`); } catch (err) { toast(err.message, 'bad'); } }) }, icon('deliver', 14), 'Start a project')),
        el('div', { class: 'form-grid' }, field('Closed on', closedIn)));
    } else {
      reasonIn = textarea('lost_reason', d.lost_reason || '', 'Why it was lost');
      reasonIn.rows = 2;
      fill(outcome,
        el('div', { class: 'ld-section-head' }, el('div', { class: 'stack tight' }, el('p', { class: 'eyebrow' }, 'Outcome'), el('h2', { class: 'h2' }, 'Lost'))),
        el('div', { class: 'form-grid' }, el('div', { class: 'full' }, field('Reason', reasonIn)), field('Closed on', closedIn)));
    }
  };

  /* details */
  const notesIn = textarea('notes', d0.notes || '', 'What they need, who decides, anything said on the call');
  notesIn.rows = 4;
  const detailsForm = el('form', { class: 'stack', novalidate: true }, dealFields(d0), field('Notes', notesIn));
  const details = el('section', { class: 'ld-section', 'aria-label': 'Details' },
    el('div', { class: 'ld-section-head' }, el('h2', { class: 'h2' }, 'Details')), detailsForm);

  /* proposals */
  const propsSec = el('section', { class: 'ld-section', 'aria-label': 'Proposals' });
  const drawProps = () => {
    const props = state.proposals.filter((p) => p.deal_id === id);
    fill(propsSec,
      el('div', { class: 'ld-section-head' }, el('h2', { class: 'h2' }, 'Proposals')),
      props.length ? el('ul', { class: 'deal-props' }, props.map((p) => {
        const t = proposalTotals(p);
        const st = effectiveStatus(p);
        return el('li', {}, el('a', { href: `#proposals/${p.id}` }, el('b', {}, p.number || 'No number'), ' ', p.title),
          el('span', { class: 'muted small tnum' }, dealValue({ value: t.oneOff, monthly_value: t.monthly })),
          badge(PROPOSAL_STATUS[st].label, PROPOSAL_STATUS[st].tone));
      })) : el('p', { class: 'small muted' }, 'None yet. "Write proposal" starts one with this deal\'s numbers filled in.'));
  };

  const saveBtn = el('button', { type: 'button', class: 'btn btn-primary btn-sm' }, 'Save changes');
  const save = () => busy(saveBtn, async () => {
    const v = Object.fromEntries(new FormData(detailsForm));
    v.next_step = nextIn.value; v.next_step_on = nextOn.value; v.notes = notesIn.value;
    if (closedIn) v.closed_on = closedIn.value;
    if (reasonIn) v.lost_reason = reasonIn.value;
    const row = cleanDeal(v);
    if (!row.title) { toast('Give the deal a name', 'bad'); return; }
    try { await saveRow('deals', { id, ...row }); toast('Deal saved'); drawHead(); drawNextWarn(); } catch (e) { toast(e.message, 'bad'); }
  });
  saveBtn.addEventListener('click', save);
  detailsForm.addEventListener('submit', (e) => { e.preventDefault(); save(); });

  const archiveBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm' });
  const drawArchive = () => fill(archiveBtn, icon('archive', 13), rowById('deals', id)?.archived ? 'Restore' : 'Archive');
  archiveBtn.addEventListener('click', () => busy(archiveBtn, async () => {
    const d = rowById('deals', id);
    try { await saveRow('deals', { id, archived: !d.archived }); toast(d.archived ? 'Restored' : 'Archived'); } catch (e) { toast(e.message, 'bad'); }
  }));
  const delBtn = el('button', {
    type: 'button', class: 'btn btn-ghost btn-sm is-danger', onClick: async () => {
      const d = rowById('deals', id);
      const ok = await confirmDialog('Delete this deal?', `${d.title} will be deleted. Proposals and projects made from it stay, unlinked. This cannot be undone.`);
      if (!ok) return;
      try { await deleteRow('deals', id); toast('Deal deleted'); close(); } catch (e) { toast(e.message, 'bad'); }
    }
  }, icon('trash', 13), 'Delete');

  const drawer = el('aside', { class: 'drawer deal-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    el('div', { class: 'drawer-head' },
      el('div', { class: 'ld-title' },
        el('div', { class: 'stack tight', style: 'flex:1;min-width:0' }, eyebrow, nameH),
        el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close deal', onClick: () => close() }, icon('x', 18))),
      el('div', { class: 'row' }, stageSel, ownerSel, sub),
      actions),
    el('div', { class: 'drawer-body' }, nextSec, outcome, details, propsSec),
    el('div', { class: 'drawer-foot' }, saveBtn, archiveBtn, el('span', { class: 'spacer' }), delBtn));
  const backdrop = el('div', { class: 'drawer-backdrop', onClick: () => close() });

  function close(silent) {
    cleanup.forEach((fn) => fn());
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', onHash);
    drawer.classList.add('is-leaving');
    backdrop.remove();
    setTimeout(() => drawer.remove(), 180);
    if (openDrawer && openDrawer.id === id) openDrawer = null;
    if (!silent && location.hash.startsWith('#pipeline/')) history.replaceState(null, '', '#pipeline');
    if (!silent && prevFocus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
  }
  const onKey = (e) => {
    if (document.querySelector('.modal-backdrop')) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Tab') trapFocus(e, drawer);
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); }
  };
  const onHash = () => { if (location.hash !== `#pipeline/${id}`) close(true); };
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', onHash);
  cleanup.push(onChange(() => {
    if (!rowById('deals', id)) { toast('This deal was deleted', 'warn'); close(); return; }
    drawHead(); drawArchive(); drawOutcome(); drawProps();
  }));

  drawHead(); drawArchive(); drawOutcome(); drawProps(); drawNextWarn();
  document.body.append(backdrop, drawer);
  openDrawer = { id, close };
  setTimeout(() => drawer.querySelector('.icon-btn')?.focus({ preventScroll: true }), 40);
  return drawer;
}
