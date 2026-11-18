// Clients: the roster, and a full page per client where the work for them lives.
import {
  el, clear, fill, icon, badge, toast, modal, confirmDialog, field, input, select, textarea, emptyState,
  money, num, plural, go, copyText, busy, prettyPhone
} from '../ui.js?v=20261118c';
import { state, saveRow, deleteRow, rowById, leadById, leadName, normalisePhone } from '../api.js?v=20261118c';
import { today, addDays, fmtDate, keyOf, periodLabel, reportTotals } from './roi-reports.js?v=20261118c';
import {
  taskRow, quickAdd, progressBar, projectProgress, projectBadge, isOpenProject, isOverdue, taskClientId,
  openProjectForm, guardedPaint, keepFocus, sortMyTasks
} from './projects.js?v=20261118c';
import { ownerPicker, ownerBadge, saveOwner, meId, ownerFilterSelect, matchesOwner, ownerName } from '../owners.js?v=20261118c';

/* ============================================================ constants */
export const CLIENT_STATUSES = [
  { id: 'active', label: 'Active', tone: 'ok' },
  { id: 'paused', label: 'Paused', tone: 'warn' },
  { id: 'past', label: 'Past', tone: 'mute' }
];
const CSTATUS = Object.fromEntries(CLIENT_STATUSES.map((s) => [s.id, s]));
const clientBadge = (s) => badge(CSTATUS[s]?.label || s, CSTATUS[s]?.tone || 'mute');
const UUID = /^[0-9a-f-]{36}$/i;
const n = (v) => Number(v) || 0;
const safeHref = (u) => {
  const s = String(u || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/i.test(s)) return `https://${s}`;
  return null;
};
// Contact log lines live at the top of the client's notes: "2026-11-17 · Call: talked through the October numbers"
const LOG_RE = /^(\d{4}-\d{2}-\d{2}) · ([^:]{1,20}): ?(.*)$/;
const CONTACT_KINDS = ['Call', 'Email', 'Meeting', 'Text', 'Visit'];

/* ======================================================= the numbers
   Exported so the tests can check them against hand-worked figures. */

/** Header numbers for the roster. */
export function rosterTotals(clients) {
  const active = clients.filter((c) => !c.archived && c.status === 'active');
  const mrr = active.reduce((s, c) => s + n(c.monthly_value), 0);
  return { active: active.length, mrr, avg: active.length ? mrr / active.length : 0 };
}

export const contactLog = (c) => String(c?.notes || '').split(/\r?\n/).map((l) => LOG_RE.exec(l.trim())).filter(Boolean)
  .map((m) => ({ date: m[1], kind: m[2], text: m[3] }));

/** The facts about one client, from every table. */
export function clientFacts(c, st = state) {
  const t0 = today();
  const income = st.income.filter((i) => i.client_id === c.id);
  const paid = income.filter((i) => i.status === 'paid').reduce((s, i) => s + n(i.amount), 0);
  const unpaidList = income.filter((i) => i.status === 'invoiced');
  const unpaid = unpaidList.reduce((s, i) => s + n(i.amount), 0);
  const overdue = unpaidList.filter((i) => i.due_on && i.due_on < t0).sort((a, b) => a.due_on.localeCompare(b.due_on));
  const projects = st.projects.filter((p) => p.client_id === c.id);
  const openProjects = projects.filter(isOpenProject);
  const openTasks = st.tasks.filter((t) => t.state !== 'done' && taskClientId(t) === c.id);
  const reports = st.roi_reports.filter((r) => r.client_id === c.id);
  const reportDay = (r) => r.sent_on || keyOf(r.created_at);
  const lastReport = reports.map(reportDay).sort().pop() || null;
  const lastSent = reports.filter((r) => r.status === 'sent').map(reportDay).sort().pop() || null;
  const since = keyOf(c.started_on || c.created_at);
  // Last time you were in touch: logged contact, any message or past booking with their lead, a sent report.
  const touches = [...contactLog(c).map((x) => x.date), lastSent];
  if (c.lead_id) {
    for (const m of st.messages) if (m.lead_id === c.lead_id) touches.push(keyOf(m.created_at));
    for (const b of st.bookings || []) if (b.lead_id === c.lead_id && b.starts_at && keyOf(b.starts_at) <= t0) touches.push(keyOf(b.starts_at));
  }
  const lastContact = touches.filter(Boolean).sort().pop() || null;
  return { income, paid, unpaid, unpaidList, overdue, projects, openProjects, openTasks, reports, lastReport, lastSent, lastContact, since };
}

