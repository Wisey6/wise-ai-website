// Income: invoices in and money in. Header numbers, 12-month chart, invoice list,
// add / edit, mark paid, void, raise this month's retainers, CSV export.
import {
  el, fill, icon, badge, toast, modal, confirmDialog, field, input, select, textarea, emptyState,
  money, num, plural, downloadFile, toCsv, busy
} from '../ui.js?v=20261118d';
import { state, saveRow, deleteRow, rowById } from '../api.js?v=20261118d';
import {
  n0, r2, todayIso, monthKey, monthStart, monthEnd, addMonths, addDays, daysBetween, inRange, monthRange, fyRange,
  quarterRange, monthLabel, monthShort, issuedOf, isPaid, isOverdue, gstPart, netAmount, suggestGst, moneyIn,
  receivables, incomeByMonth, suggestInvoiceNo, nextInvoiceNos, dueRetainers, retainerInvoice, monthsBetween
} from './money-math.js?v=20261118d';
import { money2, dateFmt, how, kpiStrip, clientLink, pageHead, sectionHead, iconAction, toolSelect, setOptions, clientOptions } from './money-ui.js?v=20261118d';

/* ------------------------------------------------------------ view state */
const ui = { head: 'month', status: 'all', client: '', range: 'all', q: '' };

const STATUS_OPTS = [
  { id: 'all', label: 'All statuses' }, { id: 'draft', label: 'Draft' }, { id: 'invoiced', label: 'Unpaid' },
  { id: 'overdue', label: 'Overdue' }, { id: 'paid', label: 'Paid' }, { id: 'void', label: 'Void' }
];
const RANGE_OPTS = [
  { id: 'all', label: 'Any time' }, { id: 'month', label: 'This month' }, { id: 'last-month', label: 'Last month' },
  { id: 'quarter', label: 'This quarter' }, { id: 'fy', label: 'This financial year' }, { id: 'last-fy', label: 'Last financial year' }
];
const KIND_LABEL = { one_off: 'One-off', retainer: 'Retainer' };

function rangeFor(id, today) {
  if (id === 'month') return monthRange(today);
  if (id === 'last-month') return monthRange(monthStart(addMonths(monthKey(today), -1)));
  if (id === 'quarter') return quarterRange(today);
  if (id === 'fy') return fyRange(today);
  if (id === 'last-fy') return fyRange(addDays(fyRange(today).from, -1));
  return null;
}

/** Status shown as dot + word. Overdue is an unpaid invoice past its due date. */
export function invoiceStatus(r, today) {
  if (isOverdue(r, today)) return { id: 'overdue', label: 'Overdue', tone: 'warn' };
  return {
    draft: { id: 'draft', label: 'Draft', tone: 'mute' },
    invoiced: { id: 'invoiced', label: 'Unpaid', tone: 'info' },
    paid: { id: 'paid', label: 'Paid', tone: 'ok' },
    void: { id: 'void', label: 'Void', tone: 'mute' }
  }[r.status] || { id: r.status, label: r.status, tone: 'mute' };
}

const clientOf = (r) => (r.client_id ? rowById('clients', r.client_id) : null);
const projectOf = (r) => (r.project_id ? rowById('projects', r.project_id) : null);

