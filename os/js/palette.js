// Wise AI OS command palette: "Search or jump to…" (Ctrl+K / ⌘K).
// Sections, quick actions and a live search of leads. Lead data only ever
// reaches the page as text nodes through el().
import { el, icon, go, STATUS, prettyPhone, trapFocus } from './ui.js?v=20261118c';
import { state, leadName } from './api.js?v=20261118c';

const MAX_LEADS = 8;
const digits = (s) => String(s || '').replace(/\D/g, '');

/**
 * createPalette({ routes, onLock, onTogglePin }) → { open(trigger), close(), isOpen() }
 * routes: live sections [{ id, label, icon, area }].
 */
export function createPalette({ routes, onLock, onTogglePin }) {
  let root = null;
  let input = null;
  let list = null;
  let options = [];
  let sel = 0;
  let returnTo = null;
  let seq = 0;

  const actions = [
    { label: 'Add lead', icon: 'plus', meta: 'Leads', keywords: 'new create person', run: () => go('#leads/new') },
    { label: 'Import leads', icon: 'upload', meta: 'CSV', keywords: 'csv upload spreadsheet', run: () => go('#leads/import') },
    { label: 'Send batch', icon: 'send', meta: 'Campaigns', keywords: 'first texts sms campaign', run: () => go('#campaigns/send') },
    { label: 'Follow-ups due', icon: 'clock', meta: 'Campaigns', keywords: 'follow up reminder', run: () => go('#campaigns/followups') },
    { label: 'Pin or unpin the sidebar', icon: 'panel', meta: '[', keywords: 'sidebar dock collapse expand', desktopOnly: true, run: () => onTogglePin?.() },
    { label: 'Lock', icon: 'lock', meta: 'Sign out', keywords: 'sign out log out', run: () => onLock?.() }
  ];

  const isOpen = () => Boolean(root);

  function score(text, q) {
    const t = String(text || '').toLowerCase();
    if (!q) return 1;
    if (t.startsWith(q)) return 3;
    if (t.split(/\s+/).some((w) => w.startsWith(q))) return 2;
    return t.includes(q) ? 1 : 0;
  }

  function results(raw) {
    const q = raw.trim().toLowerCase();
    const groups = [];
    const sections = routes
      .map((r) => ({ r, s: Math.max(score(r.label, q), q ? score(r.area, q) * 0.5 : 0) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map(({ r }) => ({
        label: r.label, icon: r.icon, meta: r.area || '',
        badge: r.badge === 'unread' ? state.leads.filter((l) => l.unread && !l.archived).length : 0,
        run: () => go(`#${r.id}`)
      }));
    if (sections.length) groups.push({ title: 'Go to', items: sections });

    const acts = actions
      .filter((a) => !a.desktopOnly || window.innerWidth > 760)
      .map((a) => ({ a, s: Math.max(score(a.label, q), q ? score(a.keywords, q) * 0.5 : 0) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map(({ a }) => ({ label: a.label, icon: a.icon, meta: a.meta, run: a.run }));
    if (acts.length) groups.push({ title: 'Actions', items: acts });

    if (q) {
      const qd = digits(q);
      const found = [];
      for (const l of state.leads) {
        let s = Math.max(score(l.business, q) * 2, score(l.contact_name, q) * 1.5, score(l.suburb, q));
        if (qd.length >= 3 && l.phone) {
          const local = `0${digits(l.phone).slice(2)}`;
          if (digits(l.phone).includes(qd) || local.includes(qd)) s = Math.max(s, 2);
        }
        if (s > 0) found.push({ l, s: s - (l.archived ? 0.5 : 0) });
      }
      found.sort((a, b) => b.s - a.s || String(b.l.updated_at || '').localeCompare(String(a.l.updated_at || '')));
      const leads = found.slice(0, MAX_LEADS).map(({ l }) => ({
        label: leadName(l),
        sub: [l.contact_name && l.contact_name !== leadName(l) ? l.contact_name : '', prettyPhone(l.phone), l.suburb].filter(Boolean).join(' · '),
        icon: 'user',
        meta: l.archived ? 'Archived' : (STATUS[l.status]?.label || ''),
        status: l.archived ? '' : (l.status || ''),
        run: () => go(`#leads/${l.id}`)
      }));
      if (leads.length) groups.push({ title: 'Leads', items: leads, more: found.length > MAX_LEADS ? found.length - MAX_LEADS : 0 });
    }
    return groups;
  }

  function select(i, scroll = true) {
    if (!options.length) { input.removeAttribute('aria-activedescendant'); return; }
    sel = (i + options.length) % options.length;
    options.forEach((o, k) => {
      const on = k === sel;
      o.node.classList.toggle('is-sel', on);
      o.node.setAttribute('aria-selected', String(on));
    });
    input.setAttribute('aria-activedescendant', options[sel].node.id);
    if (scroll) options[sel].node.scrollIntoView({ block: 'nearest' });
  }

  function paint() {
    const groups = results(input.value);
    options = [];
    const kids = groups.map((g, gi) => {
      const hid = `pal-g${seq}-${gi}`;
      return el('li', { role: 'presentation', class: 'pal-group' },
        el('div', { class: 'pal-group-label', id: hid, 'aria-hidden': 'true' }, g.title),
        el('ul', { role: 'group', 'aria-labelledby': hid },
          g.items.map((it) => {
            const idx = options.length;
            const node = el('li', {
              role: 'option', id: `pal-o${seq}-${idx}`, class: 'pal-opt', 'aria-selected': 'false',
              onMousemove: () => { if (sel !== idx) select(idx, false); },
              onClick: () => run(idx)
            },
              el('span', { class: 'pal-ic', 'aria-hidden': 'true' }, icon(it.icon, 15)),
              el('span', { class: 'pal-txt' }, el('span', { class: 'pal-label' }, it.label), it.sub ? el('span', { class: 'pal-sub' }, it.sub) : null),
              it.badge ? el('span', { class: 'pal-badge' }, `${it.badge} unread`) : null,
              it.meta ? el('span', { class: `pal-meta${it.status ? ' badge' : ''}`, dataset: it.status ? { status: it.status } : {} },
                it.status ? el('span', { class: 'badge-dot', 'aria-hidden': 'true' }) : null, it.meta) : null);
            options.push({ node, run: it.run });
            return node;
          }),
          g.more ? el('li', { role: 'presentation', class: 'pal-more' }, `${g.more} more match. Refine the search, or open Leads.`) : null));
    });
    list.replaceChildren(...kids);
    const empty = root.querySelector('.pal-empty');
    empty.hidden = options.length > 0;
    if (!options.length) empty.textContent = `Nothing matches “${input.value.trim()}”. Try a business, name, phone or suburb.`;
    input.setAttribute('aria-expanded', String(options.length > 0));
    select(0);
  }

  function run(i) {
    const o = options[i];
    if (!o) return;
    close();
    o.run();
  }

  function onKey(e) {
    if (!root) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopImmediatePropagation(); select(sel + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); select(sel - 1); }
    else if (e.key === 'Home' && e.ctrlKey) { e.preventDefault(); select(0); }
    else if (e.key === 'End' && e.ctrlKey) { e.preventDefault(); select(options.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); run(sel); }
    else if (e.key === 'Tab') { e.stopImmediatePropagation(); trapFocus(e, root.querySelector('.pal-box')); if (document.activeElement === input) e.preventDefault(); }
  }

  function open(trigger) {
    if (root) { input.focus(); return; }
    seq += 1;
    returnTo = trigger && trigger !== document.body ? trigger : document.activeElement;
    input = el('input', {
      class: 'pal-input', type: 'text', placeholder: 'Search or jump to…', autocomplete: 'off', spellcheck: 'false',
      role: 'combobox', 'aria-expanded': 'true', 'aria-controls': `pal-list-${seq}`, 'aria-autocomplete': 'list',
      'aria-label': 'Search or jump to', onInput: () => paint()
    });
    list = el('ul', { class: 'pal-list', role: 'listbox', id: `pal-list-${seq}`, 'aria-label': 'Results' });
    const box = el('div', { class: 'pal-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search or jump to' },
      el('div', { class: 'pal-in' }, icon('search', 17), input, el('kbd', { class: 'pal-esc', 'aria-hidden': 'true' }, 'Esc')),
      list,
      el('p', { class: 'pal-empty', role: 'status', hidden: true }),
      el('div', { class: 'pal-foot', 'aria-hidden': 'true' },
        el('span', {}, el('kbd', {}, '↑'), el('kbd', {}, '↓'), ' to move'),
        el('span', {}, el('kbd', {}, 'Enter'), ' to open'),
        el('span', {}, el('kbd', {}, 'Esc'), ' to close')));
    root = el('div', { class: 'pal', onMousedown: (e) => { if (e.target === root) close(); } }, box);
    window.addEventListener('keydown', onKey, true);
    document.body.append(root);
    paint();
    input.focus();
  }

  function close() {
    if (!root) return;
    window.removeEventListener('keydown', onKey, true);
    const r = root;
    root = null;
    r.classList.add('is-leaving');
    setTimeout(() => r.remove(), 140);
    const back = returnTo;
    returnTo = null;
    if (back && back.isConnected && back.focus) back.focus({ preventScroll: true });
  }

  return { open, close, isOpen };
}
