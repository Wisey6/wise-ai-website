// Library — reference material. The things you consult, not the things you ship.

import { el, icon, dateLabel, badge, modal, field, input, select, textarea,
         toast, confirmDialog, emptyState, titleCase } from '../ui.js';
import { LIBRARY_KINDS, live, archived, today } from '../store.js';

const KIND_TONES = {
  playbook: 'info', standard: 'info', knowledge: '', research: 'warn',
  brand: 'ok', template: '', other: ''
};

async function openEntry(store, entry) {
  const values = await modal({
    title: entry ? 'Edit entry' : 'Add to library',
    body: [
      field('Title', input('title', {
        value: entry?.title, required: true, placeholder: 'Engineering standards' })),
      el('div', { class: 'field-row' },
        field('Kind', select('kind', LIBRARY_KINDS, entry?.kind || 'knowledge')),
        field('Updated', input('date', { type: 'date', value: entry?.date || today() }))
      ),
      field('Where it lives', input('path', {
        value: entry?.path, placeholder: 'company/standards/Engineering-Standards.md' })),
      field('Tags', input('tags', {
        value: entry?.tags, placeholder: 'comma, separated, keywords' })),
      field('What it is for', textarea('notes', entry?.notes,
        'When you would reach for this…'))
    ],
    confirmLabel: entry ? 'Save' : 'Add'
  });
  if (!values) return;
  if (entry) await store.patch('library', entry.id, values);
  else await store.add('library', values);
  toast(entry ? 'Entry updated.' : 'Added to the library.');
}

function entryCard(store, entry) {
  const tags = String(entry.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  return el('article', { class: `lib-card${entry.archived ? ' is-archived' : ''}` },
    el('div', { class: 'lib-head' },
      badge(LIBRARY_KINDS.find((k) => k.id === entry.kind)?.label || 'Other',
        KIND_TONES[entry.kind] ?? ''),
      el('div', { class: 'row-actions' },
        el('button', { class: 'icon-btn', 'aria-label': `Edit ${entry.title}`,
          onClick: () => openEntry(store, entry) }, icon('edit')),
        entry.archived
          ? el('button', { class: 'icon-btn', 'aria-label': `Restore ${entry.title}`,
              onClick: async () => { await store.restore('library', entry.id); toast('Restored.'); } },
              icon('up'))
          : el('button', { class: 'icon-btn', 'aria-label': `Archive ${entry.title}`,
              onClick: async () => { await store.archive('library', entry.id); toast('Archived.'); } },
              icon('archive')),
        el('button', {
          class: 'icon-btn', 'aria-label': `Delete ${entry.title}`,
          onClick: async () => {
            const ok = await confirmDialog('Delete entry',
              `Remove "${entry.title}" for good? Archiving keeps it without cluttering the shelf.`);
            if (ok) { await store.remove('library', entry.id); toast('Deleted.', 'bad'); }
          }
        }, icon('trash'))
      )
    ),
    el('h3', { class: 'lib-title' }, entry.title),
    entry.notes ? el('p', { class: 'lib-note' }, entry.notes) : null,
    entry.path
      ? el('div', { class: 'lib-path', title: entry.path }, entry.path)
      : null,
    tags.length
      ? el('div', { class: 'lib-tags' }, tags.map((t) => el('span', { class: 'tag' }, t)))
      : null,
    entry.date ? el('div', { class: 'lib-date dim' }, dateLabel(entry.date)) : null
  );
}

export function libraryView(store, { showArchived = false, kind = 'all', query = '' } = {}) {
  const d = store.data;
  const pool = showArchived ? archived(d.library) : live(d.library);
  const needle = query.trim().toLowerCase();

  const entries = pool
    .filter((e) => kind === 'all' || e.kind === kind)
    .filter((e) => !needle || `${e.title} ${e.notes} ${e.tags} ${e.path}`.toLowerCase().includes(needle))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const kindsPresent = [...new Set(live(d.library).map((e) => e.kind))];
  const filters = ['all', ...LIBRARY_KINDS.filter((k) => kindsPresent.includes(k.id)).map((k) => k.id)];

  const search = el('input', {
    class: 'input', type: 'search', value: query, placeholder: 'Search the library…',
    'aria-label': 'Search the library', style: 'max-width:260px'
  });
  search.addEventListener('input', () => store.emitLibrary?.({ kind, showArchived, query: search.value }));

  return el('div', {},
    el('div', { class: 'topbar' },
      el('div', { class: 'seg', role: 'group', 'aria-label': 'Filter by kind' },
        filters.map((k) => el('button', {
          class: 'seg-btn', type: 'button', 'aria-pressed': String(kind === k),
          onClick: () => store.emitLibrary?.({ kind: k, showArchived, query })
        }, k === 'all' ? 'All' : LIBRARY_KINDS.find((x) => x.id === k)?.label || titleCase(k)))
      ),
      el('div', { class: 'topbar-actions' },
        search,
        el('button', {
          class: `btn btn-sm ${showArchived ? 'btn-primary' : 'btn-ghost'}`,
          onClick: () => store.emitLibrary?.({ kind, showArchived: !showArchived, query })
        }, icon('archive', 13), showArchived ? 'Viewing archive' : `Archive (${archived(d.library).length})`),
        el('button', { class: 'btn btn-primary btn-sm', onClick: () => openEntry(store, null) },
          icon('plus', 13), 'Add entry')
      )
    ),

    entries.length
      ? el('div', { class: 'lib-grid stagger-in' }, entries.map((e) => entryCard(store, e)))
      : el('section', { class: 'card' },
          emptyState(
            needle ? `Nothing in the library matches "${query}".`
              : showArchived ? 'Nothing archived yet.'
              : 'The library is empty. Add the playbooks, standards and research you keep coming back to.',
            needle || showArchived ? null : 'Add an entry',
            () => openEntry(store, null)))
  );
}

export { openEntry };
