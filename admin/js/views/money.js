// Money — income ledger, one-off expenses and recurring subscriptions.

import { el, icon, money, dateLabel, dueLabel, daysUntil, badge, modal, field, input,
         select, textarea, toast, confirmDialog, emptyState, titleCase } from '../ui.js';
import { metrics, monthlyCost, clientName, today, incomeMonths } from '../store.js';

const INCOME_TYPES = ['audit', 'retainer', 'build', 'website', 'consulting', 'other'];
const INCOME_STATES = [
  { id: 'paid',     label: 'Paid' },
  { id: 'invoiced', label: 'Invoiced — awaiting payment' },
  { id: 'unbilled', label: 'Unbilled — quoted, not invoiced' }
];
const CYCLES = ['monthly', 'quarterly', 'yearly', 'weekly'];
const CATEGORIES = ['AI / tooling', 'Cloud / email', 'Domain / hosting', 'Software / marketing',
                    'Hardware / asset', 'Finance repayment', 'Govt / registration', 'Other'];

const STATUS_TONES = { paid: 'ok', invoiced: 'warn', unbilled: 'info' };

/* ------------------------------------------------------------------ income */

async function openIncome(store, row) {
  const clientOptions = [{ id: '', label: '— none —' },
    ...store.data.clients.map((c) => ({ id: c.id, label: c.name }))];

  const values = await modal({
    title: row ? 'Edit income' : 'Record income',
    body: [
      el('div', { class: 'field-row' },
        field('Client', select('clientId', clientOptions, row?.clientId || '')),
        field('Type', select('type', INCOME_TYPES, row?.type || 'retainer'))
      ),
      el('div', { class: 'field-row' },
        field('Amount (AUD)', input('amount', { type: 'number', value: row?.amount ?? '', step: '0.01', required: true, placeholder: '190' })),
        field('Status', select('status', INCOME_STATES, row?.status || 'paid'))
      ),
      el('div', { class: 'field-row' },
        field('Date', input('date', { type: 'date', value: row?.date || today() })),
        field('Invoice #', input('invoice', { value: row?.invoice, placeholder: 'INV-004' }))
      ),
      el('div', { class: 'field-row' },
        field('Due date', input('due', { type: 'date', value: row?.due || '' })),
        field('Paid via', input('paidVia', { value: row?.paidVia, placeholder: 'Stripe / bank transfer' }))
      ),
      field('Notes', textarea('notes', row?.notes, 'What this covered…'))
    ],
    confirmLabel: row ? 'Save' : 'Record'
  });
  if (!values) return;
  const record = { ...values, amount: Number(values.amount) || 0 };
  if (row) await store.patch('income', row.id, record);
  else await store.add('income', record);
  toast(row ? 'Income updated.' : 'Income recorded.');
}

/* ---------------------------------------------------------------- expenses */

async function openExpense(store, row) {
  const values = await modal({
    title: row ? 'Edit expense' : 'Add expense',
    body: [
      field('Item', input('item', { value: row?.item, required: true, placeholder: 'Business name registration' })),
      el('div', { class: 'field-row' },
        field('Vendor', input('vendor', { value: row?.vendor, placeholder: 'Registrar' })),
        field('Category', select('category', CATEGORIES, row?.category || 'Other'))
      ),
      el('div', { class: 'field-row' },
        field('Amount (AUD)', input('amount', { type: 'number', value: row?.amount ?? '', step: '0.01', required: true })),
        field('Date', input('date', { type: 'date', value: row?.date || today() }))
      ),
      el('div', { class: 'field-row' },
        field('Paid via', input('paidVia', { value: row?.paidVia, placeholder: 'Business card' })),
        field('Deductible', select('deductible', ['yes', 'no', 'maybe'], row?.deductible || 'yes'))
      ),
      field('Notes', textarea('notes', row?.notes))
    ],
    confirmLabel: row ? 'Save' : 'Add'
  });
  if (!values) return;
  const record = { ...values, amount: Number(values.amount) || 0 };
  if (row) await store.patch('expenses', row.id, record);
  else await store.add('expenses', record);
  toast(row ? 'Expense updated.' : 'Expense added.');
}

