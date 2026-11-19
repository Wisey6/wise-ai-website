// Costs: what the business spends. Monthly burn, recurring costs by category,
// one-off purchases by month, cost to serve each client, add / edit / stop, CSV.
import {
  el, fill, icon, badge, toast, modal, confirmDialog, field, input, select, textarea, emptyState,
  money, num, plural, downloadFile, toCsv, busy
} from '../ui.js?v=20261119b';
import { state, saveRow, deleteRow, rowById } from '../api.js?v=20261119b';
import {
  n0, r2, todayIso, monthKey, monthStart, monthLabel, daysBetween, isRecurring, isRunning, monthlyEquivalent,
  monthlyBurn, oneOffs, dueState, rollNextDue, biggestRecurring, clientMargins
} from './money-math.js?v=20261119b';
import { money2, dateFmt, how, kpiStrip, clientLink, pageHead, sectionHead, iconAction, clientOptions } from './money-ui.js?v=20261119b';

export const CATEGORIES = ['Software', 'AI and APIs', 'Telephony', 'Insurance', 'Accounting', 'Marketing', 'Contractors', 'Other'];
const CADENCE = { monthly: 'Monthly', yearly: 'Yearly', one_off: 'One-off' };
const catKey = (c) => String(c.category || 'other').trim().toLowerCase() || 'other';
const catLabel = (k) => CATEGORIES.find((c) => c.toLowerCase() === k) || (k.charAt(0).toUpperCase() + k.slice(1));
const catOrder = (k) => { const i = CATEGORIES.findIndex((c) => c.toLowerCase() === k); return i < 0 ? CATEGORIES.length - 1.5 : i; };
const clientOf = (c) => (c.client_id ? rowById('clients', c.client_id) : null);
/** A recurring cost that is not running: switched off, ended, or not started yet. */
const stopped = (c, today) => isRecurring(c) && !isRunning(c, today);

