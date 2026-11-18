// Owners: who is responsible for a piece of work. One small, shared vocabulary used
// by every area (tasks, projects, deals, clients, leads, inbox, Today):
//   ownerBadge(id)                 initials in a ring, the name as its label
//   ownerPicker({value, onChange}) one click opens the people; one click picks
//   saveOwner(table, id, ownerId)  saves the owner through the data layer
//   scopeToggle / readScope        the calm "Mine / Everyone" switch, remembered per person
// Names come from state.team (text only, never innerHTML).
import { el, icon, toast } from './ui.js?v=20261118c';
import { state, sb, notify, saveRow, memberById, isMine } from './api.js?v=20261118c';

const TONES = ['blue', 'teal', 'violet', 'amber', 'rose', 'up'];

/** Active people work can be given to, in team order. */
export const activeTeam = () => (state.team || []).filter((m) => m.active !== false);
/** Everyone ever on the team (so old owners still show a name). */
const anyMember = (id) => (id ? memberById(id) : null);

export function initialsOf(m) {
  if (!m) return '';
  const own = String(m.initials || '').trim();
  if (own) return own.slice(0, 3).toUpperCase();
  const w = String(m.name || '').trim().split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] || '') + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase() || '?';
}

/** A stable identity tone per person (their place in the team list). */
export function toneOf(id) {
  const i = (state.team || []).findIndex((m) => m.id === id);
  return i < 0 ? 'mute' : TONES[i % TONES.length];
}

export const meId = () => state.me?.id || null;
export const isMe = (id) => Boolean(id) && id === meId();
export { isMine };

/** "Tyler", "You" for yourself when `you` is set, "Nobody yet" for no owner. */
export function ownerName(id, { you = false } = {}) {
  if (!id) return 'Nobody yet';
  if (you && isMe(id)) return 'You';
  return anyMember(id)?.name || 'Someone who has left';
}

/** Initials in a ring. size: 'sm' (20) | 'md' (26) | 'lg' (40) | 'xl' (64). */
export function ownerBadge(id, { size = 'md', title = true } = {}) {
  const m = anyMember(id);
  const label = id ? `Owner: ${ownerName(id)}` : 'No owner yet';
  return el('span', {
    class: `own-ring is-${size}${id ? ` t-${toneOf(id)}` : ' is-empty'}${isMe(id) ? ' is-me' : ''}`,
    role: 'img', 'aria-label': label, title: title ? (id ? ownerName(id) : 'Nobody yet') : null,
    dataset: { owner: id || '' }
  }, id ? initialsOf(m) || '?' : icon('plus', size === 'sm' ? 11 : 13));
}

/** Ring + name, for headers and lists. */
export function ownerLabel(id, { you = true, size = 'sm' } = {}) {
  return el('span', { class: 'own-label' }, ownerBadge(id, { size, title: false }), el('span', { class: 'own-label-name' }, ownerName(id, { you })));
}

/* ----------------------------------------------------------------- picker */
let openMenu = null;
function closeMenu(focusBack = true) {
  if (!openMenu) return;
  const m = openMenu;
  openMenu = null;
  m.cleanup();
  m.node.remove();
  m.button.setAttribute('aria-expanded', 'false');
  if (focusBack && m.button.isConnected) m.button.focus({ preventScroll: true });
}

/**
 * The owner control. opts:
 *   value       current owner id (or null)
 *   onChange    async (id|null) => void; the picker shows the new owner at once
 *   compact     ring only (tables, task rows); otherwise ring + name
 *   name        also carry a hidden <input name> (for modal forms)
 *   label       accessible name prefix, e.g. 'Owner: Write the replies'
 * Returns the node; node.value and node.setValue(id) read and set it.
 */
