// Clients — the roster, with per-client money and work rolled up.

import { el, icon, money, dateLabel, badge, modal, field, input, select, textarea,
         toast, confirmDialog, emptyState } from '../ui.js';

const STATUSES = [
  { id: 'active',   label: 'Active' },
  { id: 'prospect', label: 'Prospect' },
  { id: 'building', label: 'Building' },
  { id: 'paused',   label: 'Paused' },
  { id: 'pro-bono', label: 'Pro bono' },
  { id: 'past',     label: 'Past' }
];

const TONES = {
  active: 'ok', building: 'info', prospect: 'warn', paused: '', 'pro-bono': 'info', past: ''
};

function clientForm(client = {}) {
  return [
    el('div', { class: 'field-row' },
      field('Name', input('name', { value: client.name, required: true, placeholder: 'Acme Bowling & Leisure' })),
      field('Client ID', input('code', { value: client.code, placeholder: '1001' }))
    ),
    el('div', { class: 'field-row' },
      field('Status', select('status', STATUSES, client.status || 'prospect')),
      field('MRR (AUD/mo)', input('mrr', { type: 'number', value: client.mrr ?? '', step: '1', placeholder: '190' }))
    ),
    el('div', { class: 'field-row' },
      field('Primary contact', input('contact', { value: client.contact, placeholder: 'Jo & Sam' })),
      field('Email', input('email', { type: 'email', value: client.email, placeholder: 'name@example.com.au' }))
    ),
    el('div', { class: 'field-row' },
      field('Location', input('location', { value: client.location, placeholder: 'Brisbane, QLD' })),
      field('Started', input('started', { type: 'date', value: client.started }))
    ),
    field('What we do for them', textarea('notes', client.notes, 'Bookings, rostering and chatbot…'))
  ];
}

async function openClient(store, client) {
  const values = await modal({
    title: client ? 'Edit client' : 'New client',
    body: clientForm(client || {}),
    confirmLabel: client ? 'Save' : 'Add client'
  });
  if (!values) return;
  const record = { ...values, mrr: Number(values.mrr) || 0 };
  if (client) await store.patch('clients', client.id, record);
  else await store.add('clients', record);
  toast(client ? 'Client updated.' : 'Client added.');
}

/** Money and work totals for one client. */
function rollup(d, clientId) {
  const income = d.income.filter((r) => r.clientId === clientId);
  return {
    collected: income.filter((r) => r.status === 'paid').reduce((t, r) => t + (Number(r.amount) || 0), 0),
    owed: income.filter((r) => r.status === 'invoiced').reduce((t, r) => t + (Number(r.amount) || 0), 0),
    unbilled: income.filter((r) => r.status === 'unbilled').reduce((t, r) => t + (Number(r.amount) || 0), 0),
    openTasks: d.tasks.filter((t) => t.clientId === clientId && t.status !== 'done').length,
    projects: d.projects.filter((p) => p.clientId === clientId).length
  };
}

export function clientsView(store) {
  const d = store.data;

  if (!d.clients.length) {
    return el('section', { class: 'card' },
      emptyState('No clients yet. Add the first one, or import your vault from Settings.',
        'Add a client', () => openClient(store, null)));
  }

  const rows = [...d.clients].sort((a, b) => (Number(b.mrr) || 0) - (Number(a.mrr) || 0));

  return el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', { class: 'card-head-left' },
        el('h2', {}, 'Clients'),
        badge(`${d.clients.length} total`, '')),
      el('button', { class: 'btn btn-primary btn-sm', onClick: () => openClient(store, null) },
        icon('plus', 13), 'New client')
    ),
    el('div', { class: 'card-body flush' },
      el('div', { class: 'table-scroll' },
        el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'Client'),
            el('th', {}, 'Status'),
            el('th', { class: 't-right' }, 'MRR'),
            el('th', { class: 't-right' }, 'Collected'),
            el('th', { class: 't-right' }, 'Owed'),
            el('th', { class: 't-right' }, 'Unbilled'),
            el('th', { class: 't-right' }, 'Open work'),
            el('th', {}, '')
          )),
          el('tbody', {}, rows.map((client) => {
            const r = rollup(d, client.id);
            return el('tr', {},
              el('td', {},
                el('div', { style: 'font-weight:600;color:var(--white)' }, client.name),
                el('div', { class: 'dim', style: 'font-size:11.5px' },
                  [client.code, client.contact, client.location].filter(Boolean).join(' · ') || '—')),
              el('td', {}, badge(STATUSES.find((s) => s.id === client.status)?.label || 'Prospect',
                TONES[client.status] ?? '')),
              el('td', { class: 't-right t-num' },
                Number(client.mrr) ? money(client.mrr) : el('span', { class: 'dim' }, '—')),
              el('td', { class: 't-right t-num' }, money(r.collected)),
              el('td', { class: 't-right t-num' },
                r.owed ? el('span', { style: 'color:var(--warn)' }, money(r.owed)) : el('span', { class: 'dim' }, '—')),
              el('td', { class: 't-right t-num' },
                r.unbilled ? el('span', { style: 'color:var(--info)' }, money(r.unbilled)) : el('span', { class: 'dim' }, '—')),
              el('td', { class: 't-right t-num' },
                r.openTasks ? `${r.openTasks} task${r.openTasks === 1 ? '' : 's'}` : el('span', { class: 'dim' }, '—')),
              el('td', {}, el('div', { class: 'row-actions' },
                el('button', { class: 'icon-btn', 'aria-label': `Edit ${client.name}`, onClick: () => openClient(store, client) }, icon('edit')),
                el('button', {
                  class: 'icon-btn', 'aria-label': `Delete ${client.name}`,
                  onClick: async () => {
                    const ok = await confirmDialog('Delete client',
                      `Remove ${client.name}? Their income, expenses and tasks stay, but lose the link back to this client.`);
                    if (ok) { await store.remove('clients', client.id); toast('Client removed.', 'bad'); }
                  }
                }, icon('trash'))
              ))
            );
          }))
        )
      )
    )
  );
}

export { openClient };