/* ================================================================ view */
export default function costsView(ctx) {
  const { state: st, param } = ctx;
  const root = el('div', { class: 'page money-page costs-page' });

  if (param) {
    history.replaceState(null, '', '#costs');
    if (param === 'new') setTimeout(() => openCost(null), 0);
    else if (param === 'one-off') setTimeout(() => openCost(null, { cadence: 'one_off' }), 0);
    else if (/^[0-9a-f-]{36}$/i.test(param)) setTimeout(() => (rowById('costs', param) ? openCost(param) : toast('That cost no longer exists', 'warn')), 0);
  }

  const exportBtn = el('button', { type: 'button', class: 'btn btn-ghost', onClick: () => exportCsv() }, icon('download', 16), 'Export CSV');
  root.append(pageHead('Money', 'Costs', null, [
    exportBtn,
    el('button', { type: 'button', class: 'btn btn-ghost', onClick: () => openCost(null, { cadence: 'one_off' }) }, icon('plus', 16), 'One-off purchase'),
    el('button', { type: 'button', class: 'btn btn-primary', onClick: () => openCost(null) }, icon('plus', 16), 'Add cost')
  ]));
  const body = el('div', { class: 'money-body' });
  root.append(body);

  function paint() {
    const today = todayIso();
    exportBtn.disabled = !st.costs.length;
    if (!st.costs.length) {
      fill(body, el('div', { class: 'money-empty' }, emptyState({
        icon: 'money', title: 'No costs yet',
        text: 'Start with the subscriptions you pay every month: software, phone, AI services, insurance. Your monthly burn and runway are worked out from them.',
        action: el('div', { class: 'row' },
          el('button', { type: 'button', class: 'btn btn-primary', onClick: () => openCost(null) }, icon('plus', 16), 'Add your first cost'),
          el('button', { type: 'button', class: 'btn btn-ghost', onClick: () => openCost(null, { cadence: 'one_off' }) }, 'Add a one-off purchase'))
      })));
      return;
    }
    fill(body, kpis(today), recurring(today), ended(today), oneOffList(today), serve(today));
  }

  function kpis(today) {
    const burn = monthlyBurn(st.costs, today);
    const running = st.costs.filter((c) => isRunning(c, today));
    const mk = monthKey(today);
    const once = oneOffs(st.costs, monthStart(mk), `${mk}-31`);
    const onceCount = st.costs.filter((c) => c.cadence === 'one_off' && monthKey(c.incurred_on) === mk).length;
    const top = biggestRecurring(st.costs, today, 3);
    return el('section', { class: 'section money-section' }, kpiStrip([
      { id: 'burn', label: 'Monthly burn', value: money(burn), sub: plural(running.length, 'recurring cost'),
        how: 'Running recurring costs; yearly ones count as a twelfth each month.' },
      { id: 'yearly', label: 'Recurring per year', value: money(burn * 12), sub: `${money(burn)} × 12`, how: 'Monthly burn over a full year.' },
      { id: 'oneoff', label: 'One-offs this month', value: money(once), sub: plural(onceCount, 'purchase'), how: `One-off purchases dated in ${monthLabel(mk, true)}.` },
      { id: 'top', label: 'Biggest three', value: top.length ? el('ol', { class: 'money-top' }, top.map((c) => el('li', {},
        el('span', { class: 'truncate' }, c.name), el('span', { class: 'tnum' }, `${money2(r2(monthlyEquivalent(c)))}/mo`)))) : '—',
        how: burn > 0 && top.length ? `${Math.round((top.reduce((t, c) => t + monthlyEquivalent(c), 0) / burn) * 100)}% of your monthly burn.` : 'Your largest recurring costs.' }
    ], 'has-list'));
  }

  function costRow(c, today, { stoppedRow = false } = {}) {
    const ds = stoppedRow ? null : dueState(c, today);
    const days = c.next_due ? daysBetween(today, c.next_due) : 0;
    const client = clientOf(c);
    const acts = el('div', { class: 'money-row-acts' },
      ds === 'overdue' || ds === 'soon' ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', title: 'Paid: move the next due date on by one period',
        onClick: (e) => busy(e.currentTarget, () => patch(c.id, { next_due: rollNextDue(c) }, `Next due ${dateFmt(rollNextDue(c))}`)) }, icon('check', 13), 'Paid') : null,
      iconAction('edit', `Edit ${c.name}`, () => openCost(c.id)),
      stoppedRow
        ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: (e) => busy(e.currentTarget, () => patch(c.id, { active: true, ended_on: null }, `${c.name} restarted`)) }, icon('refresh', 13), 'Restart')
        : iconAction('ban', `Stop ${c.name}`, () => stopCost(c.id)),
      stoppedRow ? iconAction('trash', `Delete ${c.name}`, () => removeCost(c.id), 'is-danger') : null);
    return el('tr', { dataset: { id: c.id }, class: stoppedRow ? 'is-void' : '' },
      el('td', { class: 'money-name' },
        el('button', { type: 'button', class: 'money-name-btn', onClick: () => openCost(c.id) }, c.name),
        el('span', { class: 'money-sub' }, c.vendor || (stoppedRow ? '' : ' '), stoppedRow ? stoppedNote(c, today) : null)),
      el('td', { class: 'muted' }, CADENCE[c.cadence]),
      el('td', { class: 'num' }, money2(c.amount)),
      el('td', { class: 'num' }, el('b', {}, money2(r2(monthlyEquivalent(c))))),
      el('td', { class: 'nowrap' }, c.next_due && !stoppedRow
        ? el('span', { class: ds === 'overdue' ? 'money-late' : '' }, dateFmt(c.next_due),
          ds === 'overdue' ? el('span', { class: 'money-sub' }, `${plural(-days, 'day')} overdue`) : ds === 'soon' ? el('span', { class: 'money-sub' }, days === 0 ? 'today' : `in ${plural(days, 'day')}`) : null)
        : el('span', { class: 'faint' }, '—')),
      el('td', {}, clientLink(client)),
      el('td', { class: 'money-acts-cell' }, acts));
  }

  const head = () => el('thead', {}, el('tr', {}, el('th', {}, 'Cost'), el('th', {}, 'Cadence'), el('th', { class: 'num' }, 'Amount'),
    el('th', { class: 'num' }, 'Per month'), el('th', {}, 'Next due'), el('th', {}, 'Client'), el('th', {}, el('span', { class: 'sr-only' }, 'Actions'))));

  function recurring(today) {
    const rows = st.costs.filter((c) => isRunning(c, today));
    const groups = new Map();
    for (const c of rows) { const k = catKey(c); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
    const keys = [...groups.keys()].sort((a, b) => catOrder(a) - catOrder(b) || a.localeCompare(b));
    const burn = monthlyBurn(st.costs, today);
    const section = el('section', { class: 'section money-section' },
      sectionHead('Recurring', `${money(burn)} a month`, el('span', { class: 'muted' }, plural(rows.length, 'cost'))));
    if (!rows.length) {
      section.append(el('div', { class: 'empty money-none' }, el('p', { class: 'muted' }, 'No recurring costs running. Add the subscriptions you pay each month or year.'),
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => openCost(null) }, icon('plus', 13), 'Add a recurring cost')));
      return section;
    }
    section.append(el('div', { class: 'table-wrap' }, el('table', { class: 'table money-table money-costs' }, head(),
      keys.map((k) => {
        const list = groups.get(k).sort((a, b) => monthlyEquivalent(b) - monthlyEquivalent(a));
        const tot = list.reduce((t, c) => t + monthlyEquivalent(c), 0);
        return el('tbody', { dataset: { category: k } },
          el('tr', { class: 'money-group' }, el('th', { colspan: 3, scope: 'colgroup' }, catLabel(k)), el('th', { class: 'num' }, money2(r2(tot))), el('th', { colspan: 3 })),
          list.map((c) => costRow(c, today)));
      }))),
    how('Per month is the amount for monthly costs and a twelfth of yearly ones. Next due turns amber within a week and is flagged once it passes.'));
    return section;
  }

  function ended(today) {
    const rows = st.costs.filter((c) => stopped(c, today)).sort((a, b) => String(b.ended_on || '').localeCompare(String(a.ended_on || '')));
    if (!rows.length) return null;
    return el('section', { class: 'section money-section' },
      el('details', { class: 'money-details' }, el('summary', {}, `Stopped or not started yet (${num(rows.length)})`),
        el('div', { class: 'table-wrap' }, el('table', { class: 'table money-table money-costs' }, head(), el('tbody', {}, rows.map((c) => costRow(c, today, { stoppedRow: true }))))),
        how('These do not count in your monthly burn. Restart one to count it again.')));
  }

  function oneOffList(today) {
    const rows = st.costs.filter((c) => c.cadence === 'one_off').sort((a, b) => String(b.incurred_on || '').localeCompare(String(a.incurred_on || '')));
    const section = el('section', { class: 'section money-section' },
      sectionHead('One-off purchases', 'By month', el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => openCost(null, { cadence: 'one_off' }) }, icon('plus', 13), 'Add')));
    if (!rows.length) {
      section.append(el('p', { class: 'muted money-pad' }, 'Nothing bought outright yet. A laptop, a course or a one-off contractor bill goes here, and counts only in the month it was bought.'));
      return section;
    }
    const months = new Map();
    for (const c of rows) { const k = monthKey(c.incurred_on) || 'undated'; if (!months.has(k)) months.set(k, []); months.get(k).push(c); }
    section.append(el('div', { class: 'table-wrap' }, el('table', { class: 'table money-table money-oneoffs' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Purchase'), el('th', {}, 'Category'), el('th', {}, 'Date'), el('th', { class: 'num' }, 'Amount'), el('th', {}, 'Client'), el('th', {}, el('span', { class: 'sr-only' }, 'Actions')))),
      [...months.entries()].map(([k, list]) => el('tbody', {},
        el('tr', { class: 'money-group' }, el('th', { colspan: 3, scope: 'colgroup' }, k === 'undated' ? 'No date' : monthLabel(k, true), k === monthKey(today) ? el('span', { class: 'muted' }, ' · this month') : null),
          el('th', { class: 'num' }, money2(list.reduce((t, c) => t + n0(c.amount), 0))), el('th', { colspan: 2 })),
        list.map((c) => el('tr', { dataset: { id: c.id } },
          el('td', { class: 'money-name' }, el('button', { type: 'button', class: 'money-name-btn', onClick: () => openCost(c.id) }, c.name), el('span', { class: 'money-sub' }, c.vendor || ' ')),
          el('td', { class: 'muted' }, catLabel(catKey(c))),
          el('td', { class: 'nowrap' }, dateFmt(c.incurred_on) || '—'),
          el('td', { class: 'num' }, el('b', {}, money2(c.amount))),
          el('td', {}, clientLink(clientOf(c))),
          el('td', { class: 'money-acts-cell' }, el('div', { class: 'money-row-acts' },
            iconAction('edit', `Edit ${c.name}`, () => openCost(c.id)),
            iconAction('trash', `Delete ${c.name}`, () => removeCost(c.id), 'is-danger'))))))))));
    return section;
  }

  function serve(today) {
    const rows = clientMargins(st.clients, st.costs, today);
    if (!rows.length) return null;
    return el('section', { class: 'section money-section', 'aria-label': 'Cost to serve each client' },
      sectionHead('Cost to serve', 'What each client costs you to look after'),
      el('div', { class: 'table-wrap' }, el('table', { class: 'table money-table money-serve' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Client'), el('th', { class: 'num' }, 'Retainer'), el('th', { class: 'num' }, 'Linked costs'), el('th', { class: 'num' }, 'Margin'), el('th', { class: 'num' }, 'Margin %'))),
        el('tbody', {}, rows.map((m) => el('tr', { dataset: { client: m.id } },
          el('td', {}, m.client ? clientLink(m.client) : el('span', { class: 'muted' }, 'A deleted client'), el('span', { class: 'money-sub' }, plural(m.count, 'linked cost'))),
          el('td', { class: 'num' }, `${money2(m.value)}/mo`),
          el('td', { class: 'num' }, `${money2(m.cost)}/mo`),
          el('td', { class: 'num' }, el('b', { class: m.margin < 0 ? 'money-neg' : '' }, `${m.margin < 0 ? '−' : ''}${money2(Math.abs(m.margin))}`)),
          el('td', { class: 'num' }, m.pct === null ? '—' : el('span', { class: m.pct < 0 ? 'money-neg' : 'muted' }, `${Math.round(m.pct * 100)}%`))))))),
      how('Margin = the client\'s monthly value less the running recurring costs linked to them. Your own time is not counted.'));
  }

  function exportCsv() {
    const today = todayIso();
    const rows = [...st.costs].sort((a, b) => (isRecurring(b) - isRecurring(a)) || String(a.name).localeCompare(String(b.name)));
    if (!rows.length) return;
    downloadFile(`costs-${today}.csv`, toCsv(rows.map((c) => ({
      name: c.name, vendor: c.vendor || '', category: catLabel(catKey(c)), cadence: CADENCE[c.cadence], amount: r2(c.amount),
      per_month: isRecurring(c) ? r2(monthlyEquivalent(c)) : '', running: isRecurring(c) ? (isRunning(c, today) ? 'yes' : 'no') : '',
      started_on: c.started_on || '', ended_on: c.ended_on || '', incurred_on: c.incurred_on || '', next_due: c.next_due || '',
      client: clientOf(c)?.name || '', notes: c.notes || ''
    }))));
    toast(`Exported ${plural(rows.length, 'cost')}`);
  }

  paint();
  root.onState = paint;
  return root;
}