/** Look-after-them prompts: only the ones that are true, each with its action. */
export function clientPrompts(c, st = state) {
  const f = clientFacts(c, st);
  const t0 = today();
  const out = [];
  if (c.archived) return out;
  if (f.overdue.length) {
    const i = f.overdue[0];
    const days = Math.round((Date.parse(t0) - Date.parse(i.due_on)) / 86400000);
    out.push({
      id: 'overdue', tone: 'bad', title: 'Invoice overdue',
      text: `${i.invoice_no ? `${i.invoice_no}, ` : ''}${money(i.amount)}, was due ${fmtDate(i.due_on)} (${plural(days, 'day')} ago)${f.overdue.length > 1 ? `. ${f.overdue.length - 1} more overdue.` : '.'}`,
      action: { label: 'Open the invoice', href: `#income/${i.id}` }
    });
  }
  if (c.status !== 'active') return out;
  const cut35 = addDays(t0, -35);
  if (f.since <= cut35 && !(f.lastSent && f.lastSent > cut35)) {
    const draft = f.reports.filter((r) => r.status === 'draft').sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    out.push({
      id: 'report', tone: 'warn', title: 'No ROI report in the last 35 days',
      text: f.lastSent ? `The last one went out ${fmtDate(f.lastSent)}. Show them what this month was worth.` : 'They have not had one yet. Show them what the work is worth.',
      action: draft ? { label: 'Finish the draft', href: `#roi-reports/${draft.id}` } : { label: 'Write the ROI report', href: `#roi-reports/new/${c.id}` }
    });
  }
  const moving = f.projects.some((p) => !p.archived && p.status === 'active') || f.openTasks.some((t) => t.state === 'doing' || t.state === 'review');
  if (!moving) {
    out.push({
      id: 'idle', tone: 'info', title: 'Nothing in progress',
      text: 'No active project and no task underway. A paying client should always have something moving.',
      action: { label: 'Start a project', run: () => openProjectForm(c.id) }
    });
  }
  const contactBase = [f.lastContact, f.since].filter(Boolean).sort().pop();
  if (contactBase && contactBase <= addDays(t0, -30)) {
    out.push({
      id: 'contact', tone: 'info', title: 'No contact logged in 30 days',
      text: f.lastContact ? `Last in touch ${fmtDate(f.lastContact)}. A quick call keeps them close.` : 'Nothing logged since they started. A quick call keeps them close.',
      action: { label: 'Log contact', run: () => logContact(c.id) }
    });
  }
  return out;
}

/** Every dated thing that has happened with this client, oldest first. */
export function storyOf(c, st = state) {
  const items = [];
  const add = (date, text, href, kind) => { if (date) items.push({ date: keyOf(date), text, href, kind }); };
  const lead = c.lead_id ? leadById(c.lead_id) : null;
  if (lead) add(lead.created_at, `First came in as a lead: ${leadName(lead)}`, `#leads/${lead.id}`, 'lead');
  for (const b of st.bookings || []) if (c.lead_id && b.lead_id === c.lead_id && b.starts_at) add(b.starts_at, `${b.title || 'Call'} booked${b.status && b.status !== 'booked' ? ` (${b.status})` : ''}`, `#bookings`, 'booking');
  const deals = st.deals.filter((d) => d.client_id === c.id || (c.lead_id && d.lead_id === c.lead_id));
  for (const d of deals) {
    add(d.created_at, `Deal opened: ${d.title}`, `#pipeline/${d.id}`, 'deal');
    if (d.closed_on && (d.stage === 'won' || d.stage === 'lost')) add(d.closed_on, `Deal ${d.stage}: ${d.title}${d.stage === 'won' && (d.value || d.monthly_value) ? ` (${[d.value ? money(d.value) : null, d.monthly_value ? `${money(d.monthly_value)}/mo` : null].filter(Boolean).join(' + ')})` : ''}`, `#pipeline/${d.id}`, 'deal');
  }
  const props = st.proposals.filter((p) => p.client_id === c.id || (c.lead_id && p.lead_id === c.lead_id) || deals.some((d) => d.id === p.deal_id));
  for (const p of props) {
    add(p.sent_on || p.created_at, `Proposal ${p.sent_on ? 'sent' : 'drafted'}: ${p.title}`, `#proposals/${p.id}`, 'proposal');
    if (p.decided_on && ['accepted', 'declined'].includes(p.status)) add(p.decided_on, `Proposal ${p.status}: ${p.title}`, `#proposals/${p.id}`, 'proposal');
  }
  add(c.started_on || c.created_at, 'Became a client', null, 'client');
  for (const p of st.projects.filter((x) => x.client_id === c.id)) {
    add(p.started_on || p.created_at, `Project started: ${p.name}`, `#projects/${p.id}`, 'project');
    if (p.status === 'done') add(p.updated_at, `Project done: ${p.name}`, `#projects/${p.id}`, 'project');
  }
  for (const i of st.income.filter((x) => x.client_id === c.id && x.status !== 'void' && x.status !== 'draft')) {
    add(i.issued_on || i.created_at, `Invoiced ${money(i.amount)}${i.invoice_no ? ` (${i.invoice_no})` : ''}: ${i.description}`, `#income/${i.id}`, 'invoice');
    if (i.status === 'paid' && i.paid_on) add(i.paid_on, `Paid ${money(i.amount)}${i.invoice_no ? ` (${i.invoice_no})` : ''}`, `#income/${i.id}`, 'paid');
  }
  for (const r of st.roi_reports.filter((x) => x.client_id === c.id)) {
    const t = reportTotals(r);
    add(r.sent_on || r.created_at, `ROI report ${r.status === 'sent' ? 'sent' : 'drafted'}: ${periodLabel(r.period_start, r.period_end)}, ${money(t.total)} delivered`, `#roi-reports/${r.id}`, 'report');
  }
  for (const x of contactLog(c)) add(x.date, `${x.kind}${x.text ? `: ${x.text}` : ''}`, null, 'contact');
  return items.sort((a, b) => a.date.localeCompare(b.date));
}