export function ownerPicker({ value = null, onChange = null, compact = false, name = null, label = 'Owner', disabled = false } = {}) {
  let cur = value || null;
  const hidden = name ? el('input', { type: 'hidden', name, value: cur || '' }) : null;
  const face = el('span', { class: 'own-face' });
  const btn = el('button', {
    type: 'button', class: `own-pick${compact ? ' is-compact' : ''}`, 'aria-haspopup': 'listbox', 'aria-expanded': 'false',
    disabled: disabled || null, dataset: { ownerPick: '' }
  }, face, compact ? null : icon('chevron', 13));
  const wrap = el('span', { class: 'own-pick-wrap' }, btn, hidden);
  // el() skips null children; replaceChildren does not, so filter.
  const _rc = face.replaceChildren.bind(face);
  face.replaceChildren = (...k) => _rc(...k.filter(Boolean));
  const paint = () => {
    face.replaceChildren(ownerBadge(cur, { size: compact ? 'md' : 'sm', title: false }), compact ? null : el('span', { class: 'own-pick-name' }, ownerName(cur, { you: true })));
    btn.setAttribute('aria-label', `${label}: ${ownerName(cur)}. Change owner`);
    btn.title = `${ownerName(cur)} · change owner`;
    btn.dataset.value = cur || '';
    if (hidden) hidden.value = cur || '';
  };
  paint();

  const choose = async (id) => {
    closeMenu();
    if ((id || null) === cur) return;
    const prev = cur;
    cur = id || null;
    paint();
    if (onChange) {
      try { await onChange(cur); } catch (e) { cur = prev; paint(); toast(e.message || 'Could not change the owner', 'bad'); }
    }
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openMenu?.button === btn) { closeMenu(); return; }
    closeMenu(false);
    const people = activeTeam();
    if (cur && !people.some((p) => p.id === cur) && anyMember(cur)) people.push(anyMember(cur));
    const opts = [...people.map((p) => ({ id: p.id })), { id: null }];
    const items = opts.map((o) => {
      const on = (o.id || null) === cur;
      return el('li', { role: 'option', class: `own-opt${on ? ' is-on' : ''}`, 'aria-selected': String(on), tabindex: '-1', dataset: { id: o.id || '' }, onClick: (ev) => { ev.stopPropagation(); choose(o.id); } },
        ownerBadge(o.id, { size: 'sm', title: false }),
        el('span', { class: 'own-opt-name' }, ownerName(o.id, { you: true })),
        on ? icon('check', 14) : null);
    });
    const list = el('ul', { class: 'own-menu', role: 'listbox', 'aria-label': label }, items);
    document.body.append(list);
    const r = btn.getBoundingClientRect();
    const w = Math.max(200, list.offsetWidth);
    const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    const below = r.bottom + 6 + list.offsetHeight < window.innerHeight - 8;
    list.style.left = `${left}px`;
    list.style.top = below ? `${r.bottom + 6}px` : `${Math.max(8, r.top - 6 - list.offsetHeight)}px`;
    btn.setAttribute('aria-expanded', 'true');
    let idx = Math.max(0, opts.findIndex((o) => (o.id || null) === cur));
    const focusAt = (i) => { idx = (i + items.length) % items.length; items[idx].focus({ preventScroll: true }); };
    const onKey = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeMenu(); }
      else if (ev.key === 'ArrowDown') { ev.preventDefault(); focusAt(idx + 1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); focusAt(idx - 1); }
      else if (ev.key === 'Home') { ev.preventDefault(); focusAt(0); }
      else if (ev.key === 'End') { ev.preventDefault(); focusAt(items.length - 1); }
      else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); choose(opts[idx].id); }
      else if (ev.key === 'Tab') { closeMenu(); }
    };
    const onDown = (ev) => { if (!list.contains(ev.target) && ev.target !== btn && !btn.contains(ev.target)) closeMenu(false); };
    const onScroll = (ev) => { if (!list.contains(ev.target)) closeMenu(false); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    openMenu = {
      node: list, button: btn,
      cleanup: () => {
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('pointerdown', onDown, true);
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onScroll);
      }
    };
    focusAt(idx);
  });
  // Clicks inside table rows must not open the row.
  wrap.addEventListener('click', (e) => e.stopPropagation());

  Object.defineProperty(wrap, 'value', { get: () => cur });
  wrap.setValue = (id) => { if (openMenu?.button !== btn) { cur = id || null; paint(); } };
  return wrap;
}