function stoppedNote(c, today) {
  const sep = c.vendor ? ' · ' : '';
  if (c.started_on && c.started_on > today) return `${sep}starts ${dateFmt(c.started_on)}`;
  if (c.ended_on) return `${sep}${c.ended_on > today ? 'ends' : 'stopped'} ${dateFmt(c.ended_on)}`;
  return `${sep}switched off`;
}

/* ============================================================ actions */
async function patch(id, change, msg) {
  try { await saveRow('costs', { id, ...change }); if (msg) toast(msg); } catch (e) { toast(e.message, 'bad'); }
}

async function stopCost(id) {
  const c = rowById('costs', id);
  if (!c) return;
  const res = await modal({
    title: `Stop ${c.name}`,
    confirmLabel: 'Stop this cost',
    body: [
      el('p', { class: 'muted' }, 'It stays on record and stops counting in your monthly burn from this date. You can restart it later.'),
      field('Stopped on', input('ended_on', { type: 'date', value: todayIso(), required: true }))
    ]
  });
  if (!res) return;
  await patch(id, { active: false, ended_on: res.ended_on }, `${c.name} stopped`);
}

async function removeCost(id) {
  const c = rowById('costs', id);
  if (!c) return;
  const ok = await confirmDialog('Delete this cost?', `${c.name} will be removed for good.${isRecurring(c) ? ' To keep the history, stop it instead.' : ''}`);
  if (!ok) return;
  try { await deleteRow('costs', id); toast('Cost deleted'); } catch (e) { toast(e.message, 'bad'); }
}