/* ----------------------------------------------------------- subscriptions */

async function openSub(store, row) {
  const values = await modal({
    title: row ? 'Edit recurring cost' : 'Add recurring cost',
    body: [
      el('div', { class: 'field-row' },
        field('Item', input('item', { value: row?.item, required: true, placeholder: 'Software subscription' })),
        field('Vendor', input('vendor', { value: row?.vendor, placeholder: 'Vendor' }))
      ),
      el('div', { class: 'field-row' },
        field('Amount (AUD)', input('amount', { type: 'number', value: row?.amount ?? '', step: '0.01', required: true })),
        field('Cycle', select('cycle', CYCLES, row?.cycle || 'monthly'))
      ),
      el('div', { class: 'field-row' },
        field('Category', select('category', CATEGORIES, row?.category || 'AI / tooling')),
        field('Next due', input('nextDue', { type: 'date', value: row?.nextDue }))
      ),
      el('div', { class: 'field-row' },
        field('Paid via', input('paidVia', { value: row?.paidVia, placeholder: 'Business account' })),
        field('Status', select('status', ['active', 'cancelled'], row?.status || 'active'))
      ),
      field('Notes', textarea('notes', row?.notes))
    ],
    confirmLabel: row ? 'Save' : 'Add'
  });
  if (!values) return;
  const record = { ...values, amount: Number(values.amount) || 0 };
  if (row) await store.patch('subscriptions', row.id, record);
  else await store.add('subscriptions', record);
  toast(row ? 'Recurring cost updated.' : 'Recurring cost added.');
}

/* ------------------------------------------------------------------ tables */

function actions(store, collection, row, onEdit, label) {
  return el('div', { class: 'row-actions' },
    el('button', { class: 'icon-btn', 'aria-label': `Edit ${label}`, onClick: () => onEdit(store, row) }, icon('edit')),
    el('button', {
      class: 'icon-btn', 'aria-label': `Delete ${label}`,
      onClick: async () => {
        const ok = await confirmDialog('Delete entry', `Remove "${label}"? This can't be undone.`);
        if (ok) { await store.remove(collection, row.id); toast('Entry removed.', 'bad'); }
      }
    }, icon('trash'))
  );
}

function panel(title, count, addLabel, onAdd, body, control) {
  return el('section', { class: 'card section' },
    el('div', { class: 'card-head' },
      el('div', { class: 'card-head-left' }, el('h2', {}, title), badge(count, ''), control),
      el('button', { class: 'btn btn-ghost btn-sm', onClick: onAdd }, icon('plus', 13), addLabel)
    ),
    el('div', { class: 'card-body flush' }, body)
  );
}

/* -------------------------------------------------------- income rendering */

/**
 * A due date only means something while money is still owed. A paid row is
 * settled and an unbilled row has no invoice to be due, so both read as blank
 * rather than pretending to a deadline. An invoiced row with no due date is
 * called out: that is a term nobody set, and it is why a debt quietly ages.
 */
function dueCell(row) {
  if (row.status !== 'invoiced') return el('span', { class: 'dim' }, '—');
  if (!row.due) return badge('No terms', 'warn');
  const days = daysUntil(row.due);
  return badge(dueLabel(row.due), days < 0 ? 'bad' : days <= 7 ? 'warn' : '');
}

function incomeRow(store, d, row) {
  return el('tr', {},
    el('td', { class: 't-num' }, dateLabel(row.date)),
    el('td', {}, clientName(d, row.clientId) || el('span', { class: 'dim' }, '—')),
    el('td', { class: 'muted' }, titleCase(row.type || 'other')),
    el('td', { class: 'dim', style: 'font-size:12px' }, row.invoice || '—'),
    el('td', {}, dueCell(row)),
    el('td', {}, badge(titleCase(row.status || 'paid'), STATUS_TONES[row.status] ?? '')),
    el('td', { class: 't-right t-num', style: 'font-weight:600' }, money(row.amount, true)),
    el('td', {}, actions(store, 'income', row, openIncome,
      `${clientName(d, row.clientId) || 'entry'} ${money(row.amount)}`))
  );
}

