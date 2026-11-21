// Lead scout: businesses the scout found on the public web that fit the owner's brief, waiting
// for a yes or no. Approving adds the business to Leads and does nothing else; skipping keeps it
// out (with an optional reason the scout learns from). Nothing is ever sent to a business.
//
// The page is drawn once and then updated in place (node.onState), so live changes elsewhere in
// the hub never rebuild it. Data comes from the `agent` function's scout doors (scout-api.js);
// the count on Today and in the sidebar comes from the live agent_actions cards ('lead.add').
//
// Decisions in place: an approved or skipped card closes into a one-line receipt where it was,
// with Open lead and Undo. A skip waits a few seconds before it is saved (Undo puts the card
// back untouched); picking a reason saves it at once. Keyboard: arrows (or J/K) move, A approves,
// S skips, X selects, U undoes the latest.
//
// Settings (the panel at the top): the on/off switch, the brief, how many a day, the days and
// time, the scout's own monthly budget, Run now and the last run. Changing them and Run now are
// for the owner; a team member sees them read-only and can still review.
import { el, icon, toast, fill, confirmDialog, timeAgo, plural, num, money, prettyPhone } from '../ui.js?v=20261119b';
import { state, undoChange, notify } from '../api.js?v=20261119b';
import { scoutStatus, scoutCandidates, scoutDecide, scoutSettings, scoutRun, scoutStamp, lastScoutRun, scoutMessage, SCOUT_KIND } from '../scout-api.js?v=20261119b';
import { navigate, reducedMotion } from '../motion.js?v=20261119b';
import { spotRecord } from '../spot.js?v=20261119b';
import { usd, safeUrl } from './agents.js?v=20261119b';

export const SAFE_LINE = 'Nothing is sent to these businesses. Approving only adds them to Leads.';
const FILTERS = [['proposed', 'To review'], ['approved', 'Approved'], ['rejected', 'Skipped']];
const SKIP_REASONS = ['Not a fit', 'Too big', 'Wrong area', 'A chain or franchise', 'Already know them'];
const SKIP_WAIT_MS = 8000;
const PAGE = 30;
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const isOwner = () => state.me?.role === 'owner';
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const str = (v) => typeof v === 'string' && v.trim() !== '';

/* ------------------------------------------------------------ module state (survives re-renders) */
const S = {
  filter: 'proposed',
  lists: {},                 // filter → {items, next, error, loading, at}
  status: null,              // scout_status answer
  statusErr: null,
  canCap: false,
  selected: new Set(),
  focusId: null,
  receipts: new Map(),       // candidate id → receipt (this visit's decisions, shown in place)
  order: [],                 // receipt ids, newest last (for U)
  pending: new Map(),        // candidate id → {timer, reason}
  run: null,                 // {at, timer} while running, or {done:true, res}
  editing: false,
  stamp: null
};

/* ------------------------------------------------------------ small helpers */
function hourLabel(h) {
  const n = Number(h);
  if (!Number.isInteger(n)) return '';
  if (n === 0) return 'midnight';
  if (n === 12) return 'noon';
  return `${((n + 11) % 12) + 1} ${n >= 12 ? 'pm' : 'am'}`;
}
/** "Weekdays at 7 am" */
export function scheduleText(s) {
  const days = [...new Set((Array.isArray(s?.scout_days) ? s.scout_days : [1, 2, 3, 4, 5]).map(Number))].sort();
  const d = days.join(',');
  const which = d === '1,2,3,4,5' ? 'Weekdays' : d === '1,2,3,4,5,6,7' ? 'Every day' : d === '6,7' ? 'Weekends' : days.length ? days.map((x) => DAY_NAMES[x - 1]).join(', ') : 'No days chosen';
  return `${which} at ${hourLabel(s?.scout_hour ?? 7)}`;
}
const phoneKind = (k) => (k === 'mobile' ? 'Mobile' : k === 'landline' ? 'Office line' : 'Phone');
/** Write text only when it changed (no layout work for nothing). */
const setText = (n, t) => { if (n && n.textContent !== t) n.textContent = t; };

/** Animate the moves of `nodes` after `change()` runs (transform only). */
function flip(nodes, change) {
  if (reducedMotion()) { change(); return; }
  const before = new Map(nodes.filter((n) => n.isConnected).map((n) => [n, n.getBoundingClientRect().top]));
  change();
  for (const [n, top] of before) {
    if (!n.isConnected) continue;
    const dy = top - n.getBoundingClientRect().top;
    if (Math.abs(dy) > 0.5) n.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.16,1,.3,1)' });
  }
}

/* ------------------------------------------------------------ data */
async function loadStatus() {
  const [st, set] = await Promise.all([scoutStatus(), scoutSettings()]);
  if (st.ok) { S.status = st; S.statusErr = null; } else S.statusErr = st.message;
  if (set.ok) { S.canCap = Boolean(set.can_change_cap); if (S.status) S.status.settings = { ...S.status.settings, ...set.settings }; }
  return st;
}
async function loadList(filter, { more = false } = {}) {
  const cur = S.lists[filter] || { items: [], next: null };
  S.lists[filter] = { ...cur, loading: true, error: null };
  const r = await scoutCandidates({ status: filter, limit: PAGE, before: more ? cur.next : undefined });
  if (!r.ok) { S.lists[filter] = { ...cur, loading: false, error: r.message }; return r; }
  const items = Array.isArray(r.items) ? r.items : [];
  const merged = more ? [...cur.items, ...items.filter((i) => !cur.items.some((x) => x.id === i.id))] : items;
  S.lists[filter] = { items: merged, next: r.next_before || null, loading: false, error: null, at: Date.now() };
  return r;
}