/** Add (id null) or edit a cost. preset fills a new one, e.g. {cadence: 'one_off'}. */
export async function openCost(id, preset = {}) {
  const existing = id ? rowById('costs', id) : null;
  if (id && !existing) { toast('That cost no longer exists', 'warn'); return; }
  const today = todayIso();
  const c = existing || { name: '', vendor: '', category: 'Software', amount: '', cadence: 'monthly', started_on: today, next_due: '', incurred_on: today, client_id: '', notes: '', ...preset };
  const listId = `money-cats-${Math.random().toString(36).slice(2, 8)}`;
  const known = [...new Set([...CATEGORIES, ...state.costs.map((x) => catLabel(catKey(x)))])];
  const cadence = select('cadence', [{ id: 'monthly', label: 'Monthly' }, { id: 'yearly', label: 'Yearly' }, { id: 'one_off', label: 'One-off purchase' }], c.cadence);
  const recurringBits = el('div', { class: 'grid cols-2' },
    field('Started', input('started_on', { type: 'date', value: c.started_on || '' }), 'Counts from this date.'),
    field('Next due', input('next_due', { type: 'date', value: c.next_due || '' }), 'Optional. Flagged when it is close or passed.'));
  const oneOffBits = field('Bought on', input('incurred_on', { type: 'date', value: c.incurred_on || today }), 'Counts in this month only.');
  const sync = () => {
    const once = cadence.value === 'one_off';
    recurringBits.hidden = once;
    oneOffBits.hidden = !once;
    oneOffBits.querySelector('input').required = once;
  };
  cadence.addEventListener('change', sync);
  sync();
  const res = await modal({
    title: existing ? 'Edit cost' : c.cadence === 'one_off' ? 'Add a one-off purchase' : 'Add a cost',
    wide: true,
    confirmLabel: existing ? 'Save cost' : 'Add cost',
    body: [
      el('div', { class: 'grid cols-2' },
        field('Name', input('name', { value: c.name || '', required: true, maxlength: '120', placeholder: 'e.g. Twilio numbers' })),
        field('Vendor', input('vendor', { value: c.vendor || '', maxlength: '120', placeholder: 'Who you pay' }))),
      el('div', { class: 'grid cols-3' },
        field('Amount', input('amount', { type: 'number', value: c.amount === '' ? '' : r2(c.amount), required: true, min: '0', step: '0.01', inputmode: 'decimal', placeholder: '0.00' }), 'What you pay each time.'),
        field('Cadence', cadence),
        field('Category', el('span', {}, input('category', { value: c.category ? catLabel(catKey(c)) : '', list: listId, maxlength: '60', required: true }),
          el('datalist', { id: listId }, known.map((k) => el('option', { value: k })))))),
      recurringBits,
      oneOffBits,
      field('Client', select('client_id', clientOptions(state.clients, 'Not for a particular client'), c.client_id || ''), 'Link it when the cost exists to serve one client, so their margin shows.'),
      field('Notes', textarea('notes', c.notes || '', 'Plan, login owner, renewal terms'))
    ]
  });
  if (!res) return;
  const once = res.cadence === 'one_off';
  const row = {
    ...(existing ? { id: existing.id } : {}),
    name: String(res.name).trim(),
    vendor: String(res.vendor || '').trim() || null,
    category: String(res.category || '').trim() || 'Other',
    amount: r2(res.amount),
    cadence: res.cadence,
    started_on: once ? null : (res.started_on || null),
    next_due: once ? null : (res.next_due || null),
    incurred_on: once ? (res.incurred_on || today) : null,
    client_id: res.client_id || null,
    notes: String(res.notes || '').trim() || null
  };
  if (!existing) row.active = true;
  try {
    await saveRow('costs', row);
    toast(existing ? 'Cost saved' : 'Cost added');
  } catch (e) { toast(e.message, 'bad'); }
}