/**
 * One table either way. Grouped by month, the rows sit under a header row
 * carrying that month's gross; flat, they run newest first. Both foot the same
 * all-time gross, so switching the view never moves the total — only how it
 * is broken up. Gross counts paid rows; invoiced and unbilled rows still list,
 * because hiding what you are owed is how it gets forgotten.
 */
function incomeTable(store, d, grossAllTime, byMonth) {
  const groups = byMonth ? incomeMonths(d) : [{
    key: 'all',
    label: '',
    rows: [...d.income].sort((a, b) => (b.date || '').localeCompare(a.date || '')),
    gross: grossAllTime
  }];

  return el('div', { class: 'table-scroll' }, el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}, 'Date'), el('th', {}, 'Client'), el('th', {}, 'Type'),
      el('th', {}, 'Invoice'), el('th', {}, 'Due'), el('th', {}, 'Status'),
      el('th', { class: 't-right' }, 'Amount'), el('th', {}, ''))),
    el('tbody', {}, groups.flatMap((group) => [
      byMonth
        ? el('tr', { class: 'group-row' },
            el('th', { colspan: '6', scope: 'rowgroup' }, group.label),
            el('td', { class: 't-right t-num' }, money(group.gross, true)),
            el('td', {}))
        : null,
      ...group.rows.map((row) => incomeRow(store, d, row))
    ])),
    el('tfoot', {}, el('tr', {},
      el('th', { colspan: '6', scope: 'row' }, 'Gross income — all time'),
      el('td', { class: 't-right t-num' }, money(grossAllTime, true)),
      el('td', {})
    ))
  ));
}