function filtered(st, today) {
  const range = rangeFor(ui.range, today);
  const q = ui.q.toLowerCase();
  return st.income.filter((r) => {
    if (ui.status === 'overdue' ? !isOverdue(r, today) : ui.status !== 'all' && r.status !== ui.status) return false;
    if (ui.client && r.client_id !== ui.client) return false;
    if (range && !inRange(issuedOf(r), range.from, range.to)) return false;
    if (q) {
      const hay = [r.description, r.invoice_no, r.notes, clientOf(r)?.name].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => String(issuedOf(b)).localeCompare(String(issuedOf(a))) || String(b.invoice_no || '').localeCompare(String(a.invoice_no || '')));
}

/* ================================================================ view */
export default function incomeView(ctx) {
  const { state: st, param } = ctx;
  const root = el('div', { class: 'page money-page income-page' });

  if (param) {
    history.replaceState(null, '', '#income');
    if (param === 'new') setTimeout(() => openInvoice(null), 0);
    else if (param === 'retainers') setTimeout(() => raiseRetainers(), 0);
    else if (/^[0-9a-f-]{36}$/i.test(param)) setTimeout(() => (rowById('income', param) ? openInvoice(param) : toast('That invoice no longer exists', 'warn')), 0);
  }

  const retainerBtn = el('button', { type: 'button', class: 'btn btn-ghost', onClick: () => raiseRetainers() });
  const exportBtn = el('button', { type: 'button', class: 'btn btn-ghost', onClick: () => exportCsv() }, icon('download', 16), 'Export CSV');
  const head = pageHead('Money', 'Income', null, [
    retainerBtn, exportBtn,
    el('button', { type: 'button', class: 'btn btn-primary', onClick: () => openInvoice(null) }, icon('plus', 16), 'Add invoice')
  ]);

  const headTabs = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Period' });
  const kpis = el('div');
  const chart = el('section', { class: 'section money-section' });
  const listHead = el('div');

  const search = input('q', { type: 'search', value: ui.q, placeholder: 'Search invoices…', 'aria-label': 'Search invoices', autocomplete: 'off' });
  search.addEventListener('input', () => { ui.q = search.value.trim(); paintList(); });
  const statusSel = toolSelect('Status', STATUS_OPTS, ui.status, (v) => { ui.status = v; paintList(); });
  const clientSel = toolSelect('Client', [{ id: '', label: 'All clients' }], ui.client, (v) => { ui.client = v; paintList(); });
  const rangeSel = toolSelect('Period', RANGE_OPTS, ui.range, (v) => { ui.range = v; paintList(); });
  const toolbar = el('div', { class: 'money-bar-tools' }, el('label', { class: 'search' }, icon('search', 16), search), statusSel, clientSel, rangeSel);
  const list = el('div');
  const listSection = el('section', { class: 'section money-section' }, listHead, toolbar, list);
  const body = el('div', { class: 'money-body' });

  root.append(head, body);

  function paint() {
    const today = todayIso();
    const due = dueRetainers(st.clients, st.income, today);
    fill(retainerBtn, icon('refresh', 16), 'Raise retainers', due.length ? el('span', { class: 'money-count' }, num(due.length)) : null);
    retainerBtn.title = due.length ? `${plural(due.length, 'active client')} on a retainer with no invoice this month` : 'Every active retainer has an invoice this month';
    exportBtn.disabled = !st.income.length;
    setOptions(clientSel, [{ id: '', label: 'All clients' }, ...clientOptions(st.clients).slice(1)]);
    ui.client = clientSel.value;

    if (!st.income.length) {
      fill(body, el('div', { class: 'money-empty' }, emptyState({
        icon: 'money', title: 'No invoices yet',
        text: 'Add an invoice when you send one and mark it paid when the money lands. Money in, overdue amounts and your runway all build from these rows.',
        action: el('div', { class: 'row' },
          el('button', { type: 'button', class: 'btn btn-primary', onClick: () => openInvoice(null) }, icon('plus', 16), 'Add your first invoice'),
          due.length ? el('button', { type: 'button', class: 'btn btn-ghost', onClick: () => raiseRetainers() }, `Raise ${plural(due.length, 'retainer')}`) : null)
      })));
      return;
    }
    fill(body, el('section', { class: 'section money-section' }, headTabs, kpis), chart, listSection);
    paintKpis(today);
    paintChart(today);
    paintList();
  }

  function paintKpis(today) {
    fill(headTabs, ...[['month', 'This month'], ['fy', 'This financial year']].map(([id, label]) => el('button', {
      type: 'button', role: 'tab', class: `tab${ui.head === id ? ' is-active' : ''}`, 'aria-selected': String(ui.head === id),
      onClick: () => { ui.head = id; paintKpis(todayIso()); }
    }, label)));
    const s = st.settings || {};
    const range = ui.head === 'fy' ? fyRange(today) : monthRange(today);
    const inn = moneyIn(st.income, s, range.from, range.to);
    const rec = receivables(st.income, today, range);
    const all = receivables(st.income, today);
    const monthsSoFar = monthsBetween(range.from, today).length;
    const target = r2(n0(s.monthly_target) * (ui.head === 'fy' ? monthsSoFar : 1));
    const pct = target > 0 ? inn.net / target : null;
    fill(kpis, kpiStrip([
      { id: 'in', label: 'Money in', value: money(inn.net), sub: `${plural(inn.count, 'invoice')} paid${inn.gst ? ` · plus ${money(inn.gst)} GST` : ''}`,
        how: `Invoices marked paid, dated by the day paid, ${range.label}${s.gst_registered ? ', less GST' : ''}.` },
      { id: 'unpaid', label: 'Invoiced, unpaid', value: money(rec.total), sub: all.total !== rec.total ? `${money(all.total)} across all invoices` : plural(rec.count, 'invoice'),
        how: 'Invoices sent in this period and not yet paid, as invoiced. Drafts and void are left out.' },
      { id: 'overdue', label: 'Overdue', value: money(rec.overdue), tone: rec.overdue > 0 ? 'warn' : '', sub: all.overdue !== rec.overdue ? `${money(all.overdue)} across all invoices` : plural(rec.overdueCount, 'invoice'),
        how: 'Unpaid invoices whose due date has passed.' },
      { id: 'target', label: 'To target', value: pct === null ? '—' : `${Math.round(pct * 100)}%`, bar: pct === null ? null : pct,
        sub: target > 0 ? `${money(inn.net)} of ${money(target)}` : 'Set a monthly target on Runway',
        how: ui.head === 'fy' ? `Money in against your monthly target × ${plural(monthsSoFar, 'month')} so far this year.` : 'Money in against your monthly target.' }
    ]));
  }

  function paintChart(today) {
    const s = st.settings || {};
    const cur = monthKey(today);
    const months = incomeByMonth(st.income, s, cur, 12);
    const target = n0(s.monthly_target);
    const max = Math.max(1, target, ...months.map((m) => m.net));
    const W = 120; const H = 100; const colW = W / 12; const barW = colW * 0.56;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'money-chart-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Money in for the last 12 months. ${months.map((m) => `${monthLabel(m.key)} ${money(m.net)}`).join(', ')}.`);
    const mk = (tag, attrs) => { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
    months.forEach((m, i) => {
      const h = (m.net / max) * (H - 2);
      const rect = mk('rect', { x: (i * colW + (colW - barW) / 2).toFixed(3), y: (H - h).toFixed(3), width: barW.toFixed(3), height: Math.max(0, h).toFixed(3), class: m.key === cur ? 'is-current' : '' });
      const t = mk('title', {}); t.textContent = `${monthLabel(m.key, true)}: ${money(m.net)}`;
      rect.append(t);
      svg.append(rect);
    });
    svg.append(mk('line', { x1: 0, x2: W, y1: H - 0.25, y2: H - 0.25, class: 'base', 'vector-effect': 'non-scaling-stroke' }));
    if (target > 0) {
      const y = (H - (target / max) * (H - 2)).toFixed(3);
      svg.append(mk('line', { x1: 0, x2: W, y1: y, y2: y, class: 'target', 'vector-effect': 'non-scaling-stroke' }));
    }
    const labels = el('div', { class: 'money-chart-x', 'aria-hidden': 'true' }, months.map((m) => el('span', { class: m.key === cur ? 'is-current' : '' }, monthShort(m.key))));
    const total = months.reduce((t, m) => t + m.net, 0);
    const table = el('div', { class: 'table-wrap' }, el('table', { class: 'table money-table' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Month'), el('th', { class: 'num' }, 'Money in'), el('th', { class: 'num' }, 'GST'), el('th', { class: 'num' }, 'Paid'), el('th', { class: 'num' }, 'Against target'))),
      el('tbody', {}, [...months].reverse().map((m) => el('tr', { class: m.key === cur ? 'is-current' : '' },
        el('td', {}, monthLabel(m.key, true), m.key === cur ? el('span', { class: 'muted' }, ' · so far') : null),
        el('td', { class: 'num' }, money2(m.net)),
        el('td', { class: 'num muted' }, m.gst ? money2(m.gst) : '—'),
        el('td', { class: 'num muted' }, m.count ? num(m.count) : '—'),
        el('td', { class: 'num' }, target > 0 ? el('span', { class: m.net >= target ? 'money-up' : 'muted' }, `${m.net - target >= 0 ? '+' : '−'}${money(Math.abs(m.net - target))}`) : '—')))),
      el('tfoot', {}, el('tr', {}, el('td', {}, 'Last 12 months'), el('td', { class: 'num' }, money2(total)), el('td', { colspan: 3 })))));
    const details = el('details', { class: 'money-details' }, el('summary', {}, 'Month by month'), table);
    fill(chart,
      sectionHead('Last 12 months', `${money(total)} in`, el('p', { class: 'muted small money-legend' },
        el('span', { class: 'money-key is-ink' }), 'Money in', el('span', { class: 'money-key is-accent' }), 'This month',
        target > 0 ? [el('span', { class: 'money-key is-target' }), `Target ${money(target)}`] : null)),
      el('div', { class: 'money-chart' }, svg, labels),
      how('Each bar is paid invoices by the month they were paid, less GST when you are registered.'),
      details);
  }

  function paintList() {
    const today = todayIso();
    const rows = filtered(st, today);
    const s = st.settings || {};
    const totalAmt = rows.reduce((t, r) => t + n0(r.amount), 0);
    fill(listHead, sectionHead('Invoices', plural(rows.length, 'invoice'), el('span', { class: 'muted tnum' }, rows.length ? `${money2(totalAmt)} as invoiced` : '')));
    if (!rows.length) {
      fill(list, el('div', { class: 'empty money-none' }, el('p', { class: 'muted' }, 'No invoices match these filters.'),
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => { ui.status = 'all'; ui.client = ''; ui.range = 'all'; ui.q = ''; statusSel.value = 'all'; clientSel.value = ''; rangeSel.value = 'all'; search.value = ''; paintList(); } }, 'Clear filters')));
      return;
    }
    const tr = (r) => {
      const stt = invoiceStatus(r, today);
      const late = isOverdue(r, today) ? daysBetween(r.due_on, today) : 0;
      const client = clientOf(r);
      const project = projectOf(r);
      const acts = el('div', { class: 'money-row-acts' },
        r.status === 'draft' ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: (e) => busy(e.currentTarget, () => patch(r.id, { status: 'invoiced' }, 'Marked as sent')) }, 'Mark sent') : null,
        r.status === 'draft' || r.status === 'invoiced' ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => markPaid(r.id) }, icon('check', 13), 'Mark paid') : null,
        iconAction('edit', `Edit ${r.description}`, () => openInvoice(r.id)),
        r.status !== 'void' && r.status !== 'paid' ? iconAction('ban', `Void ${r.description}`, () => voidInvoice(r.id)) : null,
        iconAction('trash', `Delete ${r.description}`, () => removeInvoice(r.id), 'is-danger'));
      return el('tr', { dataset: { id: r.id }, class: r.status === 'void' ? 'is-void' : '' },
        el('td', { class: 'money-name' },
          el('button', { type: 'button', class: 'money-name-btn', onClick: () => openInvoice(r.id) }, r.description),
          el('span', { class: 'money-sub' }, [r.invoice_no, project ? project.name : null].filter(Boolean).join(' · ') || ' ')),
        el('td', {}, clientLink(client)),
        el('td', { class: 'muted' }, KIND_LABEL[r.kind] || r.kind),
        el('td', { class: 'num' }, el('b', {}, money2(r.amount)), s.gst_registered && n0(r.gst) ? el('span', { class: 'money-sub' }, `incl. ${money2(gstPart(r, s))} GST`) : null),
        el('td', {}, badge(stt.label, stt.tone)),
        el('td', { class: 'nowrap' }, dateFmt(r.issued_on) || el('span', { class: 'faint' }, '—')),
        el('td', { class: 'nowrap' }, r.due_on ? el('span', { class: late ? 'money-late' : '' }, dateFmt(r.due_on), late ? el('span', { class: 'money-sub' }, `${plural(late, 'day')} late`) : null) : el('span', { class: 'faint' }, '—')),
        el('td', { class: 'nowrap' }, r.paid_on && r.status === 'paid' ? dateFmt(r.paid_on) : el('span', { class: 'faint' }, '—')),
        el('td', { class: 'money-acts-cell' }, acts));
    };
    fill(list, el('div', { class: 'table-wrap' }, el('table', { class: 'table money-table money-invoices' },
      el('thead', {}, el('tr', {}, ['Invoice', 'Client', 'Kind'].map((h) => el('th', {}, h)), el('th', { class: 'num' }, 'Amount'),
        ['Status', 'Issued', 'Due', 'Paid'].map((h) => el('th', {}, h)), el('th', {}, el('span', { class: 'sr-only' }, 'Actions')))),
      el('tbody', {}, rows.map(tr)))),
    how(`Amounts are as invoiced${s.gst_registered ? ', including GST' : ''}. The period filter uses the issue date.`));
  }

  function exportCsv() {
    const rows = filtered(st, todayIso());
    if (!rows.length) { toast('Nothing to export with these filters', 'warn'); return; }
    const s = st.settings || {};
    const out = rows.map((r) => ({
      invoice_no: r.invoice_no || '', description: r.description, client: clientOf(r)?.name || '', project: projectOf(r)?.name || '',
      kind: KIND_LABEL[r.kind] || r.kind, status: invoiceStatus(r, todayIso()).label, amount: r2(r.amount), gst: gstPart(r, s),
      revenue_ex_gst: netAmount(r, s), issued_on: r.issued_on || '', due_on: r.due_on || '', paid_on: r.paid_on || '', notes: r.notes || ''
    }));
    downloadFile(`income-${todayIso()}.csv`, toCsv(out));
    toast(`Exported ${plural(out.length, 'invoice')}`);
  }

  paint();
  root.onState = paint;
  return root;
}