/* ================================================================== the page */
export default function scoutView() {
  const live = el('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const say = (t) => { live.textContent = ''; setTimeout(() => { live.textContent = t; }, 30); };

  /* ---------------------------------------------------------- head */
  const runBtn = el('button', { type: 'button', class: 'btn btn-primary btn-sm sc-run', dataset: { act: 'run' } }, icon('search', 15), el('span', {}, 'Run now'));
  runBtn.addEventListener('click', () => runNow());
  const head = el('div', { class: 'page-head sc-head' },
    el('div', { class: 'stack' },
      el('p', { class: 'eyebrow' }, 'Grow'),
      el('h1', { class: 'h1' }, 'Lead scout'),
      el('p', { class: 'sc-lede' }, 'Local businesses that fit your brief, found on the public web. You decide which ones become leads.')),
    el('div', { class: 'sc-head-acts' }, runBtn));

  /* ---------------------------------------------------------- settings panel */
  const panel = settingsPanel();

  /* ---------------------------------------------------------- filters + toolbar */
  const tabs = el('div', { class: 'tabs sc-tabs', role: 'tablist', 'aria-label': 'Show' });
  const tabBtns = FILTERS.map(([id, label]) => {
    const count = el('span', { class: 'count tnum' });
    const b = el('button', { type: 'button', class: 'tab', role: 'tab', id: `sc-tab-${id}`, 'aria-controls': 'sc-list', dataset: { filter: id } }, label, count);
    b.addEventListener('click', () => setFilter(id));
    b.addEventListener('keydown', (e) => {
      const i = FILTERS.findIndex((f) => f[0] === id);
      const to = e.key === 'ArrowRight' ? (i + 1) % FILTERS.length : e.key === 'ArrowLeft' ? (i + FILTERS.length - 1) % FILTERS.length : -1;
      if (to < 0) return;
      e.preventDefault(); e.stopPropagation();
      setFilter(FILTERS[to][0]);
      tabBtns[to].b.focus();
    });
    tabs.append(b);
    return { id, b, count };
  });
  const allBox = el('input', { type: 'checkbox', class: 'check', 'aria-label': 'Select all to review', dataset: { act: 'select-all' } });
  allBox.addEventListener('change', () => {
    const ids = pendingIds();
    if (allBox.checked) ids.forEach((id) => S.selected.add(id)); else S.selected.clear();
    paintSelection();
  });
  const keysHint = el('p', { class: 'sc-keys small faint', 'aria-hidden': 'true' },
    el('kbd', {}, 'A'), ' approve', el('span', { class: 'sc-dot' }, '·'), el('kbd', {}, 'S'), ' skip', el('span', { class: 'sc-dot' }, '·'),
    el('kbd', {}, 'X'), ' select', el('span', { class: 'sc-dot' }, '·'), el('kbd', {}, '↑'), el('kbd', {}, '↓'), ' move');
  const toolbar = el('div', { class: 'sc-toolbar' },
    el('label', { class: 'check-row sc-all' }, allBox, el('span', {}, 'Select all')),
    el('span', { class: 'spacer' }), keysHint);

  /* ---------------------------------------------------------- bulk bar */
  const bulkCount = el('b', { class: 'tnum' });
  const bulkApprove = el('button', { type: 'button', class: 'btn btn-sm sc-bulk-ok', dataset: { act: 'approve-selected' } }, icon('check', 14), el('span', {}, 'Approve selected'));
  const bulkSkip = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { act: 'skip-selected' } }, 'Skip selected');
  const bulkClear = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Clear selection', dataset: { act: 'clear' } }, icon('x', 16));
  bulkApprove.addEventListener('click', () => approve([...S.selected]));
  bulkSkip.addEventListener('click', () => skip([...S.selected]));
  bulkClear.addEventListener('click', () => { S.selected.clear(); paintSelection(); });
  const bulk = el('div', { class: 'bulk-bar sc-bulk', role: 'region', 'aria-label': 'Selected businesses', hidden: true }, bulkCount, el('span', { class: 'spacer' }), bulkSkip, bulkApprove, bulkClear);

  /* ---------------------------------------------------------- the list */
  const list = el('ul', { class: 'sc-list', id: 'sc-list', role: 'list', 'aria-label': 'Businesses' });
  const listWrap = el('div', { class: 'sc-list-wrap', role: 'tabpanel' }, list);
  const more = el('button', { type: 'button', class: 'btn btn-ghost btn-sm sc-more', hidden: true }, 'Show more');
  more.addEventListener('click', async () => {
    more.disabled = true;
    await loadList(S.filter, { more: true });
    more.disabled = false;
    paintList();
  });
  const cards = new Map(); // id → li (cards and receipts)

  const node = el('div', { class: 'page sc-page', dataset: { scout: '' } },
    head, panel.node, el('div', { class: 'sc-review' }, el('div', { class: 'sc-bar' }, tabs, toolbar), bulk, listWrap, more), live);

  /* ---------------------------------------------------------- painting */
  const pendingIds = () => (S.filter === 'proposed' ? (S.lists.proposed?.items || []).filter((c) => !S.receipts.has(c.id)).map((c) => c.id) : []);

  /** How many wait for review: the server's count, less skips not saved yet. */
  const waitingNow = () => {
    if (S.status && Number.isFinite(Number(S.status.waiting))) return Math.max(0, Number(S.status.waiting) - S.pending.size);
    return S.lists.proposed && !S.lists.proposed.loading ? pendingIds().length : null;
  };
  function paintTabs() {
    const waiting = waitingNow();
    for (const t of tabBtns) {
      const on = t.id === S.filter;
      t.b.classList.toggle('is-active', on);
      t.b.setAttribute('aria-selected', String(on));
      t.b.tabIndex = on ? 0 : -1;
      const n = t.id === 'proposed' ? waiting : null;
      setText(t.count, n ? ` ${num(n)}` : '');
    }
    listWrap.setAttribute('aria-labelledby', `sc-tab-${S.filter}`);
    const reviewing = S.filter === 'proposed' && pendingIds().length > 0;
    toolbar.hidden = !reviewing;
  }

  function paintSelection() {
    for (const id of [...S.selected]) if (!pendingIds().includes(id)) S.selected.delete(id);
    const n = S.selected.size;
    bulk.hidden = n === 0;
    setText(bulkCount, `${num(n)} selected`);
    bulkApprove.lastChild.textContent = n > 1 ? `Approve ${num(n)}` : 'Approve';
    bulkSkip.textContent = n > 1 ? `Skip ${num(n)}` : 'Skip';
    const ids = pendingIds();
    allBox.checked = ids.length > 0 && n === ids.length;
    allBox.indeterminate = n > 0 && n < ids.length;
    for (const [id, li] of cards) {
      const box = li.querySelector('.sc-pick');
      if (box) box.checked = S.selected.has(id);
      li.classList.toggle('is-selected', S.selected.has(id));
    }
  }

  function emptyFor(filter) {
    const st = S.status?.settings || {};
    if (filter === 'proposed') {
      const decidedNow = [...S.receipts.values()].length;
      return el('li', { class: 'sc-empty', dataset: { empty: 'proposed' } },
        el('span', { class: 'sc-empty-mark', 'aria-hidden': 'true' }, icon(decidedNow ? 'check' : 'search', 22)),
        el('p', { class: 'empty-title' }, decidedNow ? 'All reviewed' : 'Nothing to review'),
        el('p', { class: 'muted' }, st.scout_enabled
          ? `The scout looks again ${scheduleText(st).replace(/^\w/, (c) => c.toLowerCase())}. New businesses that fit your brief wait here for you.`
          : 'The scout is off. Switch it on to look each morning, or run it once now.'),
        isOwner() && !S.run?.at ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { act: 'run-empty' }, onClick: () => runNow() }, icon('search', 14), 'Run now') : null);
    }
    const [title, text] = filter === 'approved'
      ? ['Nothing approved yet', 'Businesses you approve go straight to Leads, and are listed here too.']
      : ['Nothing skipped', 'Businesses you skip are listed here with your reason. The scout reads your reasons and brings fewer like them.'];
    return el('li', { class: 'sc-empty', dataset: { empty: filter } },
      el('span', { class: 'sc-empty-mark', 'aria-hidden': 'true' }, icon(filter === 'approved' ? 'leads' : 'archive', 22)),
      el('p', { class: 'empty-title' }, title), el('p', { class: 'muted' }, text));
  }

  let listKey = null;
  function paintList({ force = false } = {}) {
    const L = S.lists[S.filter];
    paintTabs();
    if (!L || (L.loading && !L.items.length)) {
      const k = `loading:${S.filter}`;
      if (k === listKey && !force) return;
      listKey = k;
      cards.clear();
      list.setAttribute('aria-busy', 'true');
      fill(list, [0, 1, 2].map(() => el('li', { class: 'sc-card is-skel', 'aria-hidden': 'true' },
        el('div', { class: 'skeleton', style: 'height:18px;width:38%' }), el('div', { class: 'skeleton', style: 'height:12px;width:24%' }),
        el('div', { class: 'skeleton', style: 'height:44px;width:86%' }))));
      more.hidden = true;
      return;
    }
    list.removeAttribute('aria-busy');
    if (L.error && !L.items.length) {
      const k = `error:${S.filter}:${L.error}`;
      if (k === listKey && !force) return;
      listKey = k;
      cards.clear();
      fill(list, el('li', { class: 'sc-empty is-error', role: 'alert' },
        el('span', { class: 'sc-empty-mark', 'aria-hidden': 'true' }, icon('alert', 22)),
        el('p', { class: 'empty-title' }, 'Could not load the list'),
        el('p', { class: 'muted' }, L.error),
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { act: 'retry' }, onClick: async () => { S.lists[S.filter] = null; paintList(); await loadList(S.filter); paintList(); } }, icon('refresh', 14), 'Try again')));
      more.hidden = true;
      return;
    }
    const items = L.items;
    const k = `${S.filter}|${items.map((c) => `${c.id}:${c.status}:${c.lead_id || ''}`).join(',')}`;
    more.hidden = !L.next;
    if (k === listKey && !force) { paintSelection(); return; }
    listKey = k;
    const keep = new Set(items.map((c) => c.id));
    for (const id of [...cards.keys()]) if (!keep.has(id)) cards.delete(id);
    const hadCards = cards.size > 0;
    const nodes = items.map((c) => {
      const existing = cards.get(c.id);
      if (existing && existing.dataset.v === stampOf(c)) return existing;
      const n = S.receipts.has(c.id) ? receiptRow(c) : S.filter === 'proposed' ? reviewCard(c) : decidedCard(c);
      if (hadCards) n.classList.add('is-arriving');
      cards.set(c.id, n);
      return n;
    });
    if (!items.length) { cards.clear(); fill(list, emptyFor(S.filter)); }
    else {
      // Everything reviewed: a quiet end line after the receipts.
      const want = S.filter === 'proposed' && !pendingIds().length && !L.next ? [...nodes, doneNode()] : nodes;
      // Keep nodes that stay (no flicker), replace the rest, in order.
      [...list.children].forEach((ch) => { if (!want.includes(ch)) ch.remove(); });
      want.forEach((n, i) => { if (list.children[i] !== n) list.insertBefore(n, list.children[i] || null); });
    }
    paintSelection();
    rove();
  }
  let doneEl = null;
  function doneNode() {
    const k = `${S.status?.settings?.scout_enabled}|${isOwner()}|${Boolean(S.run?.at)}`;
    if (!doneEl || doneEl.dataset.k !== k) { doneEl = emptyFor('proposed'); doneEl.dataset.k = k; }
    return doneEl;
  }
  const stampOf = (c) => `${c.status}:${c.lead_id || ''}:${S.receipts.get(c.id)?.v || ''}`;

  /* ---------------------------------------------------------- one card to review */
  function reviewCard(c) {
    const nameId = `sc-n-${c.id}`;
    const pick = el('input', { type: 'checkbox', class: 'check sc-pick', 'aria-label': `Select ${c.business}` });
    pick.addEventListener('change', () => { if (pick.checked) S.selected.add(c.id); else S.selected.delete(c.id); paintSelection(); });
    const ok = el('button', { type: 'button', class: 'btn btn-primary btn-sm', dataset: { act: 'approve' }, 'aria-describedby': nameId }, icon('check', 14), 'Approve');
    const no = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { act: 'skip' }, 'aria-describedby': nameId }, 'Skip');
    ok.addEventListener('click', () => approve([c.id]));
    no.addEventListener('click', () => skip([c.id]));
    const err = el('p', { class: 'sc-err', role: 'alert', hidden: true });
    const li = el('li', { class: 'sc-card', tabIndex: -1, dataset: { id: c.id, v: stampOf(c) }, 'aria-labelledby': nameId },
      el('div', { class: 'sc-pickcell' }, pick),
      cardBody(c, nameId),
      el('div', { class: 'sc-acts' }, no, ok),
      err);
    li.addEventListener('focus', () => { S.focusId = c.id; rove(); });
    li.addEventListener('click', (e) => {
      if (e.target.closest('a, button, input, label')) return;
      S.focusId = c.id; rove(); li.focus({ preventScroll: true });
    });
    return li;
  }

  /** What the scout found: name, what they do, where, why it fits, the sources, how to reach them. */
  function cardBody(c, nameId) {
    const obs = (Array.isArray(c.observations) ? c.observations : []).filter((o) => str(o?.text));
    const site = safeUrl(c.website);
    const numberAt = safeUrl(c.number_source_url);
    // Pages it read, one per site, leaving out the business's own site (shown as Website).
    const seen = new Set(site ? [hostOf(site)] : []);
    const sources = [...obs.map((o) => safeUrl(o.source_url)), numberAt].filter((u) => u && !seen.has(hostOf(u)) && seen.add(hostOf(u)));
    const meta = [c.industry, c.suburb].filter(str);
    const score = Number.isFinite(Number(c.score)) ? Math.max(0, Math.min(100, Math.round(Number(c.score)))) : null;
    const value = Number(c.est_monthly_value) > 0 ? Number(c.est_monthly_value) : null;
    return el('div', { class: 'sc-body' },
      el('div', { class: 'sc-title' },
        el('h3', { class: 'sc-name', id: nameId }, c.business),
        score !== null ? el('span', { class: `sc-fit${score >= 70 ? ' is-high' : score < 45 ? ' is-low' : ''}`, title: 'How well it fits your brief, out of 100' },
          el('span', { class: 'sc-fit-bar', 'aria-hidden': 'true' }, el('i', { style: `transform:scaleX(${score / 100})` })),
          el('span', { class: 'tnum' }, `Fit ${score}`)) : null),
      meta.length ? el('p', { class: 'sc-meta' }, meta.join(' · ')) : null,
      el('div', { class: 'sc-why' },
        str(c.score_reason) ? el('p', { class: 'sc-reason' }, c.score_reason) : null,
        obs.length ? el('ul', { class: 'sc-obs' }, obs.map((o) => {
          const u = safeUrl(o.source_url);
          return el('li', {}, el('span', {}, o.text), u ? el('a', { class: 'sc-src', href: u, target: '_blank', rel: 'noopener noreferrer', title: u }, hostOf(u), icon('external', 11)) : null);
        })) : null,
        str(c.pain) || value ? el('p', { class: 'sc-pain' },
          str(c.pain) ? el('span', {}, c.pain) : null,
          value ? el('span', { class: 'sc-value', title: str(c.value_reasoning) ? c.value_reasoning : null }, ` Worth about ${money(value)} a month to them.`) : null) : null),
      el('dl', { class: 'sc-facts' },
        c.contact_first_name ? fact('Contact', c.contact_first_name) : null,
        c.phone ? fact(phoneKind(c.phone_kind), el('span', { class: 'tnum' }, prettyPhone(c.phone))) : null,
        site ? fact('Website', el('a', { href: site, target: '_blank', rel: 'noopener noreferrer' }, hostOf(site), icon('external', 11))) : null,
        sources.length ? fact(sources.length === 1 ? 'Source' : 'Sources', el('span', { class: 'sc-srcs' }, sources.map((u) => el('a', { class: 'sc-src', href: u, target: '_blank', rel: 'noopener noreferrer', title: u }, hostOf(u), icon('external', 11))))) : null,
        str(c.hook) ? fact('Opening line', el('span', { class: 'sc-hook' }, c.hook)) : null));
  }
  const fact = (k, v) => el('div', { class: 'sc-fact' }, el('dt', {}, k), el('dd', {}, v));

  /* ---------------------------------------------------------- approved / skipped lists */
  function decidedCard(c) {
    const when = c.decided_at ? timeAgo(c.decided_at) : '';
    const via = c.decided_via === 'email' ? 'from the email' : c.decided_via === 'chat' ? 'in the assistant' : c.decided_via === 'system' ? 'by the hub' : '';
    let side;
    if (c.status === 'approved') {
      side = c.lead_id
        ? openLead(c.lead_id, c.business)
        : el('span', { class: 'small faint' }, 'Lead removed');
    } else {
      side = str(c.reject_reason) ? el('span', { class: 'sc-why-skip small muted' }, c.reject_reason) : el('span', { class: 'small faint' }, 'No reason given');
    }
    return el('li', { class: `sc-row is-${c.status}`, dataset: { id: c.id, v: stampOf(c) } },
      el('span', { class: `sc-row-dot is-${c.status}`, 'aria-hidden': 'true' }),
      el('span', { class: 'sc-row-main' },
        el('span', { class: 'sc-row-name' }, c.business),
        el('span', { class: 'sc-row-meta' }, [[c.industry, c.suburb].filter(str).join(' · '), [when, via].filter(Boolean).join(' ')].filter(Boolean).join(' · '))),
      el('span', { class: 'sc-row-side' }, side));
  }

  function openLead(leadId, name) {
    const hash = `#leads/${leadId}`;
    return el('a', { class: 'sc-open', href: hash, dataset: { act: 'open-lead' }, 'aria-label': `Open lead: ${name}`, onClick: (e) => {
      if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) { e.preventDefault(); navigate(hash); }
      spotRecord({ table: 'leads', id: leadId, hash });
    } }, 'Open lead', icon('arrow', 12));
  }

  /* ---------------------------------------------------------- receipts (a decision, in place) */
  function receiptRow(c) {
    const r = S.receipts.get(c.id);
    const verb = { added: 'Added to Leads', undone: 'Undone', undoing: 'Undoing…', skipped: 'Skipped', skipping: 'Skipped', dup: 'Already in Leads', opted: 'Not added', decided: 'Already decided', failed: 'Not saved' }[r.state] || 'Done';
    const tone = { added: 'add', skipped: 'skip', skipping: 'skip', undone: 'mute', undoing: 'mute', dup: 'mute', decided: 'mute', opted: 'bad', failed: 'bad' }[r.state] || 'mute';
    const kids = [];
    if (r.state === 'added' && r.leadId) kids.push(openLead(r.leadId, c.business));
    if (r.state === 'dup' && r.leadId) kids.push(openLead(r.leadId, c.business));
    if (r.state === 'added' && r.changeId) kids.push(el('button', { type: 'button', class: 'sc-undo', dataset: { act: 'undo' }, onClick: () => undo(c.id) }, 'Undo'));
    if (r.state === 'skipping') kids.push(el('button', { type: 'button', class: 'sc-undo', dataset: { act: 'undo' }, onClick: () => undo(c.id) }, 'Undo'));
    if (r.state === 'failed') kids.push(el('button', { type: 'button', class: 'sc-undo', dataset: { act: 'retry' }, onClick: () => restore(c.id) }, 'Show it again'));
    const reasons = r.state === 'skipping'
      ? el('span', { class: 'sc-reasons', role: 'group', 'aria-label': `Why skip ${c.business}? Optional` },
        el('span', { class: 'sc-reasons-q' }, 'Why?'),
        SKIP_REASONS.map((t) => el('button', { type: 'button', class: 'chip sc-reason-chip', dataset: { reason: t }, onClick: () => commitSkips([c.id], t) }, t)))
      : null;
    const note = r.note || (r.state === 'skipped' && r.reason ? r.reason : r.state === 'undone' ? 'The lead was removed.' : '');
    const li = el('li', { class: `sc-receipt is-${tone}${r.state === 'skipping' ? ' is-pending' : ''}`, dataset: { id: c.id, v: stampOf(c), receipt: r.state }, tabIndex: -1 },
      el('span', { class: 'sc-receipt-line' },
        el('span', { class: `sc-verb is-${tone}` }, el('span', { class: 'sc-verb-dot', 'aria-hidden': 'true' }), verb),
        el('span', { class: 'sc-receipt-name' }, c.business),
        note ? el('span', { class: 'sc-receipt-note' }, note) : null,
        el('span', { class: 'sc-receipt-acts' }, kids)),
      reasons,
      r.state === 'skipping' ? el('span', { class: 'sc-timer', 'aria-hidden': 'true', style: `animation-duration:${SKIP_WAIT_MS}ms` }) : null);
    return li;
  }

  function setReceipt(id, patch) {
    const prev = S.receipts.get(id) || {};
    S.receipts.set(id, { ...prev, ...patch, v: (prev.v || 0) + 1 });
    if (!S.order.includes(id)) S.order.push(id);
  }

  /** Replace cards for ids with their receipts (cards below glide up), then move focus on. */
  function swap(ids, { moveFocus = true } = {}) {
    const all = [...list.children];
    const firstIdx = Math.min(...ids.map((id) => all.indexOf(cards.get(id))).filter((i) => i >= 0));
    flip(all, () => paintList({ force: true }));
    if (moveFocus) {
      const next = [...list.children].slice(Number.isFinite(firstIdx) ? firstIdx : 0).find((n) => n.classList.contains('sc-card'))
        || [...list.children].reverse().find((n) => n.classList.contains('sc-card'));
      if (next) { S.focusId = next.dataset.id; rove(); if (node.contains(document.activeElement) || document.activeElement === document.body) next.focus({ preventScroll: false }); }
      else {
        S.focusId = null;
        if (!pendingIds().length) refreshCounts();
        const r = [...list.children].reverse().find((n) => n.classList.contains('sc-receipt'));
        r?.focus({ preventScroll: true });
      }
    }
  }

  /* ---------------------------------------------------------- decisions */
  async function approve(ids) {
    ids = ids.filter((id) => pendingIds().includes(id));
    if (!ids.length) return;
    for (const id of ids) { S.selected.delete(id); markBusy(id, true); }
    const res = await scoutDecide(ids, 'approve');
    const results = Array.isArray(res.results) ? res.results : [{ candidate_id: ids[0], ...res }];
    const done = [];
    let added = 0;
    for (const r of results) {
      const id = r.candidate_id || ids[0];
      markBusy(id, false);
      if (r.ok && r.status === 'approved') { setReceipt(id, { state: 'added', leadId: r.lead_id || null, changeId: r.change_id || null }); added++; done.push(id); }
      else if (r.error === 'duplicate') { setReceipt(id, { state: 'dup', leadId: r.lead_id || null, note: 'Nothing was added.' }); done.push(id); }
      else if (r.error === 'suppressed') { setReceipt(id, { state: 'opted', note: 'This number opted out of contact.' }); done.push(id); }
      else if (r.error === 'already_decided') { setReceipt(id, { state: 'decided', note: r.status === 'approved' ? 'It was approved elsewhere.' : 'It was skipped elsewhere.', leadId: r.lead_id || null }); done.push(id); }
      else if (r.error === 'not_found') { setReceipt(id, { state: 'decided', note: 'It is no longer in the queue.' }); done.push(id); }
      else cardError(id, r.message || scoutMessage(r));
    }
    if (done.length) { swap(done); closeCards(done, 'applied'); }
    if (added) {
      say(added === 1 ? `Added ${nameOf(done[0])} to Leads.` : `Added ${added} businesses to Leads.`);
      S.lists.approved = null;
      bumpWaiting(-done.length);
    }
  }

  function skip(ids) {
    ids = ids.filter((id) => pendingIds().includes(id));
    if (!ids.length) return;
    for (const id of ids) {
      S.selected.delete(id);
      const timer = setTimeout(() => commitSkips([id], null), SKIP_WAIT_MS);
      S.pending.set(id, { timer });
      setReceipt(id, { state: 'skipping' });
    }
    swap(ids);
    say(ids.length === 1 ? `Skipped ${nameOf(ids[0])}. Undo is available for a few seconds.` : `Skipped ${ids.length}. Undo is available for a few seconds.`);
  }

  /** Save skips now (their timer ran out, a reason was picked, or the page is closing). */
  async function commitSkips(ids, reason) {
    ids = ids.filter((id) => S.pending.has(id));
    if (!ids.length) return;
    for (const id of ids) { clearTimeout(S.pending.get(id).timer); S.pending.delete(id); setReceipt(id, { state: 'skipped', reason: reason || null }); }
    if (node.isConnected) swap(ids, { moveFocus: false });
    const res = await scoutDecide(ids, 'reject', reason || undefined);
    const results = Array.isArray(res.results) ? res.results : [{ candidate_id: ids[0], ...res }];
    const failed = [];
    for (const r of results) {
      const id = r.candidate_id || ids[0];
      if (r.ok || r.error === 'already_decided' || r.error === 'not_found') continue;
      failed.push(id);
      setReceipt(id, { state: 'failed', note: r.message || scoutMessage(r) });
    }
    if (failed.length && node.isConnected) swap(failed, { moveFocus: false });
    if (failed.length) toast(failed.length === 1 ? 'A skip was not saved. It is still waiting for review.' : `${failed.length} skips were not saved. They are still waiting for review.`, 'bad');
    S.lists.rejected = null;
    closeCards(ids.filter((id) => !failed.includes(id)), 'rejected');
    bumpWaiting(-(ids.length - failed.length));
    if (reason) say(`Skipped, with the reason ${reason}.`);
  }

  async function undo(id) {
    const r = S.receipts.get(id);
    if (!r) return;
    if (r.state === 'skipping') {
      clearTimeout(S.pending.get(id)?.timer);
      S.pending.delete(id);
      restore(id);
      say(`${nameOf(id)} is back in the list.`);
      return;
    }
    if (r.state !== 'added' || !r.changeId) return;
    setReceipt(id, { state: 'undoing' });
    swap([id], { moveFocus: false });
    const res = await undoChange(r.changeId);
    if (res.ok || res.error === 'already_undone') {
      setReceipt(id, { state: 'undone', leadId: null, note: 'The lead was removed.' });
      say(`Undone. ${nameOf(id)} was removed from Leads.`);
      S.lists.approved = null;
    } else {
      setReceipt(id, { state: 'added' });
      toast(res.detail || res.message || 'Could not undo that.', 'bad');
    }
    swap([id], { moveFocus: false });
    cards.get(id)?.focus({ preventScroll: true });
  }

  /** Put a card back for review (skip undone, or a skip that did not save). */
  function restore(id) {
    S.receipts.delete(id);
    S.order = S.order.filter((x) => x !== id);
    swap([id], { moveFocus: false });
    S.focusId = id;
    rove();
    cards.get(id)?.focus({ preventScroll: true });
  }

  function markBusy(id, on) {
    const li = cards.get(id);
    if (!li) return;
    li.classList.toggle('is-busy', on);
    li.setAttribute('aria-busy', String(on));
    for (const b of li.querySelectorAll('.sc-acts button')) b.disabled = on;
    const ok = li.querySelector('[data-act=approve]');
    if (ok) ok.classList.toggle('is-busy', on);
  }
  function cardError(id, msg) {
    const li = cards.get(id);
    const err = li?.querySelector('.sc-err');
    if (err) { err.textContent = msg; err.hidden = false; }
    toast(msg, 'bad');
  }
  const nameOf = (id) => (S.lists.proposed?.items || []).find((c) => c.id === id)?.business || 'That business';
  /** Close the decided cards' hub rows here too, so the sidebar and Today count down at once
   *  (realtime brings the same change a moment later). */
  function closeCards(ids, status) {
    let n = 0;
    for (const a of state.agent_actions || []) {
      if (a.kind === SCOUT_KIND && a.status === 'proposed' && ids.includes(a.payload?.candidate_id)) { a.status = status; n++; }
    }
    if (!n) return;
    S.stamp = scoutStamp();
    notify('agent_actions');
  }
  function bumpWaiting(d) { if (S.status) S.status.waiting = Math.max(0, (S.status.waiting || 0) + d); paintTabs(); panel.paint(); }

  /* ---------------------------------------------------------- filters */
  async function setFilter(id) {
    if (S.filter === id) return;
    await commitSkips([...S.pending.keys()], null);
    S.filter = id;
    S.selected.clear();
    S.focusId = null;
    settleReceipts();
    listKey = null;
    paintList();
    if (!S.lists[id] || Date.now() - (S.lists[id].at || 0) > 15000) { await loadList(id); if (S.filter === id) paintList(); }
  }

  /** Decisions from earlier leave the review list; a skip that did not save comes back as a card. */
  function settleReceipts() {
    if (S.pending.size) return;
    const P = S.lists.proposed;
    if (P) P.items = P.items.filter((c) => !S.receipts.has(c.id) || S.receipts.get(c.id).state === 'failed');
    S.receipts.clear();
    S.order = [];
  }

  async function refreshCounts() { await loadStatus(); panel.paint(); paintTabs(); }

  /* ---------------------------------------------------------- keyboard (roving focus over the cards) */
  function rove() {
    const cardsNow = [...list.querySelectorAll(':scope > .sc-card:not(.is-skel)')];
    if (!cardsNow.length) return;
    if (!cardsNow.some((n) => n.dataset.id === S.focusId)) S.focusId = cardsNow[0].dataset.id;
    for (const n of cardsNow) {
      const on = n.dataset.id === S.focusId;
      n.tabIndex = on ? 0 : -1;
      n.classList.toggle('is-focus', on);
    }
  }
  list.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest('input[type=text], textarea, select')) return;
    const card = e.target.closest('.sc-card, .sc-receipt');
    if (!card) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const cardsNow = [...list.querySelectorAll(':scope > .sc-card:not(.is-skel), :scope > .sc-receipt')];
    const i = cardsNow.indexOf(card);
    const id = card.dataset.id;
    const isCard = card.classList.contains('sc-card');
    if (k === 'ArrowDown' || k === 'j' || k === 'ArrowUp' || k === 'k') {
      e.preventDefault();
      const step = k === 'ArrowDown' || k === 'j' ? 1 : -1;
      const to = cardsNow[Math.max(0, Math.min(cardsNow.length - 1, i + step))];
      if (to) { if (to.classList.contains('sc-card')) { S.focusId = to.dataset.id; rove(); } to.focus(); }
      return;
    }
    if (k === 'Home' || k === 'End') { e.preventDefault(); const to = k === 'Home' ? cardsNow[0] : cardsNow[cardsNow.length - 1]; if (to) { if (to.classList.contains('sc-card')) { S.focusId = to.dataset.id; rove(); } to.focus(); } return; }
    if (k === 'u') { e.preventDefault(); undoLatest(); return; }
    if (!isCard || card.classList.contains('is-busy')) return;
    if (k === 'a') { e.preventDefault(); approve([id]); }
    else if (k === 's') { e.preventDefault(); skip([id]); }
    else if (k === 'x' || (k === ' ' && e.target === card)) {
      e.preventDefault();
      if (S.selected.has(id)) S.selected.delete(id); else S.selected.add(id);
      paintSelection();
    }
  });
  function undoLatest() {
    for (let j = S.order.length - 1; j >= 0; j--) {
      const r = S.receipts.get(S.order[j]);
      if (r && (r.state === 'skipping' || (r.state === 'added' && r.changeId))) { undo(S.order[j]); return; }
    }
  }

  /* ---------------------------------------------------------- run now */
  async function runNow() {
    if (S.run?.at || !isOwner()) return;
    const st = S.status?.settings || {};
    const runs = (state.agent_runs || []).filter((r) => r.agent === 'scout' && Number(r.cost_usd) > 0);
    const avg = runs.length ? runs.reduce((t, r) => t + Number(r.cost_usd), 0) / runs.length : 0.15;
    const count = Math.max(1, Math.min(6, Number(st.scout_daily_max) || 5));
    const ok = await confirmDialog('Look for businesses now?',
      `The scout searches the web for up to ${count} businesses that fit your brief and checks each one’s own page. It takes a minute or two and costs about ${usd(avg)} from its budget. ${SAFE_LINE}`,
      { confirmLabel: 'Run now', danger: false });
    if (!ok) return;
    S.run = { at: Date.now() };
    panel.paint();
    paintHeadRun();
    const res = await scoutRun({ count });
    S.run = { done: true, res, ms: Date.now() - S.run.at };
    paintHeadRun();
    if (res.ok) {
      say(res.kept ? `The scout found ${plural(res.kept, 'business', 'businesses')} that fit.` : 'The scout finished and found nothing new that fits.');
      await Promise.all([loadStatus(), loadList('proposed')]);
      if (S.filter !== 'proposed' && res.kept) await setFilter('proposed');
      paintList({ force: true });
    } else {
      say(res.message);
      await loadStatus();
    }
    panel.paint();
  }
  function paintHeadRun() {
    const running = Boolean(S.run?.at);
    runBtn.hidden = !isOwner();
    runBtn.disabled = running || Boolean(panel.runBlock());
    runBtn.title = panel.runBlock() || '';
    runBtn.classList.toggle('is-running', running);
    setText(runBtn.lastChild, running ? 'Running…' : 'Run now');
  }

  /* ---------------------------------------------------------- settings panel */
  function settingsPanel() {
    const sw = el('input', { type: 'checkbox', class: 'ag-switch-in', role: 'switch', 'aria-label': 'Scout on a schedule', dataset: { act: 'switch' } });
    const swWord = el('span', { class: 'ag-switch-word' });
    const swLabel = el('label', { class: 'ag-switch sc-switch' }, sw, el('span', { class: 'ag-switch-track', 'aria-hidden': 'true' }), swWord);
    let swSaving = false;
    sw.addEventListener('change', async () => {
      const v = sw.checked;
      swSaving = true;
      sw.disabled = true;
      swWord.textContent = v ? 'On' : 'Off';
      const r = await scoutSettings({ scout_enabled: v });
      swSaving = false;
      sw.disabled = !isOwner();
      if (r.ok) { if (S.status) S.status.settings = { ...S.status.settings, ...r.settings }; toast(v ? `Scout on. ${scheduleText(r.settings)}.` : 'Scout off. It will not look for new businesses.'); }
      else { sw.checked = !v; toast(r.message, 'bad'); }
      paint();
    });
    const sched = el('span', { class: 'sc-stat-v' });
    const lastV = el('span', { class: 'sc-stat-v' });
    const spendV = el('span', { class: 'sc-stat-v tnum' });
    const meterI = el('i');
    const meter = el('span', { class: 'sc-meter', role: 'img' }, meterI);
    const stat = (label, v, extra) => el('div', { class: 'sc-stat' }, el('span', { class: 'sc-stat-k' }, label), v, extra || null);
    const editBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm sc-edit', 'aria-expanded': 'false', 'aria-controls': 'sc-editor', dataset: { act: 'edit' } }, el('span', {}, 'Brief and schedule'), el('span', { class: 'sc-chev' }, icon('chevron-down', 14)));
    editBtn.addEventListener('click', () => { S.editing = !S.editing; if (S.editing) fillForm(); paint(); if (S.editing) setTimeout(() => brief.focus({ preventScroll: true }), 30); });
    const warn = el('p', { class: 'callout is-warn sc-warn', hidden: true });
    const runLine = el('div', { class: 'sc-runline', role: 'status', hidden: true });

    /* the editor */
    const brief = el('textarea', { class: 'input sc-brief', name: 'scout_brief', rows: 7, maxlength: 2000, placeholder: 'Who should the scout look for? For example: owner-run plumbers and electricians in the northern suburbs who take bookings by phone.' });
    const briefCount = el('span', { class: 'field-hint tnum sc-count' });
    brief.addEventListener('input', () => { setText(briefCount, `${num(brief.value.length)} of 2,000`); dirty(); });
    const perDay = el('input', { class: 'input sc-num', type: 'number', name: 'scout_daily_max', min: 1, max: 30, step: 1, inputmode: 'numeric' });
    perDay.addEventListener('input', dirty);
    const dayBoxes = DAY_NAMES.map((d, i) => {
      const b = el('input', { type: 'checkbox', class: 'sc-day-in', value: String(i + 1), 'aria-label': ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][i] });
      b.addEventListener('change', dirty);
      return { b, node: el('label', { class: 'sc-day' }, b, el('span', { 'aria-hidden': 'true' }, d.slice(0, 2))) };
    });
    const hourSel = el('select', { class: 'input sc-hour', name: 'scout_hour' }, Array.from({ length: 16 }, (_, i) => i + 5).map((h) => el('option', { value: String(h) }, hourLabel(h))));
    hourSel.addEventListener('change', dirty);
    const cap = el('input', { class: 'input sc-num', type: 'number', name: 'scout_monthly_cap_usd', min: 0, max: 100, step: 1, inputmode: 'decimal' });
    cap.addEventListener('input', dirty);
    const formErr = el('p', { class: 'sc-form-err', role: 'alert' });
    const save = el('button', { type: 'submit', class: 'btn btn-primary btn-sm', dataset: { act: 'save' } }, 'Save changes');
    const cancel = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { act: 'cancel' } }, 'Cancel');
    cancel.addEventListener('click', () => { S.editing = false; formErr.textContent = ''; paint(); editBtn.focus(); });
    const capField = el('label', { class: 'field sc-cap' }, el('span', { class: 'field-label' }, 'Monthly budget (US$)'), cap, el('span', { class: 'field-hint' }, 'The scout stops for the month when it reaches this.'));
    const readOnly = el('p', { class: 'small muted sc-ro', hidden: true }, 'Only the owner can change the scout’s settings.');
    const form = el('form', { class: 'sc-editor', id: 'sc-editor', hidden: true, novalidate: true },
      el('label', { class: 'field sc-brief-f' }, el('span', { class: 'field-label' }, 'The brief'), brief,
        el('span', { class: 'sc-brief-foot' }, el('span', { class: 'field-hint' }, 'Plain words are best: the kind of business, where, how big, and the signs that they need help with calls and bookings.'), briefCount)),
      el('div', { class: 'sc-side' },
        el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'How many a day, at most'), perDay),
        el('fieldset', { class: 'field sc-days' }, el('legend', { class: 'field-label' }, 'Days it looks'), el('div', { class: 'sc-day-row' }, dayBoxes.map((d) => d.node))),
        el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'From'), hourSel, el('span', { class: 'field-hint' }, 'Brisbane time. New finds wait here and in your morning email.')),
        capField),
      el('div', { class: 'sc-form-foot' }, readOnly, formErr, el('span', { class: 'spacer' }), cancel, save));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const patch = formPatch();
      if (patch === null) return;
      if (!Object.keys(patch).length) { S.editing = false; paint(); editBtn.focus(); return; }
      save.disabled = true; save.classList.add('is-busy');
      const r = await scoutSettings(patch);
      save.disabled = false; save.classList.remove('is-busy');
      if (!r.ok) { formErr.textContent = r.message; return; }
      if (S.status) S.status.settings = { ...S.status.settings, ...r.settings };
      if ('scout_monthly_cap_usd' in patch && S.status) S.status.cap_usd = Number(r.settings.scout_monthly_cap_usd);
      S.editing = false;
      toast('Scout settings saved');
      paint();
      editBtn.focus();
    });

    function fillForm() {
      const s = S.status?.settings || {};
      brief.value = s.scout_brief || '';
      setText(briefCount, `${num(brief.value.length)} of 2,000`);
      perDay.value = String(s.scout_daily_max ?? 10);
      const days = Array.isArray(s.scout_days) ? s.scout_days.map(Number) : [1, 2, 3, 4, 5];
      dayBoxes.forEach((d, i) => { d.b.checked = days.includes(i + 1); });
      hourSel.value = String(s.scout_hour ?? 7);
      if (!hourSel.value) { hourSel.append(el('option', { value: String(s.scout_hour) }, hourLabel(s.scout_hour))); hourSel.value = String(s.scout_hour); }
      cap.value = String(s.scout_monthly_cap_usd ?? S.status?.cap_usd ?? 10);
      formErr.textContent = '';
      dirty();
    }
    function formPatch() {
      const s = S.status?.settings || {};
      const out = {};
      const b = brief.value.replace(/\r\n/g, '\n').trim();
      if (b !== (s.scout_brief || '').trim()) {
        if (!b) { formErr.textContent = 'The brief cannot be empty. The scout needs to know what to look for.'; brief.focus(); return null; }
        out.scout_brief = b;
      }
      const n = Number(perDay.value);
      if (!Number.isInteger(n) || n < 1 || n > 30) { formErr.textContent = 'How many a day: a whole number from 1 to 30.'; perDay.focus(); return null; }
      if (n !== Number(s.scout_daily_max)) out.scout_daily_max = n;
      const days = dayBoxes.filter((d) => d.b.checked).map((d) => Number(d.b.value));
      if (!days.length) { formErr.textContent = 'Pick at least one day.'; dayBoxes[0].b.focus(); return null; }
      if (days.join(',') !== (Array.isArray(s.scout_days) ? [...s.scout_days].map(Number).sort().join(',') : '1,2,3,4,5')) out.scout_days = days;
      const h = Number(hourSel.value);
      if (h !== Number(s.scout_hour ?? 7)) out.scout_hour = h;
      if (S.canCap) {
        const c = Number(cap.value);
        if (!Number.isFinite(c) || c < 0 || c > 100 || cap.value === '') { formErr.textContent = 'Monthly budget: a number from 0 to 100.'; cap.focus(); return null; }
        if (Math.round(c * 100) / 100 !== Number(s.scout_monthly_cap_usd)) out.scout_monthly_cap_usd = Math.round(c * 100) / 100;
      }
      formErr.textContent = '';
      return out;
    }
    function dirty() {
      const owner = isOwner();
      const p = owner ? (() => { const keep = formErr.textContent; const x = formPatch(); formErr.textContent = keep; return x; })() : {};
      save.disabled = !owner || (p !== null && !Object.keys(p).length);
    }

    const stats = el('div', { class: 'sc-stats' },
      stat('Schedule', sched),
      stat('Last run', lastV),
      stat('This month', spendV, meter));
    const safe = el('p', { class: 'sc-safe', dataset: { safe: '' } }, icon('check', 14), el('span', {}, SAFE_LINE));
    const node = el('section', { class: 'sc-panel', 'aria-label': 'Scout settings', dataset: { scoutSettings: '' } },
      el('div', { class: 'sc-panel-top' }, swLabel, stats, editBtn),
      warn, runLine, form, safe);

    /** Why Run now cannot start, or ''. */
    function runBlock() {
      if (!S.status) return S.statusErr ? 'The scout is not reachable right now.' : 'Loading…';
      if (state.agents && state.agents.configured === false) return SCOUT_ERRORS_SHORT.ai;
      if (state.agents && state.agents.enabled === false) return SCOUT_ERRORS_SHORT.off;
      if (S.status.cap_usd <= 0 || S.status.spent_usd >= S.status.cap_usd) return SCOUT_ERRORS_SHORT.cap;
      if (!str(S.status.settings?.scout_brief)) return SCOUT_ERRORS_SHORT.brief;
      return '';
    }

    let runTick = 0;
    function paintRun() {
      clearInterval(runTick);
      if (S.run?.at) {
        runLine.hidden = false;
        const bar = el('span', { class: 'sc-prog', 'aria-hidden': 'true' }, el('i'));
        const words = el('span', { class: 'sc-run-words' });
        const secs = el('span', { class: 'sc-run-secs tnum' });
        fill(runLine, el('span', { class: 'sc-run-top' }, el('span', { class: 'sc-spin', 'aria-hidden': 'true' }), words, secs), bar);
        runLine.classList.remove('is-done', 'is-bad');
        const step = () => {
          const t = (Date.now() - S.run.at) / 1000;
          setText(words, t < 10 ? 'Reading your brief and searching the web' : t < 45 ? 'Opening each business’s own page to check the details' : 'Checking numbers and saving what fits');
          setText(secs, `${Math.floor(t)} s`);
          bar.firstChild.style.transform = `scaleX(${Math.min(0.94, 1 - Math.exp(-t / 50)).toFixed(3)})`;
        };
        step();
        runTick = setInterval(() => { if (!node.isConnected || !S.run?.at) { clearInterval(runTick); return; } step(); }, 1000);
        return;
      }
      if (S.run?.done) {
        const r = S.run.res;
        runLine.hidden = false;
        runLine.classList.toggle('is-bad', !r.ok);
        runLine.classList.add('is-done');
        const dropped = Array.isArray(r.dropped) ? r.dropped : [];
        const close = el('button', { type: 'button', class: 'icon-btn sc-run-x', 'aria-label': 'Dismiss', onClick: () => { S.run = null; paint(); } }, icon('x', 14));
        if (!r.ok) {
          fill(runLine, el('span', { class: 'sc-run-top' }, icon('alert', 15), el('span', { class: 'sc-run-words' }, r.message), close));
          return;
        }
        const head = r.kept
          ? `Found ${plural(r.kept, 'business', 'businesses')} that ${r.kept === 1 ? 'fits' : 'fit'}.`
          : 'Finished. Nothing new fits your brief this time.';
        const bits = [r.found ? `${num(r.found)} looked at` : null, dropped.length ? `${num(dropped.length)} set aside` : null, usd(r.cost_usd), `${Math.round((S.run.ms || 0) / 1000)} s`].filter(Boolean).join(' · ');
        fill(runLine,
          el('span', { class: 'sc-run-top' }, icon('check', 15), el('span', { class: 'sc-run-words' }, head), el('span', { class: 'sc-run-secs tnum' }, bits), close),
          dropped.length ? el('details', { class: 'sc-dropped' }, el('summary', {}, 'Why some were set aside'),
            el('ul', {}, dropped.slice(0, 12).map((d) => el('li', {}, el('b', {}, String(d.business || 'A business')), ` ${String(d.why || '')}`)))) : null);
        return;
      }
      runLine.hidden = true;
      fill(runLine);
    }

    let key = null;
    function paint() {
      const st = S.status;
      const s = st?.settings || {};
      const owner = isOwner();
      const runKey = S.run?.at ? 'run' : S.run?.done ? `done:${S.run.res.run_id}` : '';
      const k = JSON.stringify([Boolean(st), S.statusErr, s, st?.spent_usd, st?.cap_usd, st?.last_run, st?.waiting, owner, S.canCap, S.editing, runKey, lastScoutRun()?.id, lastScoutRun()?.status, state.agents?.enabled, state.agents?.configured]);
      paintHeadRun();
      if (k === key) return;
      key = k;
      node.classList.toggle('is-loading', !st && !S.statusErr);
      if (!st) {
        sw.disabled = true;
        setText(swWord, S.statusErr ? '–' : '…');
        setText(sched, S.statusErr ? 'Not reachable' : 'Loading…');
        setText(lastV, '–'); setText(spendV, '–');
        meter.hidden = true;
        editBtn.hidden = true;
        warn.hidden = !S.statusErr;
        if (S.statusErr) fill(warn, icon('alert', 15), el('span', {}, `${S.statusErr} `), el('button', { type: 'button', class: 'link-btn', onClick: async () => { S.statusErr = null; paint(); await loadStatus(); paint(); paintList({ force: true }); } }, 'Try again'));
        paintRun();
        return;
      }
      editBtn.hidden = false;
      if (!swSaving) { sw.checked = s.scout_enabled === true; sw.disabled = !owner; }
      setText(swWord, s.scout_enabled ? 'On' : 'Off');
      swLabel.title = owner ? '' : 'Only the owner can switch the scout on or off.';
      setText(sched, s.scout_enabled ? `${scheduleText(s)}, up to ${num(s.scout_daily_max ?? 10)} a day` : `Off. When on: ${scheduleText(s).replace(/^\w/, (c) => c.toLowerCase())}`);
      const lr = lastScoutRun();
      const last = st.last_run;
      if (lr || last) {
        const at = lr?.at || last?.at;
        const status = lr?.status || last?.status;
        const kept = lr ? Number(lr.output?.kept ?? 0) : Number(last?.kept ?? 0);
        const what = status === 'ok' ? `found ${num(kept)}` : status === 'empty' ? 'found none' : status === 'capped' ? 'stopped by the budget' : status === 'error' ? (lr?.error === 'running' ? 'running' : 'hit a problem') : status;
        setText(lastV, `${timeAgo(at)} · ${what}${lr ? ` · ${usd(lr.cost_usd)}` : ''}`);
      } else setText(lastV, 'Not run yet');
      const spent = Number(st.spent_usd) || 0; const capUsd = Number(st.cap_usd) || 0;
      setText(spendV, `${usd(spent)} of ${usd(capUsd)}`);
      meter.hidden = false;
      const pct = capUsd > 0 ? Math.min(100, Math.round((spent / capUsd) * 100)) : 100;
      meterI.style.transform = `scaleX(${pct / 100})`;
      meter.classList.toggle('is-high', pct >= 90);
      meter.setAttribute('aria-label', `${pct}% of the scout’s monthly budget used`);
      const over = capUsd <= 0 || spent >= capUsd;
      warn.hidden = !(over || (state.agents && state.agents.enabled === false));
      if (!warn.hidden) fill(warn, icon('alert', 15), el('span', {}, over
        ? (owner ? 'The scout’s budget for this month is used up, so it will not look again until next month. Raise the budget under Brief and schedule to keep going.' : 'The scout’s budget for this month is used up, so it will not look again until next month.')
        : SCOUT_ERRORS_SHORT.off));
      editBtn.setAttribute('aria-expanded', String(S.editing));
      editBtn.classList.toggle('is-open', S.editing);
      form.hidden = !S.editing;
      readOnly.hidden = owner;
      for (const c of [brief, perDay, hourSel, cap, ...dayBoxes.map((d) => d.b)]) c.disabled = !owner;
      cap.disabled = !owner || !S.canCap;
      capField.hidden = !S.canCap && !owner;
      save.hidden = !owner;
      setText(cancel, owner ? 'Cancel' : 'Close');
      if (S.editing && !form.dataset.filled) { fillForm(); form.dataset.filled = '1'; }
      if (!S.editing) delete form.dataset.filled;
      paintRun();
    }
    return { node, paint, runBlock };
  }

  /* ---------------------------------------------------------- first load and live updates */
  async function boot() {
    settleReceipts();
    panel.paint();
    paintList();
    const first = !S.status;
    const tasks = [loadStatus().then(() => { panel.paint(); paintTabs(); })];
    if (!S.lists[S.filter] || Date.now() - (S.lists[S.filter].at || 0) > 5000) tasks.push(loadList(S.filter).then(() => paintList()));
    await Promise.all(tasks);
    S.stamp = scoutStamp();
    if (first) panel.paint();
  }

  /** The hub changed somewhere (realtime). Only act when the scout's own cards changed. */
  let refreshing = null;
  node.onState = () => {
    panel.paint();
    const st = scoutStamp();
    if (st === S.stamp || refreshing) return;
    S.stamp = st;
    refreshing = (async () => {
      // New finds (a scheduled run, or the assistant's hand-off): merge them in, keep everything else.
      const before = S.lists.proposed?.items || [];
      const r = await scoutCandidates({ status: 'proposed', limit: PAGE });
      await loadStatus();
      if (r.ok && S.lists.proposed) {
        const fresh = (r.items || []).filter((c) => !before.some((x) => x.id === c.id));
        const gone = before.filter((c) => !S.receipts.has(c.id) && !(r.items || []).some((x) => x.id === c.id) && !(r.next_before && c.created_at < r.next_before));
        if (fresh.length || gone.length) {
          S.lists.proposed.items = [...fresh, ...before.filter((c) => !gone.includes(c))];
          if (S.filter === 'proposed') { const all = [...list.children]; flip(all, () => paintList()); if (fresh.length) say(`${plural(fresh.length, 'new business', 'new businesses')} to review.`); }
        }
      }
      panel.paint();
      paintTabs();
      refreshing = null;
    })();
  };

  // Leaving the page (or the tab closing) saves skips that are still waiting.
  const flush = () => { if (S.pending.size) commitSkips([...S.pending.keys()], null); };
  const onHash = () => { if (!/^#scout(\/|$)/.test(location.hash)) { flush(); window.removeEventListener('hashchange', onHash); window.removeEventListener('pagehide', flush); } };
  window.addEventListener('hashchange', onHash);
  window.addEventListener('pagehide', flush);

  boot();
  return node;
}

const SCOUT_ERRORS_SHORT = {
  ai: 'The AI model is not connected yet. See Settings, under Connections.',
  off: 'The agents are switched off in Settings, so the scout cannot run.',
  cap: 'The scout’s budget for this month is used up.',
  brief: 'Write a brief first, so the scout knows what to look for.'
};
export { SCOUT_KIND };