/* ------------------------------------------------------------------ saving */
const OWNER_TABLES = ['leads', 'deals', 'clients', 'projects', 'tasks'];

/** Save an owner on one record. Leads are patched directly (the lead field list predates owners). */
export async function saveOwner(table, id, ownerId) {
  if (!OWNER_TABLES.includes(table)) throw new Error(`No owner on ${table}`);
  if (table !== 'leads') return saveRow(table, { id, owner_id: ownerId || null });
  const rows = await saveLeadOwners([id], ownerId);
  return rows[0];
}

/** Set the owner on many leads at once. Returns the saved rows. */
export async function saveLeadOwners(ids, ownerId) {
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from('leads').update({ owner_id: ownerId || null }).in('id', ids.slice(i, i + 200)).select();
    if (error) throw new Error(error.message || 'Could not save the owner');
    out.push(...data);
  }
  for (const r of out) {
    const j = state.leads.findIndex((l) => l.id === r.id);
    if (j >= 0) state.leads[j] = { ...state.leads[j], ...r };
  }
  notify();
  return out;
}

/* --------------------------------------------------------- Mine / Everyone */
const scopeKey = (area) => `wiseos.scope.${area}.${meId() || 'anon'}`;
export function readScope(area, fallback = 'mine') {
  try { return localStorage.getItem(scopeKey(area)) || fallback; } catch { return fallback; }
}
export function writeScope(area, v) { try { localStorage.setItem(scopeKey(area), v); } catch { /* private mode */ } }

/** True when a row passes the scope ('mine' = yours or nobody's; 'all' = everything). */
export const inScope = (scope, row) => scope !== 'mine' || isMine(row);

/** A two-way segmented switch. onChange(value). */
export function scopeToggle(area, value, onChange, { label = 'Show' } = {}) {
  const btns = [['mine', 'Mine'], ['all', 'Everyone']].map(([id, text]) => el('button', {
    type: 'button', class: `own-scope-btn${value === id ? ' is-active' : ''}`, 'aria-pressed': String(value === id), dataset: { scope: id },
    onClick: () => {
      if (value === id) return;
      value = id;
      writeScope(area, id);
      btns.forEach((b) => { const on = b.dataset.scope === id; b.classList.toggle('is-active', on); b.setAttribute('aria-pressed', String(on)); });
      onChange(id);
    }
  }, text));
  return el('div', { class: 'own-scope', role: 'group', 'aria-label': label, dataset: { scopeArea: area } }, btns);
}

/**
 * Owner filter for lists: '' (everyone) | 'mine' | 'none' | <member id>.
 * Returns a <select class="input sm own-filter">.
 */
export function ownerFilterSelect(value, onChange, { label = 'Owner' } = {}) {
  const sel = el('select', { class: 'input sm own-filter', name: 'owner-filter', 'aria-label': label },
    el('option', { value: '' }, 'Everyone'),
    el('option', { value: 'mine' }, 'Mine'),
    activeTeam().filter((m) => !isMe(m.id)).map((m) => el('option', { value: m.id }, m.name)),
    el('option', { value: 'none' }, 'Nobody yet'));
  sel.value = value || '';
  if (sel.value !== (value || '')) sel.value = '';
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}
/** Does a row pass an ownerFilterSelect value? 'mine' is strictly yours. */
export function matchesOwner(filter, row) {
  if (!filter) return true;
  if (filter === 'mine') return Boolean(row?.owner_id) && row.owner_id === meId();
  if (filter === 'none') return !row?.owner_id;
  return row?.owner_id === filter;
}