/* ============================================================ actions */
export async function logContact(clientId) {
  const c = rowById('clients', clientId);
  if (!c) return;
  const v = await modal({
    title: `Log contact with ${c.name}`, confirmLabel: 'Log it',
    body: el('div', { class: 'form-grid' },
      field('How', select('kind', CONTACT_KINDS, 'Call')),
      field('When', input('date', { type: 'date', value: today(), max: today() })),
      el('div', { class: 'full' }, field('What came of it', input('text', { placeholder: 'e.g. Walked through the October numbers, keen on after-hours bookings', autocomplete: 'off' }))))
  });
  if (!v) return;
  const line = `${v.date || today()} · ${v.kind}: ${String(v.text || '').replace(/\s+/g, ' ').trim()}`.trim();
  const fresh = rowById('clients', clientId);
  try {
    await saveRow('clients', { id: clientId, notes: [line, String(fresh?.notes || '').trim()].filter(Boolean).join('\n') });
    toast('Contact logged');
  } catch (e) { toast(e.message, 'bad'); }
}

async function openClientForm() {
  const v = await modal({
    title: 'Add a client', confirmLabel: 'Add client', wide: true,
    body: el('div', { class: 'form-grid' },
      el('div', { class: 'full' }, field('Business', input('name', { required: true, placeholder: 'Smith Plumbing', autocomplete: 'off' }))),
      field('Contact name', input('contact_name', { placeholder: 'Dave Smith', autocomplete: 'off' })),
      field('Phone', input('phone', { type: 'tel', placeholder: '0412 345 678', inputmode: 'tel', autocomplete: 'off' })),
      field('Email', input('email', { type: 'email', placeholder: 'dave@example.com.au', autocomplete: 'off' })),
      field('Website', input('website', { placeholder: 'smithplumbing.com.au' })),
      field('Industry', input('industry', { placeholder: 'Plumbing' })),
      field('Suburb', input('suburb', { placeholder: 'Paddington' })),
      field('Retainer', input('monthly_value', { type: 'number', min: 0, step: 50, inputmode: 'decimal', placeholder: '0' }), '$ a month, if they pay one'),
      field('Client since', input('started_on', { type: 'date', value: today() })),
      field('Status', select('status', CLIENT_STATUSES.map((s) => ({ id: s.id, label: s.label })), 'active')),
      el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Owner'), ownerPicker({ value: meId(), name: 'owner_id', label: 'Client owner' })))
  });
  if (!v) return;
  const phone = v.phone.trim() ? (normalisePhone(v.phone) || v.phone.trim()) : null;
  try {
    const row = await saveRow('clients', {
      name: v.name.trim(), contact_name: v.contact_name.trim() || null, phone, email: v.email.trim() || null,
      website: v.website.trim() || null, industry: v.industry.trim() || null, suburb: v.suburb.trim() || null,
      monthly_value: Number(v.monthly_value) || 0, started_on: v.started_on || null, status: v.status,
      owner_id: v.owner_id || null
    });
    toast('Client added');
    go(`clients/${row.id}`);
  } catch (e) { toast(e.message, 'bad'); }
}

/* ================================================================ view */
const ui = { q: '', status: 'all', archived: false, owner: '' };

export default function clientsView(ctx) {
  const { param } = ctx;
  if (param === 'new') {
    history.replaceState(null, '', '#clients');
    const node = roster();
    setTimeout(openClientForm, 0);
    return node;
  }
  if (param && UUID.test(param)) return clientPage(param);
  return roster();
}

/* -------------------------------------------------------------- roster */
function roster() {
  const st = state;
  const root = el('div', { class: 'page dl-page' });
  const head = el('div', { class: 'page-head' },
    el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, 'Deliver'), el('h1', { class: 'h1' }, 'Clients')),
    el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn btn-primary', onClick: openClientForm }, icon('plus', 16), 'Add client')));
  const kpis = el('div');
  const search = input('q', { type: 'search', value: ui.q, placeholder: 'Search name, contact, suburb', 'aria-label': 'Search clients', autocomplete: 'off' });
  search.addEventListener('input', () => { ui.q = search.value.trim().toLowerCase(); paint(); });
  const chips = el('div', { class: 'row dl-chips', role: 'group', 'aria-label': 'Filter by status' });
  const arch = el('label', { class: 'check-row small' }, el('input', { type: 'checkbox', class: 'check', checked: ui.archived || null, onChange: (e) => { ui.archived = e.target.checked; paint(); } }), 'Archived');
  const ownerBox = el('span', { class: 'own-filter-box' });
  const bar = el('div', { class: 'toolbar dl-bar' }, el('label', { class: 'search' }, icon('search', 16), search), chips, el('span', { class: 'spacer' }), ownerBox, arch);
  const content = el('div');
  root.append(head, kpis, bar, content);

  function paint() {
    const tot = rosterTotals(st.clients);
    const owed = st.income.filter((i) => i.status === 'invoiced' && i.client_id).reduce((s, i) => s + n(i.amount), 0);
    fill(kpis, el('div', { class: 'grid cols-4 dl-kpis' },
      el('div', { class: 'kpi' }, el('span', { class: 'kpi-label' }, 'Active clients'), el('span', { class: 'kpi-value', dataset: { k: 'active' } }, num(tot.active)),
        el('span', { class: 'kpi-sub' }, `${num(st.clients.filter((c) => !c.archived && c.status === 'paused').length)} paused`)),
      el('div', { class: 'kpi' }, el('span', { class: 'kpi-label' }, 'Monthly recurring'), el('span', { class: 'kpi-value', dataset: { k: 'mrr' } }, money(tot.mrr)), el('span', { class: 'kpi-sub' }, 'retainers from active clients')),
      el('div', { class: 'kpi' }, el('span', { class: 'kpi-label' }, 'Average per client'), el('span', { class: 'kpi-value', dataset: { k: 'avg' } }, money(tot.avg)), el('span', { class: 'kpi-sub' }, 'a month')),
      el('a', { class: 'kpi', href: '#income' }, el('span', { class: 'kpi-label' }, 'Owed to you'), el('span', { class: 'kpi-value', dataset: { k: 'owed' } }, money(owed)), el('span', { class: 'kpi-sub' }, 'invoiced, not yet paid'))));

    if (!ownerBox.firstChild || document.activeElement !== ownerBox.firstChild) fill(ownerBox, ownerFilterSelect(ui.owner, (v) => { ui.owner = v; paint(); }, { label: 'Owner' }));
    const base = st.clients.filter((c) => (ui.archived ? c.archived : !c.archived) && matchesOwner(ui.owner, c));
    const chip = (id, label) => {
      const count = id === 'all' ? base.length : base.filter((c) => c.status === id).length;
      return el('button', { type: 'button', class: `chip${ui.status === id ? ' is-active' : ''}`, 'aria-pressed': String(ui.status === id), onClick: () => { ui.status = id; paint(); } }, label, el('span', { class: 'count' }, num(count)));
    };
    fill(chips, chip('all', 'All'), ...CLIENT_STATUSES.map((s) => chip(s.id, s.label)));

    const list = base.filter((c) => (ui.status === 'all' || c.status === ui.status)
      && (!ui.q || [c.name, c.contact_name, c.email, c.suburb, c.industry, c.phone, (c.tags || []).join(' ')].join(' ').toLowerCase().includes(ui.q)))
      .sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : b.status === 'active' ? 1 : a.status.localeCompare(b.status)) || n(b.monthly_value) - n(a.monthly_value) || a.name.localeCompare(b.name));
    clear(content);
    if (!st.clients.length) {
      content.append(emptyState({
        icon: 'leads', title: 'No clients yet',
        text: 'When a lead says yes, turn them into a client from their lead page, or add one here. Their projects, invoices and ROI reports all hang off this page.',
        action: el('button', { type: 'button', class: 'btn btn-primary', onClick: openClientForm }, icon('plus', 16), 'Add the first client')
      }));
      return;
    }
    if (!list.length) { content.append(emptyState({ icon: 'search', title: 'Nothing matches', text: ui.archived ? 'No archived clients.' : 'Try another search or status.' })); return; }
    content.append(el('div', { class: 'table-wrap' }, el('table', { class: 'table dl-table cl-table' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Client'), el('th', { class: 'cl-owner-h' }, 'Owner'), el('th', {}, 'Status'), el('th', { class: 'num' }, '$/mo'), el('th', { class: 'num' }, 'Projects'), el('th', { class: 'num' }, 'Tasks'),
        el('th', { class: 'num' }, 'Paid'), el('th', { class: 'num' }, 'Unpaid'), el('th', {}, 'Last report'))),
      el('tbody', {}, list.map((c) => {
        const f = clientFacts(c, st);
        return el('tr', { class: 'is-click', dataset: { id: c.id }, onClick: () => go(`clients/${c.id}`) },
          el('td', { class: 'dl-primary' }, el('div', { class: 'dl-cell' },
            el('a', { href: `#clients/${c.id}`, class: 'dl-name', onClick: (e) => e.stopPropagation() }, c.name),
            el('span', { class: 'dl-sub' }, [c.contact_name, c.phone ? prettyPhone(c.phone) : c.email].filter(Boolean).join(' · ') || c.industry || ''))),
          el('td', { class: 'cl-owner-cell', 'data-label': 'Owner' }, ownerPicker({ value: c.owner_id || null, compact: true, label: `Owner: ${c.name}`, onChange: (oid) => saveOwner('clients', c.id, oid) })),
          el('td', { 'data-label': 'Status' }, clientBadge(c.status)),
          el('td', { class: 'num', 'data-label': '$/mo', dataset: { k: 'mrr' } }, n(c.monthly_value) ? money(c.monthly_value) : el('span', { class: 'faint' }, '—')),
          el('td', { class: 'num', 'data-label': 'Projects', dataset: { k: 'projects' } }, f.openProjects.length ? num(f.openProjects.length) : el('span', { class: 'faint' }, '0')),
          el('td', { class: 'num', 'data-label': 'Tasks', dataset: { k: 'tasks' } }, f.openTasks.length ? num(f.openTasks.length) : el('span', { class: 'faint' }, '0')),
          el('td', { class: 'num', 'data-label': 'Paid', dataset: { k: 'paid' } }, f.paid ? money(f.paid) : el('span', { class: 'faint' }, '—')),
          el('td', { class: `num${f.overdue.length ? ' dl-bad' : ''}`, 'data-label': 'Unpaid', dataset: { k: 'unpaid' } }, f.unpaid ? money(f.unpaid) : el('span', { class: 'faint' }, '—')),
          el('td', { class: 'small nowrap', 'data-label': 'Last report', dataset: { k: 'report' } }, f.lastReport ? fmtDate(f.lastReport) : el('span', { class: 'faint' }, 'None yet')));
      })))));
  }
  paint();
  root.onState = paint;
  return root;
}