/* ============================================================ actions */
async function patch(id, change, msg) {
  try { await saveRow('income', { id, ...change }); if (msg) toast(msg); } catch (e) { toast(e.message, 'bad'); }
}

export async function markPaid(id) {
  const r = rowById('income', id);
  if (!r) return;
  const res = await modal({
    title: 'Mark as paid',
    body: [
      el('p', { class: 'muted' }, `${r.description}${r.invoice_no ? ` (${r.invoice_no})` : ''}, ${money2(r.amount)}.`),
      field('Paid on', input('paid_on', { type: 'date', value: todayIso(), required: true }), 'The day the money landed. Money in is dated by this.')
    ],
    confirmLabel: 'Mark paid'
  });
  if (!res) return;
  await patch(id, { status: 'paid', paid_on: res.paid_on }, 'Marked paid');
}

async function voidInvoice(id) {
  const r = rowById('income', id);
  if (!r) return;
  const ok = await confirmDialog('Void this invoice?', `${r.description} stays on record but no longer counts as owed or earned.`, { confirmLabel: 'Void invoice' });
  if (ok) await patch(id, { status: 'void' }, 'Invoice voided');
}

async function removeInvoice(id) {
  const r = rowById('income', id);
  if (!r) return;
  const ok = await confirmDialog('Delete this invoice?', `${r.description} will be removed for good. Void it instead if it was sent.`);
  if (!ok) return;
  try { await deleteRow('income', id); toast('Invoice deleted'); } catch (e) { toast(e.message, 'bad'); }
}