export function moneyView(store, { incomePeriod = 'all' } = {}) {
  const d = store.data;
  const m = metrics(d);

  const income = [...d.income].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const expenses = [...d.expenses].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const subs = [...d.subscriptions].sort((a, b) => monthlyCost(b) - monthlyCost(a));
  const oneOffTotal = expenses.reduce((t, r) => t + (Number(r.amount) || 0), 0);

  return el('div', {},
    el('div', { class: 'stat-row' },
      el('div', { class: 'stat' },
        el('div', { class: 'stat-label' }, icon('wallet', 13), 'Gross income'),
        el('div', { class: 'stat-value' }, el('span', { class: 'num' }, money(m.collected))),
        el('div', { class: 'stat-sub' }, 'Cleared, all time')),
      el('div', { class: 'stat' },
        el('div', { class: 'stat-label' }, icon('invoice', 13), 'Owed to us'),
        el('div', { class: 'stat-value' }, el('span', { class: 'num' }, money(m.outstanding))),
        el('div', { class: 'stat-sub' },
          m.overdueInvoices
            ? badge(`${m.overdueInvoices} overdue · ${money(m.overdueAmount)}`, 'bad')
            : m.undatedInvoices
              ? badge(`${m.undatedInvoices} with no due date`, 'warn')
              : 'Invoiced, unpaid')),
      el('div', { class: 'stat' },
        el('div', { class: 'stat-label' }, icon('alert', 13), 'Unbilled'),
        el('div', { class: 'stat-value' }, el('span', { class: 'num' }, money(m.unbilled))),
        el('div', { class: 'stat-sub' }, 'Quoted, not invoiced')),
      el('div', { class: 'stat' },
        el('div', { class: 'stat-label' }, icon('down', 13), 'Monthly burn'),
        el('div', { class: 'stat-value' }, el('span', { class: 'num' }, money(m.burn))),
        el('div', { class: 'stat-sub' }, `${money(m.burn * 12)} / year`)),
      el('div', { class: 'stat' },
        el('div', { class: 'stat-label' }, icon('money', 13), 'One-off spend'),
        el('div', { class: 'stat-value' }, el('span', { class: 'num' }, money(oneOffTotal))),
        el('div', { class: 'stat-sub' }, `${expenses.length} purchase${expenses.length === 1 ? '' : 's'}`))
    ),

    /* ---- income ---- */
    panel('Income', income.length, 'Record income', () => openIncome(store, null),
      income.length
        ? incomeTable(store, d, m.collected, incomePeriod === 'month')
        : emptyState('No income recorded yet.', 'Record the first payment', () => openIncome(store, null)),
      income.length
        ? el('div', { class: 'seg', role: 'group', 'aria-label': 'Income period' },
            [['all', 'All time'], ['month', 'By month']].map(([key, label]) =>
              el('button', {
                class: 'seg-btn', type: 'button',
                'aria-pressed': String(incomePeriod === key),
                onClick: () => store.emitMoney?.({ incomePeriod: key })
              }, label)))
        : null),

    /* ---- recurring ---- */
    panel('Recurring costs', subs.length, 'Add recurring', () => openSub(store, null),
      subs.length
        ? el('div', { class: 'table-scroll' }, el('table', {},
            el('thead', {}, el('tr', {},
              el('th', {}, 'Item'), el('th', {}, 'Category'), el('th', {}, 'Cycle'),
              el('th', {}, 'Next due'), el('th', { class: 't-right' }, 'Amount'),
              el('th', { class: 't-right' }, 'Per month'), el('th', {}, ''))),
            el('tbody', {}, subs.map((row) => {
              const days = daysUntil(row.nextDue);
              const cancelled = row.status === 'cancelled';
              return el('tr', { style: cancelled ? 'opacity:.5' : '' },
                el('td', {},
                  el('div', { style: 'font-weight:500' }, row.item),
                  el('div', { class: 'dim', style: 'font-size:11.5px' }, row.vendor || '')),
                el('td', { class: 'muted', style: 'font-size:12.5px' }, row.category || '—'),
                el('td', { class: 'muted' }, titleCase(row.cycle || 'monthly')),
                el('td', {}, row.nextDue
                  ? badge(dueLabel(row.nextDue), days < 0 ? 'bad' : days <= 7 ? 'warn' : '')
                  : el('span', { class: 'dim' }, '—')),
                el('td', { class: 't-right t-num' }, money(row.amount, true)),
                el('td', { class: 't-right t-num', style: 'font-weight:600' }, money(monthlyCost(row), true)),
                el('td', {}, actions(store, 'subscriptions', row, openSub, row.item))
              );
            }))
          ))
        : emptyState('No recurring costs tracked yet.', 'Add the first one', () => openSub(store, null))),

    /* ---- one-off ---- */
    panel('One-off purchases & assets', expenses.length, 'Add expense', () => openExpense(store, null),
      expenses.length
        ? el('div', { class: 'table-scroll' }, el('table', {},
            el('thead', {}, el('tr', {},
              el('th', {}, 'Date'), el('th', {}, 'Item'), el('th', {}, 'Category'),
              el('th', {}, 'Paid via'), el('th', {}, 'Deductible'),
              el('th', { class: 't-right' }, 'Amount'), el('th', {}, ''))),
            el('tbody', {}, expenses.map((row) => el('tr', {},
              el('td', { class: 't-num' }, dateLabel(row.date)),
              el('td', {},
                el('div', { style: 'font-weight:500' }, row.item),
                el('div', { class: 'dim', style: 'font-size:11.5px' }, row.vendor || '')),
              el('td', { class: 'muted', style: 'font-size:12.5px' }, row.category || '—'),
              el('td', { class: 'muted', style: 'font-size:12.5px' }, row.paidVia || '—'),
              el('td', {}, badge(titleCase(row.deductible || 'maybe'),
                row.deductible === 'yes' ? 'ok' : row.deductible === 'no' ? '' : 'warn')),
              el('td', { class: 't-right t-num', style: 'font-weight:600' }, money(row.amount, true)),
              el('td', {}, actions(store, 'expenses', row, openExpense, row.item))
            )))
          ))
        : emptyState('No one-off purchases recorded.', 'Add one', () => openExpense(store, null)))
  );
}
