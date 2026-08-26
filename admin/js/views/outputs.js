// Outputs — the things WiseAI produced and can point a client at.

import { el, icon, dateLabel, badge, modal, field, input, select, textarea,
         toast, confirmDialog, emptyState, titleCase } from '../ui.js';
import { OUTPUT_KINDS, OUTPUT_STATES, clientName, live, archived, today } from '../store.js';

const STATE_TONES = {
  draft: 'warn', ready: 'info', sent: 'info', accepted: 'ok', superseded: ''
};

const KIND_ICONS = {
  proposal: 'invoice', contract: 'invoice', deliverable: 'work',
  demo: 'overview', runbook: 'work', report: 'money', invoice: 'invoice', other: 'inbox'
};

async function openOutput(store, output) {
  const d = store.data;
  const clientOptions = [{ id: '', label: '— internal —' },
    ...live(d.clients).map((c) => ({ id: c.id, label: c.name }))];
  const projectOptions = [{ id: '', label: '— none —' },
    ...live(d.projects).map((p) => ({ id: p.id, label: p.name }))];

  const values = await modal({
    title: output ? 'Edit output' : 'New output',
    body: [
      field('Title', input('title', {
        value: output?.title, required: true,
        placeholder: 'AI visualiser proposal v1' })),
      el('div', { class: 'field-row' },
        field('Kind', select('kind', OUTPUT_KINDS, output?.kind || 'deliverable')),
        field('Status', select('status', OUTPUT_STATES, output?.status || 'draft'))
      ),
      el('div', { class: 'field-row' },
        field('Client', select('clientId', clientOptions, output?.clientId || '')),
        field('Project', select('projectId', projectOptions, output?.projectId || ''))
      ),
      el('div', { class: 'field-row' },
        field('Date', input('date', { type: 'date', value: output?.date || today() })),
        field('Where it lives', input('path', {
          value: output?.path, placeholder: 'documents/proposals/…' }))
      ),
      field('Notes', textarea('notes', output?.notes, 'What it covers, who has seen it…'))
    ],
    confirmLabel: output ? 'Save' : 'Add output'
  });
  if (!values) return;
  if (output) await store.patch('outputs', output.id, values);
  else await store.add('outputs', values);
  toast(output ? 'Output updated.' : 'Output added.');
}

function row(store, output, showArchived) {
  const d = store.data;
  return el('tr', { style: output.archived ? 'opacity:.55' : '' },
    el('td', {},
      el('div', { style: 'display:flex;align-items:center;gap:10px' },
        el('span', { class: 'kind-dot' }, icon(KIND_ICONS[output.kind] || 'inbox', 14)),
        el('div', { style: 'min-width:0' },
          el('div', { style: 'font-weight:600;color:var(--white)' }, output.title),
          output.path
            ? el('div', { class: 'dim', style: 'font-size:11.5px;font-family:ui-monospace,monospace' }, output.path)
            : null))),
    el('td', { class: 'muted', style: 'font-size:12.5px' },
      OUTPUT_KINDS.find((k) => k.id === output.kind)?.label || 'Other'),
    el('td', {}, clientName(d, output.clientId) || el('span', { class: 'dim' }, 'Internal')),
    el('td', {}, badge(OUTPUT_STATES.find((s) => s.id === output.status)?.label || 'Draft',
      STATE_TONES[output.status] ?? '')),
    el('td', { class: 't-num' }, dateLabel(output.date)),
    el('td', {}, el('div', { class: 'row-actions' },
      el('button', { class: 'icon-btn', 'aria-label': `Edit ${output.title}`,
        onClick: () => openOutput(store, output) }, icon('edit')),
      output.archived
        ? el('button', { class: 'icon-btn', 'aria-label': `Restore ${output.title}`,
            onClick: async () => { await store.restore('outputs', output.id); toast('Restored.'); } },
            icon('up'))
        : el('button', { class: 'icon-btn', 'aria-label': `Archive ${output.title}`,
            onClick: async () => { await store.archive('outputs', output.id); toast('Archived.'); } },
            icon('archive')),
      el('button', {
        class: 'icon-btn', 'aria-label': `Delete ${output.title}`,
        onClick: async () => {
          const ok = await confirmDialog('Delete output',
            `Remove "${output.title}" for good? Archiving keeps it out of the way without losing it.`);
          if (ok) { await store.remove('outputs', output.id); toast('Deleted.', 'bad'); }
        }
      }, icon('trash'))
    ))
  );
}

export function outputsView(store, { showArchived = false, kind = 'all' } = {}) {
  const d = store.data;
  const pool = showArchived ? archived(d.outputs) : live(d.outputs);
  const rows = pool
    .filter((o) => kind === 'all' || o.kind === kind)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const kindsPresent = [...new Set(live(d.outputs).map((o) => o.kind))];
  const filters = ['all', ...OUTPUT_KINDS.filter((k) => kindsPresent.includes(k.id)).map((k) => k.id)];

  const needsAction = live(d.outputs).filter((o) => ['draft', 'ready'].includes(o.status));

  return el('div', {},
    el('div', { class: 'topbar' },
      el('div', { class: 'seg', role: 'group', 'aria-label': 'Filter by kind' },
        filters.map((k) => el('button', {
          class: 'seg-btn', type: 'button', 'aria-pressed': String(kind === k),
          onClick: () => store.emitOutputs?.({ kind: k, showArchived })
        }, k === 'all' ? 'All' : OUTPUT_KINDS.find((x) => x.id === k)?.label || titleCase(k)))
      ),
      el('div', { class: 'topbar-actions' },
        el('button', {
          class: `btn btn-sm ${showArchived ? 'btn-primary' : 'btn-ghost'}`,
          onClick: () => store.emitOutputs?.({ kind, showArchived: !showArchived })
        }, icon('archive', 13), showArchived ? 'Viewing archive' : `Archive (${archived(d.outputs).length})`),
        el('button', { class: 'btn btn-primary btn-sm', onClick: () => openOutput(store, null) },
          icon('plus', 13), 'New output')
      )
    ),

    needsAction.length && !showArchived
      ? el('section', { class: 'card section' },
          el('div', { class: 'card-body', style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap' },
            badge(`${needsAction.length} not out the door`, 'warn'),
            el('span', { class: 'muted', style: 'font-size:13px' },
              needsAction.map((o) => o.title).join(' · ')))
        )
      : null,

    el('section', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-head-left' },
          el('h2', {}, showArchived ? 'Archived outputs' : 'Outputs'),
          badge(`${rows.length}`, '')),
        el('span', { class: 'eyebrow' }, 'What we produced')
      ),
      el('div', { class: 'card-body flush' },
        rows.length
          ? el('div', { class: 'table-scroll' }, el('table', {},
              el('thead', {}, el('tr', {},
                el('th', {}, 'Output'), el('th', {}, 'Kind'), el('th', {}, 'Client'),
                el('th', {}, 'Status'), el('th', {}, 'Date'), el('th', {}, ''))),
              el('tbody', { class: 'stagger-in' }, rows.map((o) => row(store, o, showArchived)))
            ))
          : emptyState(
              showArchived ? 'Nothing archived yet.' : 'No outputs recorded yet. Add the first proposal, demo or deliverable.',
              showArchived ? null : 'Add an output',
              () => openOutput(store, null))
      )
    )
  );
}

export { openOutput };