/** Add (id null) or edit an invoice. preset fills a new one. */
export async function openInvoice(id, preset = {}) {
  const existing = id ? rowById('income', id) : null;
  if (id && !existing) { toast('That invoice no longer exists', 'warn'); return; }
  const s = state.settings || {};
  const today = todayIso();
  const r = existing || {
    client_id: '', project_id: '', description: '', amount: '', gst: '', kind: 'one_off', status: 'invoiced',
    invoice_no: suggestInvoiceNo(state.income), issued_on: today, due_on: addDays(today, 14), paid_on: '', notes: '', ...preset
  };
  const reg = Boolean(s.gst_registered);
  const clientSel = select('client_id', clientOptions(state.clients), r.client_id || '');
  const projectSel = el('select', { class: 'input', name: 'project_id' });
  const fillProjects = () => {
    const cid = clientSel.value;
    const cur = projectSel.value || r.project_id || '';
    const opts = [{ id: '', label: 'No project' }, ...state.projects.filter((p) => !p.archived && (!cid || p.client_id === cid || p.id === cur))
      .map((p) => ({ id: p.id, label: p.name }))];
    projectSel.replaceChildren(...opts.map((o) => el('option', { value: o.id }, o.label)));
    projectSel.value = opts.some((o) => o.id === cur) ? cur : '';
  };
  fillProjects();
  clientSel.addEventListener('change', fillProjects);
  const amount = input('amount', { type: 'number', value: r.amount === '' ? '' : r2(r.amount), required: true, min: '0', step: '0.01', inputmode: 'decimal', placeholder: '0.00' });
  const gst = input('gst', { type: 'number', value: r.gst === '' ? '' : r2(r.gst), min: '0', step: '0.01', inputmode: 'decimal', placeholder: '0.00' });
  let gstTouched = Boolean(existing);
  gst.addEventListener('input', () => { gstTouched = true; });
  amount.addEventListener('input', () => { if (!gstTouched && reg) gst.value = amount.value === '' ? '' : String(suggestGst(amount.value, s)); });
  const status = select('status', [{ id: 'draft', label: 'Draft, not sent yet' }, { id: 'invoiced', label: 'Sent, unpaid' }, { id: 'paid', label: 'Paid' }, { id: 'void', label: 'Void' }], r.status);
  const issued = input('issued_on', { type: 'date', value: r.issued_on || '' });
  const due = input('due_on', { type: 'date', value: r.due_on || '' });
  let dueTouched = Boolean(existing);
  due.addEventListener('input', () => { dueTouched = true; });
  issued.addEventListener('change', () => { if (!dueTouched && issued.value) due.value = addDays(issued.value, 14); });
  const paidOn = input('paid_on', { type: 'date', value: r.paid_on || '' });
  const paidField = field('Paid on', paidOn);
  const syncPaid = () => {
    paidField.hidden = status.value !== 'paid';
    paidOn.required = status.value === 'paid';
    if (status.value === 'paid' && !paidOn.value) paidOn.value = today;
  };
  status.addEventListener('change', syncPaid);
  syncPaid();

  const res = await modal({
    title: existing ? 'Edit invoice' : 'Add invoice',
    wide: true,
    confirmLabel: existing ? 'Save invoice' : 'Add invoice',
    body: [
      el('div', { class: 'grid cols-2' },
        field('Client', clientSel),
        field('Project', projectSel)),
      field('Description', input('description', { value: r.description || '', required: true, maxlength: '200', placeholder: 'What the invoice is for' })),
      el('div', { class: 'grid cols-3' },
        field('Amount', amount, reg ? 'As invoiced, including GST.' : 'As invoiced.'),
        reg ? field('GST', gst, 'Filled in as 1/11 of the amount. Change it if needed.')
          : el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'GST'), el('p', { class: 'field-hint money-gst-off' }, 'Not GST registered, so GST is not tracked. Change this on Runway.')),
        field('Kind', select('kind', [{ id: 'one_off', label: 'One-off' }, { id: 'retainer', label: 'Retainer' }], r.kind))),
      el('div', { class: 'grid cols-3' },
        field('Invoice no', input('invoice_no', { value: r.invoice_no || '', maxlength: '40' })),
        field('Issued', issued),
        field('Due', due, existing ? null : '14 days after issue unless you change it.')),
      el('div', { class: 'grid cols-2' }, field('Status', status), paidField),
      field('Notes', textarea('notes', r.notes || '', 'Anything worth remembering'))
    ]
  });
  if (!res) return;
  const amt = r2(res.amount);
  const g = reg ? r2(res.gst) : 0;
  if (g > amt) { toast('GST cannot be more than the amount', 'bad'); return; }
  const row = {
    ...(existing ? { id: existing.id } : {}),
    client_id: res.client_id || null,
    project_id: res.project_id || null,
    description: String(res.description).trim(),
    amount: amt,
    gst: reg ? g : (existing ? existing.gst : 0),
    kind: res.kind,
    status: res.status,
    invoice_no: String(res.invoice_no || '').trim() || null,
    issued_on: res.issued_on || null,
    due_on: res.due_on || null,
    paid_on: res.status === 'paid' ? (res.paid_on || today) : null,
    notes: String(res.notes || '').trim() || null
  };
  try {
    await saveRow('income', row);
    toast(existing ? 'Invoice saved' : 'Invoice added');
  } catch (e) { toast(e.message, 'bad'); }
}