/* --------------------------------------------------------- client page */
function clientPage(id) {
  const st = state;
  const root = el('div', { class: 'page dl-page cl-page' });
  if (!rowById('clients', id)) {
    root.append(el('a', { href: '#clients', class: 'dl-back' }, icon('chevron-left', 15), 'Clients'),
      emptyState({ icon: 'alert', title: 'That client is not here', text: 'They may have been deleted.', action: el('a', { class: 'btn btn-ghost', href: '#clients' }, 'Back to clients') }));
    return root;
  }
  const eyebrow = el('p', { class: 'eyebrow' });
  const h1 = el('h1', { class: 'h1 cl-h1' });
  const sub = el('div', { class: 'dl-headsub' });
  const ownerSlot = el('span', { class: 'dl-powner' });
  const contact = el('div', { class: 'row cl-contact' });
  const headActions = el('div', { class: 'row' });
  const head = el('div', { class: 'page-head' },
    el('div', { class: 'stack' }, el('a', { href: '#clients', class: 'dl-back' }, icon('chevron-left', 15), 'Clients'), eyebrow, h1, sub, contact),
    headActions);
  const prompts = el('div', { class: 'cl-prompts' });
  const money4 = el('div');
  const projectsBox = el('div');
  const tasksBox = el('ul', { class: 'dl-tasks' });
  const reportsBox = el('div');
  const storyBox = el('div');
  const details = detailsPanel(id);
  const notes = notesPanel(id);

  const sec = (eyebrowText, title, action, ...body) => el('section', { class: 'section' },
    el('div', { class: 'section-head' }, el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, eyebrowText), el('h2', { class: 'h2' }, title)), action || null), ...body);

  root.append(head, prompts, money4, el('div', { class: 'dl-split' },
    el('div', { class: 'dl-main' },
      sec('Work', 'Projects', el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => openProjectForm(id) }, icon('plus', 13), 'New project'), projectsBox),
      sec('To do', 'Open tasks', null, quickAdd({ client_id: id }, { placeholder: 'Add a task for this client and press Enter' }), tasksBox),
      sec('Proof of value', 'ROI reports', el('a', { class: 'btn btn-ghost btn-sm', href: `#roi-reports/new/${id}` }, icon('plus', 13), 'New ROI report'), reportsBox),
      sec('History', 'The story so far', null, storyBox)),
    el('aside', { class: 'dl-side' }, details.node, notes.node)));

  function paintHead() {
    const c = rowById('clients', id);
    eyebrow.textContent = ['Client', c.industry, c.suburb, c.started_on ? `since ${fmtDate(c.started_on, { month: 'short', year: 'numeric' })}` : null, c.archived ? 'archived' : null].filter(Boolean).join(' · ');
    h1.textContent = c.name;
    const lead = c.lead_id ? leadById(c.lead_id) : null;
    if (!ownerSlot.firstChild) fill(ownerSlot, ownerPicker({ value: c.owner_id || null, label: 'Client owner', onChange: (oid) => saveOwner('clients', id, oid) }));
    else ownerSlot.firstChild.setValue(c.owner_id || null);
    fill(sub, clientBadge(c.status), ownerSlot,
      n(c.monthly_value) ? el('span', { class: 'tnum' }, `${money(c.monthly_value)}/mo`) : null,
      c.contact_name ? el('span', {}, icon('user', 13), c.contact_name) : null,
      lead ? el('a', { href: `#leads/${lead.id}` }, icon('link', 13), 'Lead record') : null);
    const tel = normalisePhone(c.phone) || c.phone;
    const web = safeHref(c.website);
    fill(contact,
      c.phone ? el('a', { class: 'btn btn-ghost btn-sm', href: `tel:${tel}` }, icon('phone', 14), 'Call') : null,
      c.email ? el('a', { class: 'btn btn-ghost btn-sm', href: `mailto:${encodeURIComponent(c.email).replace('%40', '@')}` }, icon('mail', 14), 'Email') : null,
      c.phone ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { fk: 'copy-phone' }, onClick: () => copyText(prettyPhone(c.phone), 'Number copied') }, icon('copy', 14), prettyPhone(c.phone)) : null,
      c.email ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { fk: 'copy-email' }, onClick: () => copyText(c.email, 'Email copied') }, icon('copy', 14), c.email) : null,
      web ? el('a', { class: 'btn btn-ghost btn-sm', href: web, target: '_blank', rel: 'noopener noreferrer' }, icon('external', 14), 'Website') : null,
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { fk: 'log' }, onClick: () => logContact(id) }, icon('note', 14), 'Log contact'));
    fill(headActions,
      el('a', { class: 'btn btn-primary btn-sm', href: `#roi-reports/new/${id}` }, icon('spark', 14), 'New ROI report'),
      el('button', {
        type: 'button', class: 'btn btn-ghost btn-sm', dataset: { fk: 'arch' }, onClick: async () => {
          try { await saveRow('clients', { id, archived: !c.archived }); toast(c.archived ? 'Restored' : `${c.name} archived`); } catch (e) { toast(e.message, 'bad'); }
        }
      }, icon('archive', 14), c.archived ? 'Restore' : 'Archive'),
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': `Delete ${c.name}`, title: 'Delete client', onClick: () => deleteClient(id) }, icon('trash', 16)));
  }

  function paintBody() {
    const c = rowById('clients', id);
    const f = clientFacts(c, st);
    const ps = clientPrompts(c, st);
    fill(prompts, ps.map((p) => el('div', { class: `callout is-${p.tone} cl-prompt`, dataset: { prompt: p.id } },
      icon(p.tone === 'bad' ? 'alert' : p.id === 'report' ? 'spark' : p.id === 'contact' ? 'phone' : 'clock', 16),
      el('div', { class: 'cl-prompt-text' }, el('b', {}, p.title), el('span', {}, p.text)),
      p.action.href ? el('a', { class: 'btn btn-ghost btn-sm', href: p.action.href }, p.action.label)
        : el('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { fk: `prompt-${p.id}` }, onClick: p.action.run }, p.action.label))));

    fill(money4, el('div', { class: 'grid cols-4 dl-kpis' },
      el('div', { class: 'kpi' }, el('span', { class: 'kpi-label' }, 'Retainer'), el('span', { class: 'kpi-value', dataset: { k: 'retainer' } }, money(c.monthly_value)), el('span', { class: 'kpi-sub' }, 'a month')),
      el('div', { class: 'kpi' }, el('span', { class: 'kpi-label' }, 'Paid to date'), el('span', { class: 'kpi-value', dataset: { k: 'paid' } }, money(f.paid)), el('span', { class: 'kpi-sub' }, plural(f.income.filter((i) => i.status === 'paid').length, 'invoice'))),
      el('div', { class: 'kpi' }, el('span', { class: 'kpi-label' }, 'Unpaid'), el('span', { class: `kpi-value${f.overdue.length ? ' dl-bad' : ''}`, dataset: { k: 'unpaid' } }, money(f.unpaid)),
        el('span', { class: 'kpi-sub' }, f.overdue.length ? `${money(f.overdue.reduce((s, i) => s + n(i.amount), 0))} overdue` : f.unpaidList.length ? plural(f.unpaidList.length, 'invoice') + ' out' : 'nothing owed')),
      el('div', { class: 'kpi' }, el('span', { class: 'kpi-label' }, 'Last contact'), el('span', { class: 'kpi-value cl-kpi-date', dataset: { k: 'contact' } }, f.lastContact ? fmtDate(f.lastContact, { day: 'numeric', month: 'short' }) : '—'),
        el('span', { class: 'kpi-sub' }, f.lastContact ? (f.lastContact >= today() ? 'today' : `${plural(Math.round((Date.parse(today()) - Date.parse(f.lastContact)) / 86400000), 'day')} ago`) : 'nothing logged yet'))),
      el('p', { class: 'small muted cl-money-note' }, 'Invoices are kept in Income. ', el('a', { href: '#income/new', class: 'link-btn' }, 'Add an invoice'), ' and pick this client.'));

    const projects = f.projects.filter((p) => !p.archived).sort((a, b) => (isOpenProject(b) - isOpenProject(a)) || String(b.created_at).localeCompare(String(a.created_at)));
    fill(projectsBox, projects.length
      ? el('ul', { class: 'dl-plist' }, projects.map((p) => el('li', { class: 'dl-pline', dataset: { id: p.id } },
        el('div', { class: 'dl-pline-main' }, el('a', { class: 'dl-name', href: `#projects/${p.id}` }, p.name), el('span', { class: 'dl-sub' }, projectBadge(p.status))),
        el('span', { class: `dl-pline-due small${isOpenProject(p) && isOverdue(p.due_on) ? ' dl-warn' : ''}` }, p.due_on ? `Due ${fmtDate(p.due_on, { day: 'numeric', month: 'short' })}` : el('span', { class: 'faint' }, 'No due date')),
        el('span', { class: 'dl-pline-val tnum' }, p.value ? money(p.value) : el('span', { class: 'faint' }, '—')),
        progressBar(projectProgress(p.id)))))
      : el('p', { class: 'dl-none' }, 'No projects yet. ', el('button', { type: 'button', class: 'link-btn', onClick: () => openProjectForm(id) }, 'Start one'), '.'));

    const reports = [...f.reports].sort((a, b) => String(b.period_end || '').localeCompare(String(a.period_end || '')));
    fill(reportsBox, reports.length
      ? el('ul', { class: 'dl-rlist' }, reports.map((r) => {
        const t = reportTotals(r);
        return el('li', {},
          el('a', { class: 'dl-name', href: `#roi-reports/${r.id}` }, periodLabel(r.period_start, r.period_end)),
          el('span', { class: 'tnum' }, `${money(t.total)} delivered`),
          el('span', { class: 'tnum muted' }, t.multiple === null ? '' : `${(Math.floor(t.multiple * 10) / 10).toFixed(1)}× the fee`),
          r.status === 'sent' ? badge(`Sent ${fmtDate(r.sent_on, { day: 'numeric', month: 'short' })}`, 'ok') : badge('Draft', 'mute'));
      }))
      : el('p', { class: 'dl-none' }, 'No reports yet. Once a month, show them what the work was worth. ', el('a', { href: `#roi-reports/new/${id}`, class: 'link-btn' }, 'Write the first one'), '.'));

    const story = storyOf(c, st);
    const shown = story.length > 14 && !storyBox.dataset.all ? story.slice(-14) : story;
    fill(storyBox,
      story.length > shown.length ? el('button', { type: 'button', class: 'link-btn small cl-earlier', onClick: () => { storyBox.dataset.all = '1'; paintBody(); } }, `Show ${plural(story.length - shown.length, 'earlier event')}`) : null,
      el('ol', { class: 'cl-story' }, shown.map((x) => el('li', { class: `is-${x.kind}` },
        el('span', { class: 'cl-story-date tnum' }, fmtDate(x.date)),
        x.href ? el('a', { href: x.href }, x.text) : el('span', {}, x.text)))));
  }

  const paintTasks = () => {
    const open = sortMyTasks(st.tasks.filter((t) => t.state !== 'done' && taskClientId(t) === id));
    fill(tasksBox, open.length ? open.map((t) => taskRow(t, { showProject: true })) : el('li', { class: 'dl-none' }, 'Nothing open for them.'));
  };

  const paintAll = () => {
    if (!rowById('clients', id)) {
      fill(root, el('a', { href: '#clients', class: 'dl-back' }, icon('chevron-left', 15), 'Clients'),
        emptyState({ icon: 'alert', title: 'This client was deleted', action: el('a', { class: 'btn btn-ghost', href: '#clients' }, 'Back to clients') }));
      return false;
    }
    return true;
  };
  paintHead();
  paintBody();
  paintTasks();
  const tasksPaint = guardedPaint(tasksBox, paintTasks);
  root.onState = () => {
    if (!paintAll()) return;
    keepFocus(head, paintHead);
    keepFocus(root, paintBody);
    tasksPaint();
    details.sync();
    notes.sync();
  };
  return root;
}

async function deleteClient(id) {
  const c = rowById('clients', id);
  if (!c) return;
  const f = clientFacts(c);
  const kept = [
    f.projects.length ? plural(f.projects.length, 'project') : null,
    f.income.length ? plural(f.income.length, 'invoice') : null,
    state.deals.filter((d) => d.client_id === id).length ? plural(state.deals.filter((d) => d.client_id === id).length, 'deal') : null,
    state.tasks.filter((t) => t.client_id === id).length ? plural(state.tasks.filter((t) => t.client_id === id).length, 'task') : null
  ].filter(Boolean);
  const msg = `${f.reports.length ? `Their ${plural(f.reports.length, 'ROI report')} ${f.reports.length === 1 ? 'is' : 'are'} deleted with them. ` : ''}`
    + `${kept.length ? `${kept.join(', ')} stay but lose the link to ${c.name}. ` : ''}This cannot be undone. Archive instead to keep everything.`;
  if (!await confirmDialog(`Delete ${c.name}?`, msg, { confirmLabel: 'Delete client' })) return;
  try { await deleteRow('clients', id); toast(`${c.name} deleted`); go('clients'); } catch (e) { toast(e.message, 'bad'); }
}

/* ---------------------------------------------------- details, in place */
function detailsPanel(id) {
  const c = rowById('clients', id);
  const status = el('span', { class: 'small muted', role: 'status' });
  const leadOpts = () => {
    const cur = rowById('clients', id)?.lead_id;
    const pool = state.leads.filter((l) => l.id === cur || (!l.archived && ['replied', 'interested', 'booked', 'won'].includes(l.status)))
      .sort((a, b) => leadName(a).localeCompare(leadName(b))).slice(0, 300);
    return [{ id: '', label: 'Not linked' }, ...pool.map((l) => ({ id: l.id, label: leadName(l) }))];
  };
  const fields = {
    name: input('name', { value: c.name }),
    status: select('status', CLIENT_STATUSES.map((s) => ({ id: s.id, label: s.label })), c.status),
    monthly_value: input('monthly_value', { type: 'number', min: 0, step: 50, value: c.monthly_value ?? 0, inputmode: 'decimal' }),
    contact_name: input('contact_name', { value: c.contact_name || '' }),
    phone: input('phone', { type: 'tel', value: c.phone ? prettyPhone(c.phone) : '', inputmode: 'tel' }),
    email: input('email', { type: 'email', value: c.email || '' }),
    website: input('website', { value: c.website || '' }),
    industry: input('industry', { value: c.industry || '' }),
    suburb: input('suburb', { value: c.suburb || '' }),
    started_on: input('started_on', { type: 'date', value: c.started_on || '' }),
    tags: input('tags', { value: (c.tags || []).join(', '), placeholder: 'comma separated' }),
    lead_id: select('lead_id', leadOpts(), c.lead_id || '')
  };
  const shown = (k, v) => (k === 'phone' ? (v ? prettyPhone(v) : '') : k === 'tags' ? (v || []).join(', ') : k === 'monthly_value' ? String(v ?? 0) : (v ?? ''));
  for (const [k, node] of Object.entries(fields)) {
    node.dataset.fk = `c-${k}`;
    node.addEventListener('change', async () => {
      let v = node.value.trim();
      if (k === 'name' && !v) { node.value = rowById('clients', id)?.name || ''; toast('A client needs a name', 'warn'); return; }
      if (k === 'monthly_value') v = Number(v) || 0;
      else if (k === 'tags') v = v.split(',').map((t) => t.trim()).filter(Boolean);
      else if (k === 'phone') v = v ? (normalisePhone(v) || v) : null;
      else if (k !== 'name' && k !== 'status') v = v || null;
      status.textContent = 'Saving…';
      try { await saveRow('clients', { id, [k]: v }); status.textContent = 'Saved'; } catch (e) { status.textContent = ''; toast(e.message, 'bad'); }
    });
  }
  const node = el('section', { class: 'section dl-details' },
    el('div', { class: 'section-head' }, el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, 'Details'), el('h2', { class: 'h2' }, 'Who they are')), status),
    el('div', { class: 'stack' },
      field('Business', fields.name),
      el('div', { class: 'form-grid' }, field('Status', fields.status), field('Retainer, $/mo', fields.monthly_value)),
      field('Contact', fields.contact_name),
      el('div', { class: 'form-grid' }, field('Phone', fields.phone), field('Email', fields.email)),
      field('Website', fields.website),
      el('div', { class: 'form-grid' }, field('Industry', fields.industry), field('Suburb', fields.suburb)),
      el('div', { class: 'form-grid' }, field('Client since', fields.started_on), field('Tags', fields.tags)),
      field('Came from lead', fields.lead_id, 'Links their history from Leads into the story.')));
  return {
    node,
    sync() {
      const cur = rowById('clients', id);
      if (!cur) return;
      if (document.activeElement !== fields.lead_id) {
        fill(fields.lead_id, leadOpts().map((o) => el('option', { value: o.id }, o.label)));
        fields.lead_id.value = cur.lead_id || '';
      }
      for (const [k, nd] of Object.entries(fields)) {
        if (k === 'lead_id' || document.activeElement === nd) continue;
        const want = shown(k, cur[k]);
        if (nd.value !== String(want)) nd.value = String(want);
      }
    }
  };
}

function notesPanel(id) {
  const c = rowById('clients', id);
  const ta = textarea('notes', c.notes || '', 'Anything worth remembering: how they like to be contacted, what matters to them, what you promised.');
  ta.rows = 8;
  ta.dataset.fk = 'c-notes';
  const status = el('span', { class: 'small muted', role: 'status' });
  let timer = 0;
  let dirty = false;
  const save = async () => {
    clearTimeout(timer);
    if (!dirty) return;
    dirty = false;
    status.textContent = 'Saving…';
    try { await saveRow('clients', { id, notes: ta.value.trim() ? ta.value : null }); status.textContent = 'Saved'; } catch (e) { dirty = true; status.textContent = 'Not saved'; toast(e.message, 'bad'); }
  };
  ta.addEventListener('input', () => { dirty = true; status.textContent = 'Editing…'; clearTimeout(timer); timer = setTimeout(save, 1200); });
  ta.addEventListener('blur', save);
  const node = el('section', { class: 'section' },
    el('div', { class: 'section-head' }, el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, 'Notes'), el('h2', { class: 'h2' }, 'Worth remembering')), status),
    el('div', { class: 'stack' }, ta, el('p', { class: 'small muted' }, 'Logged contact is added to the top, dated.')));
  return {
    node,
    sync() {
      const cur = rowById('clients', id);
      if (!cur || dirty || document.activeElement === ta) return;
      if (ta.value !== (cur.notes || '')) ta.value = cur.notes || '';
    }
  };
}
