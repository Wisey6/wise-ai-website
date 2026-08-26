// Pipeline — drag-and-drop deal board.

import { el, icon, money, dateLabel, badge, modal, field, input, select, textarea, toast, emptyState } from '../ui.js';
import { STAGES, metrics, live, archived } from '../store.js';

function dealForm(d, deal = {}) {
  const clientOptions = [{ id: '', label: '— none —' }, ...live(d.clients).map((c) => ({ id: c.id, label: c.name }))];
  return [
    field('Deal', input('name', { value: deal.name, required: true, placeholder: 'Quote calculator build' })),
    el('div', { class: 'field-row' },
      field('Client / prospect', select('clientId', clientOptions, deal.clientId || '')),
      field('Stage', select('stage', STAGES, deal.stage || 'lead'))
    ),
    el('div', { class: 'field-row' },
      field('Value (AUD)', input('value', { type: 'number', value: deal.value ?? '', step: '1', placeholder: '1900' })),
      field('Probability (%)', input('probability', { type: 'number', value: deal.probability ?? '', step: '5', placeholder: '50' }))
    ),
    el('div', { class: 'field-row' },
      field('Next action', input('nextAction', { value: deal.nextAction, placeholder: 'Send proposal' })),
      field('Due', input('due', { type: 'date', value: deal.due }))
    ),
    field('Notes', textarea('notes', deal.notes, 'Context, blockers, what they actually asked for…'))
  ];
}

async function openDeal(store, deal) {
  const values = await modal({
    title: deal ? 'Edit deal' : 'New deal',
    body: dealForm(store.data, deal || {}),
    confirmLabel: deal ? 'Save' : 'Add deal'
  });
  if (!values) return;
  const record = {
    ...values,
    value: Number(values.value) || 0,
    probability: Number(values.probability) || 0
  };
  if (deal) await store.patch('deals', deal.id, record);
  else await store.add('deals', record);
  toast(deal ? 'Deal updated.' : 'Deal added.');
}

function dealCard(store, deal, d) {
  const client = d.clients.find((c) => c.id === deal.clientId);
  const node = el('article', {
    class: 'deal', draggable: 'true', tabindex: '0',
    dataset: { id: deal.id },
    role: 'button', 'aria-label': `${deal.name}, ${money(deal.value)}`
  },
    el('div', { class: 'deal-name' }, deal.name),
    client ? el('div', { class: 'deal-client' }, client.name) : null,
    el('div', { class: 'deal-foot' },
      el('span', { class: 'deal-value' }, money(deal.value)),
      deal.probability ? badge(`${deal.probability}%`, deal.probability >= 70 ? 'ok' : deal.probability >= 40 ? 'warn' : '') : null
    ),
    deal.nextAction
      ? el('div', { class: 'deal-next' },
          el('strong', { style: 'color:var(--chrome);font-weight:600' }, 'Next: '),
          deal.nextAction,
          deal.due ? el('span', { class: 'dim' }, ` · ${dateLabel(deal.due)}`) : null)
      : null,
    el('button', {
      class: 'deal-archive icon-btn', type: 'button',
      'aria-label': `Archive ${deal.name}`, title: 'Archive',
      onClick: async (e) => {
        e.stopPropagation();
        await store.archive('deals', deal.id);
        toast('Deal archived.');
      }
    }, icon('archive', 14))
  );

  node.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', deal.id);
    e.dataTransfer.effectAllowed = 'move';
    node.classList.add('dragging');
  });
  node.addEventListener('dragend', () => node.classList.remove('dragging'));
  node.addEventListener('click', () => openDeal(store, deal));
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDeal(store, deal); }
  });
  return node;
}

export function pipelineView(store) {
  const d = store.data;
  const m = metrics(d);

  const board = el('div', { class: 'kanban' },
    STAGES.map((stage) => {
      const deals = live(d.deals).filter((x) => (x.stage || 'lead') === stage.id);
      const total = deals.reduce((t, x) => t + (Number(x.value) || 0), 0);

      const body = el('div', { class: 'col-body' }, deals.map((deal) => dealCard(store, deal, d)));

      const col = el('div', { class: 'col', dataset: { stage: stage.id } },
        el('div', { class: 'col-head' },
          el('div', {},
            el('span', { class: 'eyebrow' }, stage.label),
            el('div', { class: 'dim', style: 'font-size:11.5px;margin-top:2px' }, money(total))
          ),
          el('span', { class: 'col-count' }, deals.length)
        ),
        body
      );

      col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop-target'); });
      col.addEventListener('dragleave', () => col.classList.remove('drop-target'));
      col.addEventListener('drop', async (e) => {
        e.preventDefault();
        col.classList.remove('drop-target');
        const id = e.dataTransfer.getData('text/plain');
        const deal = live(d.deals).find((x) => x.id === id);
        if (deal && deal.stage !== stage.id) {
          await store.patch('deals', id, { stage: stage.id });
          toast(`Moved to ${stage.label}.`);
        }
      });
      return col;
    })
  );

  return el('div', {},
    el('div', { class: 'stat-row' },
      el('div', { class: 'stat' },
        el('div', { class: 'stat-label' }, icon('pipeline', 13), 'Open pipeline'),
        el('div', { class: 'stat-value' }, el('span', { class: 'num' }, money(m.pipelineValue))),
        el('div', { class: 'stat-sub' }, `${m.openDeals} live deal${m.openDeals === 1 ? '' : 's'}`)),
      el('div', { class: 'stat' },
        el('div', { class: 'stat-label' }, icon('target', 13), 'Weighted'),
        el('div', { class: 'stat-value' }, el('span', { class: 'num' }, money(m.weightedPipeline))),
        el('div', { class: 'stat-sub' }, 'Value × probability')),
      el('div', { class: 'stat' },
        el('div', { class: 'stat-label' }, icon('check', 13), 'Won'),
        el('div', { class: 'stat-value' }, el('span', { class: 'num' },
          money(live(d.deals).filter((x) => x.stage === 'won').reduce((t, x) => t + (Number(x.value) || 0), 0)))),
        el('div', { class: 'stat-sub' }, `${live(d.deals).filter((x) => x.stage === 'won').length} closed`))
    ),
    live(d.deals).length
      ? board
      : el('section', { class: 'card' },
          emptyState('No deals yet. Add the first one to start tracking the pipeline.',
            'Add a deal', () => openDeal(store, null)))
  );
}

export { openDeal };