/** Draft a retainer invoice for each active client on a retainer with none this month. */
export async function raiseRetainers() {
  const s = state.settings || {};
  const today = todayIso();
  const due = dueRetainers(state.clients, state.income, today);
  if (!due.length) {
    const any = state.clients.some((c) => c.status === 'active' && !c.archived && n0(c.monthly_value) > 0);
    toast(any ? 'Every active retainer already has an invoice this month' : 'No active clients have a monthly value yet. Set one on the client.', 'info');
    return;
  }
  const nos = nextInvoiceNos(state.income, due.length);
  const res = await modal({
    title: `Raise ${monthLabel(monthKey(today), true)} retainers`,
    confirmLabel: 'Draft invoices',
    wide: true,
    body: [
      el('p', { class: 'muted' }, `These active clients have a monthly value and no retainer invoice issued this month. Each becomes a draft invoice dated today, due in 14 days. Untick any you do not want.`),
      el('div', { class: 'money-checklist', role: 'group', 'aria-label': 'Clients to invoice' }, due.map((c) => {
        const inv = retainerInvoice(c, s, today, '');
        return el('label', { class: 'money-check-row' },
          el('input', { type: 'checkbox', class: 'check', name: 'client', value: c.id, checked: true }),
          el('span', { class: 'money-check-name' }, c.name),
          el('span', { class: 'tnum' }, money2(inv.amount), s.gst_registered ? el('span', { class: 'muted small' }, ` incl. ${money2(inv.gst)} GST`) : null));
      })),
      how(s.gst_registered ? 'The monthly value is treated as before GST; 10% GST is added on top. Invoice numbers continue from your last one.' : 'Each invoice is for the client\'s monthly value. Invoice numbers continue from your last one.')
    ]
  });
  if (!res) return;
  const picked = res.getAll('client');
  if (!picked.length) { toast('No clients ticked, nothing drafted', 'info'); return; }
  let i = 0;
  let made = 0;
  for (const c of due) {
    if (!picked.includes(c.id)) continue;
    try { await saveRow('income', retainerInvoice(c, s, today, nos[i])); made += 1; i += 1; } catch (e) { toast(`${c.name}: ${e.message}`, 'bad'); }
  }
  if (made) toast(`Drafted ${plural(made, 'retainer invoice')}. Mark each sent when it goes out.`);
}
