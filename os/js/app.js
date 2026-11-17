// Wise AI OS shell: PIN gate, router, navigation, idle lock, live indicators.
import { el, $, clear, icon, toast, go, trapFocus } from './ui.js?v=20261118c';
import { createPalette } from './palette.js?v=20261118c';
import {
  sb, state, login, lock, loadAll, subscribe, onChange, onRealtime, onConnection,
  refreshSmsStatus, knownPinLength, leadById, leadName
} from './api.js?v=20261118c';

/* ------------------------------------------------------------ route registry
   The single source of truth for navigation. Top-level entries are either a
   section or a group of sections; `soon: true` marks a planned section (shown
   dimmed, never a link). Making a section real is a one-line change: drop
   `soon` and add `view` (a lazy import whose default export is (ctx) => Node).
   `tab` marks the routes in the phone tab bar (max 4); `foot` puts a section at
   the foot of the collapsed dock; `href` links out (new tab). */
export const NAV = [
  { id: 'home', label: 'Today', icon: 'home', tab: true, view: () => import('./views/home.js?v=20261118c') },
  { group: 'Grow', icon: 'grow', items: [
    { id: 'leads', label: 'Leads', icon: 'leads', tab: true, view: () => import('./views/leads.js?v=20261118c') },
    { id: 'inbox', label: 'Inbox', icon: 'inbox', tab: true, badge: 'unread', view: () => import('./views/inbox.js?v=20261118c') },
    { id: 'campaigns', label: 'Campaigns', icon: 'send', tab: true, view: () => import('./views/campaigns.js?v=20261118c') },
    { id: 'bookings', label: 'Bookings', icon: 'calendar', view: () => import('./views/bookings.js?v=20261118c') }
  ] },
  { group: 'Sell', icon: 'tag', items: [
    { id: 'pipeline', label: 'Pipeline', icon: 'tag', view: () => import('./views/pipeline.js?v=20261118c') },
    { id: 'proposals', label: 'Proposals', icon: 'book', view: () => import('./views/proposals.js?v=20261118c') },
    { id: 'roi-calculator', label: 'ROI calculator', icon: 'dollar', href: '../roi.html' }
  ] },
  { group: 'Deliver', icon: 'deliver', items: [
    { id: 'clients', label: 'Clients', icon: 'leads', view: () => import('./views/clients.js?v=20261118c') },
    { id: 'projects', label: 'Projects', icon: 'deliver', view: () => import('./views/projects.js?v=20261118c') },
    { id: 'roi-reports', label: 'ROI reports', icon: 'spark', view: () => import('./views/roi-reports.js?v=20261118c') }
  ] },
  { group: 'Money', icon: 'money', items: [
    { id: 'income', label: 'Income', icon: 'money', view: () => import('./views/income.js?v=20261118c') },
    { id: 'costs', label: 'Costs', icon: 'money', view: () => import('./views/costs.js?v=20261118c') },
    { id: 'runway', label: 'Runway', icon: 'spark', view: () => import('./views/runway.js?v=20261118c') }
  ] },
  { group: 'Know', icon: 'book', items: [
    { id: 'playbook', label: 'Playbook', icon: 'book', view: () => import('./views/playbook.js?v=20261118c') },
    { id: 'library', label: 'Library', icon: 'book', view: () => import('./views/library.js?v=20261118c') }
  ] },
  { sep: true },
  { id: 'agents', label: 'Agents', icon: 'agents', soon: true },
  { id: 'settings', label: 'Settings', icon: 'settings', foot: true, view: () => import('./views/settings.js?v=20261118c') }
];
const NAV_ITEMS = NAV.flatMap((n) => (n.items ? n.items.map((i) => Object.assign(i, { area: n.group })) : n.sep ? [] : [n]));
/** Live sections (the ones with a view), in navigation order. */
const ROUTES = NAV_ITEMS.filter((r) => r.view);
const groupSoon = (g) => g.items.every((i) => i.soon || i.href);
const IDLE_MS = 15 * 60 * 1000;
const LOGO = '../logo.svg';
const NAV_KEY = 'wiseos.nav';
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const SHORTCUT = IS_MAC ? '⌘K' : 'Ctrl K';

const app = $('#app');
let booted = false;

/* ================================================================ PIN gate */

function renderGate() {
  // Windows-style lock: a resting screen with the clock and a lock to click,
  // then a single numbers-only PIN field. No on-screen keypad.
  let busy = false;
  let lockedUntil = 0;
  let countdownTimer = null;
  let open = false;

  // Auto-submit only when this device has unlocked before, so we know the PIN's length.
  const storedLen = () => { try { return Number(localStorage.getItem('wiseos.pinlen')) || 0; } catch { return 0; } };

  const clock = el('div', { class: 'gate-clock', 'aria-hidden': 'true' });
  const date = el('div', { class: 'gate-date' });
  const tick = () => {
    const now = new Date();
    clock.textContent = now.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s?[ap]m$/i, '');
    date.textContent = now.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
  };
  tick();
  const clockTimer = setInterval(tick, 1000);

  const hint = el('div', { class: 'gate-hint', role: 'status' });
  const setHint = (text, tone = '') => { hint.textContent = text; hint.className = `gate-hint${tone ? ` is-${tone}` : ''}`; };

  const input = el('input', {
    class: 'pin-input', type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '12',
    autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
    placeholder: 'PIN', 'aria-label': 'PIN', name: 'wiseos-pin'
  });
  const go = el('button', { type: 'submit', class: 'pin-go', 'aria-label': 'Unlock' }, icon('arrow', 18));
  const field = el('form', { class: 'pin-field', novalidate: true }, input, go);

  const unlockBtn = el('button', { type: 'button', class: 'gate-unlock', 'aria-label': 'Unlock Wise AI OS' },
    el('span', { class: 'gate-unlock-ring' }, icon('lock', 22)),
    el('span', { class: 'gate-unlock-label' }, 'Click to unlock'));

  const panel = el('div', { class: 'gate-panel' }, unlockBtn);
  const REST_FOOT = 'Click the lock, or start typing your PIN';
  const foot = el('span', {}, REST_FOOT);

  const setDisabled = (d) => { input.disabled = d; go.disabled = d; };

  const shake = () => {
    field.classList.remove('is-shake');
    void field.offsetWidth;
    field.classList.add('is-shake');
    setTimeout(() => field.classList.remove('is-shake'), 450);
  };

  const startCountdown = (secs) => {
    lockedUntil = Date.now() + secs * 1000;
    setDisabled(true);
    clearInterval(countdownTimer);
    const step = () => {
      const left = Math.max(0, Math.ceil((lockedUntil - Date.now()) / 1000));
      if (!left) {
        clearInterval(countdownTimer);
        setDisabled(false);
        setHint('Enter your PIN');
        if (open) input.focus();
        return;
      }
      const m = Math.floor(left / 60);
      const sec = String(left % 60).padStart(2, '0');
      setHint(`Too many attempts. Try again in ${m}:${sec}`, 'bad');
    };
    step();
    countdownTimer = setInterval(step, 1000);
  };

  const submit = async () => {
    if (busy || Date.now() < lockedUntil) return;
    const pin = input.value;
    if (pin.length < 4) {
      if (pin.length) { setHint('PINs are at least 4 digits', 'warn'); shake(); }
      return;
    }
    busy = true;
    field.classList.add('is-busy');
    setDisabled(true);
    setHint('Unlocking…');
    const res = await login(pin);
    busy = false;
    field.classList.remove('is-busy');
    if (res.ok) {
      setHint('Welcome back');
      return; // the auth listener boots the shell
    }
    input.value = '';
    if (res.error === 'locked') {
      shake();
      startCountdown(Number(res.retry_after_s) || 300);
      return;
    }
    setDisabled(false);
    input.focus();
    if (res.error === 'bad_pin') {
      shake();
      const r = Number(res.remaining);
      setHint(Number.isFinite(r)
        ? `That PIN didn't match. ${r} attempt${r === 1 ? '' : 's'} left before a lockout.`
        : "That PIN didn't match.", 'bad');
      if (navigator.vibrate) navigator.vibrate(120);
    } else if (res.error === 'network' || res.error === 'not_deployed') {
      setHint("Can't reach the sign-in service. Check your connection and try again.", 'warn');
    } else {
      setHint(`Sign-in failed (${res.error}). Try again in a moment.`, 'warn');
    }
  };

  // Numbers only, however the text arrives (typing, paste, autofill, IME).
  input.addEventListener('beforeinput', (e) => {
    if (e.data && /\D/.test(e.data) && e.inputType !== 'insertFromPaste') e.preventDefault();
  });
  input.addEventListener('input', () => {
    const clean = input.value.replace(/\D/g, '').slice(0, 12);
    if (clean !== input.value) input.value = clean;
    if (hint.classList.contains('is-bad') || hint.classList.contains('is-warn')) setHint('Enter your PIN');
    const n = storedLen();
    if (n >= 4 && clean.length === n) submit();
  });
  field.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

  const openField = (firstDigit = '') => {
    if (open) return;
    open = true;
    gate.classList.add('is-open');
    foot.textContent = 'Numbers only · Esc to go back';
    fillNode(panel, field, hint);
    setHint(storedLen() ? 'Enter your PIN' : 'Enter your PIN, then press Enter');
    if (Date.now() < lockedUntil) setDisabled(true);
    input.value = firstDigit;
    input.focus();
    if (firstDigit) input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const closeField = () => {
    if (!open || busy) return;
    open = false;
    input.value = '';
    gate.classList.remove('is-open');
    foot.textContent = REST_FOOT;
    fillNode(panel, unlockBtn);
    unlockBtn.focus();
  };
  const fillNode = (node, ...kids) => { clear(node); node.append(...kids); };

  unlockBtn.addEventListener('click', () => openField());

  const gate = el('div', { class: 'gate', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Wise AI OS is locked' },
    el('div', { class: 'gate-top' },
      el('div', { class: 'gate-brand' }, el('img', { src: LOGO, alt: 'Wise AI' }), el('span', { class: 'os-tag' }, 'OS')),
      el('div', { class: 'gate-lock', 'aria-hidden': 'true' }, icon('lock', 13), 'Locked')),
    el('div', { class: 'gate-time' }, clock, date),
    panel,
    el('div', { class: 'gate-foot' }, foot)
  );

  // Clicking anywhere on the resting screen opens the PIN field, as on Windows.
  gate.addEventListener('click', (e) => {
    if (!open && !e.target.closest('button, a, input')) openField();
  });

  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!open) {
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); openField(e.key); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openField(); }
      else if (e.key === 'Tab') trapFocus(e, gate);
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); closeField(); }
    else if (e.key === 'Tab') trapFocus(e, gate);
    else if (document.activeElement !== input && /^[0-9]$/.test(e.key) && !input.disabled) {
      // A digit typed while focus is elsewhere still lands in the field.
      e.preventDefault();
      input.focus();
      input.value = (input.value + e.key).slice(0, 12);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
  document.addEventListener('keydown', onKey);

  document.body.append(gate);

  return {
    destroy() {
      document.removeEventListener('keydown', onKey);
      clearInterval(clockTimer);
      clearInterval(countdownTimer);
      gate.classList.add('is-out');
      setTimeout(() => gate.remove(), 380);
    }
  };
}

/* =================================================================== shell */

const viewCache = new Map();
let current = { route: null, param: null, node: null };
let navCounts = [];
let connNodes = [];
let palette = null;
let rail = null;

const soonTag = () => el('span', { class: 'soon-tag' }, 'Soon');

function countBadge(r, cls = 'nav-count') {
  if (r.badge !== 'unread') return null;
  const c = el('span', { class: cls, hidden: true });
  navCounts.push(c);
  return c;
}

/** One entry of the grouped map: a live link, an external link, or a dimmed planned item. */
function navEntry(r, cls, { inSoonGroup = false } = {}) {
  if (r.view) {
    return el('a', { class: cls, href: `#${r.id}`, dataset: { route: r.id } },
      cls.includes('nav-top') ? icon(r.icon, 17) : null,
      el('span', { class: 'nav-label' }, r.label),
      countBadge(r));
  }
  if (r.href) {
    return el('a', { class: `${cls} is-external`, href: r.href, target: '_blank', rel: 'noopener', title: `${r.label} (opens the public page in a new tab)` },
      cls.includes('nav-top') ? icon(r.icon, 17) : null,
      el('span', { class: 'nav-label' }, r.label),
      el('span', { class: 'nav-ext' }, icon('external', 12)),
      el('span', { class: 'sr-only' }, ' (opens in a new tab)'));
  }
  return el('span', { class: `${cls} is-soon`, 'aria-disabled': 'true', dataset: { soon: r.id } },
    cls.includes('nav-top') ? icon(r.icon, 17) : null,
    el('span', { class: 'nav-label' }, r.label),
    inSoonGroup ? el('span', { class: 'sr-only' }, ' (coming soon)') : soonTag());
}

/** Layout A's grouped map. `prefix` keeps ids unique between the rail and the phone sheet. */
function navMap(prefix) {
  const nodes = NAV.map((n, i) => {
    if (n.sep) return el('div', { class: 'nav-sep', role: 'presentation' });
    if (!n.items) return navEntry(n, 'nav-item nav-top');
    const soon = groupSoon(n);
    const id = `${prefix}-g${i}`;
    return el('div', { class: `nav-group${soon ? ' is-soon' : ''}`, role: 'group', 'aria-labelledby': id },
      el('div', { class: 'nav-group-label', id }, icon(n.icon, 16), el('span', {}, n.group), soon ? soonTag() : null),
      el('ul', { class: 'nav-group-list' }, n.items.map((it) => el('li', {}, navEntry(it, 'nav-item nav-sub', { inSoonGroup: soon })))));
  });
  return el('nav', { class: 'nav', 'aria-label': 'Sections' }, nodes);
}

function paintConn({ node, label, extraCls }, c) {
  node.className = `conn${extraCls ? ` ${extraCls}` : ''} is-${c}`;
  label.textContent = c === 'live' ? 'Live' : c === 'offline' ? 'Offline' : 'Connecting';
  node.title = c === 'live' ? 'Live: updates arrive instantly' : c === 'offline' ? 'Offline: changes will not arrive' : 'Connecting to live updates';
}

function connIndicator(extraCls = '') {
  const label = el('span', { class: 'conn-label' }, 'Connecting');
  const node = el('span', { class: `conn ${extraCls}`, role: 'status' }, el('span', { class: 'conn-dot' }), label);
  const entry = { node, label, extraCls };
  connNodes.push(entry);
  paintConn(entry, state.connection);
  return node;
}

function searchTrigger(cls, compact = false) {
  return el('button', {
    type: 'button', class: cls, dataset: { palette: '' }, 'aria-haspopup': 'dialog',
    'aria-keyshortcuts': 'Control+K Meta+K', 'aria-label': compact ? `Search or jump to (${SHORTCUT})` : null,
    onClick: (e) => palette?.open(e.currentTarget)
  }, icon('search', compact ? 19 : 15), compact ? null : el('span', { class: 'nav-search-ph' }, 'Search or jump to…'), compact ? null : el('kbd', {}, SHORTCUT));
}

/* -------------------------------------------------------------- the rail
   Desktop: a slim icon dock (D) that expands into layout A's grouped map as an
   overlay on hover / keyboard focus, or stays open beside the content when
   pinned. The dock is a pointer-only visual duplicate (aria-hidden); the full
   map is the accessible navigation and expands as soon as focus enters it. */
function buildRail() {
  const pinBtn = el('button', { type: 'button', class: 'rail-pin', 'aria-pressed': 'false' }, icon('panel-pin', 17));
  const full = el('div', { class: 'rail-full' },
    el('div', { class: 'rail-head' },
      el('a', { class: 'rail-brand', href: '#home', 'aria-label': 'Wise AI OS home' },
        el('img', { src: LOGO, alt: 'Wise AI' }), el('span', { class: 'os-tag' }, 'OS')),
      pinBtn),
    el('div', { class: 'rail-search' }, searchTrigger('nav-search')),
    navMap('rail'),
    el('div', { class: 'rail-foot' },
      connIndicator(),
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-lock', onClick: () => lock(), title: 'Lock (signs out)' },
        icon('lock', 15), el('span', { class: 'lbl' }, 'Lock'))));

  const dockItem = (r) => (r.view
    ? el('a', { class: 'dock-item', href: `#${r.id}`, tabindex: '-1', dataset: { route: r.id } }, icon(r.icon, 19), countBadge(r, 'dock-count'))
    : el('span', { class: 'dock-item is-soon' }, icon(r.icon, 19)));
  const live = ROUTES.filter((r) => !r.foot);
  const planned = NAV.filter((n) => (n.items ? groupSoon(n) : !n.sep && n.soon));
  const menuBtn = el('button', { type: 'button', class: 'dock-menu', tabindex: '-1' },
    el('span', { class: 'dock-mark' }, el('img', { src: LOGO, alt: '' })));
  const dock = el('div', { class: 'rail-dock', 'aria-hidden': 'true' },
    menuBtn,
    el('button', { type: 'button', class: 'dock-item dock-search', tabindex: '-1', onClick: (e) => palette?.open(e.currentTarget) }, icon('search', 19)),
    el('div', { class: 'dock-list' },
      live.map(dockItem),
      el('span', { class: 'dock-sep' }),
      planned.map(dockItem)),
    el('div', { class: 'dock-foot' },
      ROUTES.filter((r) => r.foot).map(dockItem),
      connIndicator('conn-dock'),
      el('button', { type: 'button', class: 'dock-item', tabindex: '-1', onClick: () => lock() }, icon('lock', 18))));

  const node = el('aside', { class: 'rail', 'aria-label': 'Main navigation' }, dock, full);
  return { node, full, dock, pinBtn, menuBtn };
}

function readPinned() { try { return localStorage.getItem(NAV_KEY) === 'pinned'; } catch { return false; } }
function savePinned(p) { try { localStorage.setItem(NAV_KEY, p ? 'pinned' : 'dock'); } catch { /* private mode: per-session only */ } }

function railController(shell, parts) {
  const { node, full, dock, pinBtn, menuBtn } = parts;
  const wide = matchMedia('(min-width: 1100px)');
  const desktop = matchMedia('(min-width: 761px)');
  let pinned = readPinned();
  let open = false;
  let openedBy = null;
  let hover = false;
  let suppress = false; // after choosing an item, ignore hover until the pointer leaves
  let tOpen = 0;
  let tClose = 0;

  const effPinned = () => pinned && wide.matches;
  const apply = () => {
    const pin = effPinned();
    const expanded = pin || open;
    shell.classList.toggle('nav-pinned', pin);
    node.classList.toggle('is-expanded', expanded);
    node.classList.toggle('is-peek', expanded && !pin);
    node.dataset.state = pin ? 'pinned' : expanded ? 'peek' : 'dock';
    pinBtn.setAttribute('aria-pressed', String(pinned));
    const lbl = pinned ? 'Unpin sidebar' : 'Keep sidebar open';
    pinBtn.setAttribute('aria-label', lbl);
    pinBtn.title = `${lbl} ( [ )`;
    menuBtn.setAttribute('aria-expanded', String(expanded));
  };
  const setOpen = (v, by = null) => {
    clearTimeout(tOpen); clearTimeout(tClose);
    if (open === v) { if (v && by) openedBy = by; return; }
    open = v;
    openedBy = v ? by : null;
    if (!v && full.contains(document.activeElement) && !effPinned()) {
      // A mouse click left focus in the map; let it go rather than hide a focused control.
      if (!document.activeElement.matches(':focus-visible')) document.activeElement.blur();
    }
    apply();
  };
  const closeSoon = () => { clearTimeout(tClose); tClose = setTimeout(() => setOpen(false), 250); };

  node.addEventListener('pointerenter', (e) => {
    if (e.pointerType === 'touch') return;
    hover = true;
    clearTimeout(tClose);
    if (!open && !effPinned() && !suppress) { clearTimeout(tOpen); tOpen = setTimeout(() => setOpen(true, 'hover'), 120); }
  });
  node.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'touch') return;
    hover = false;
    suppress = false;
    clearTimeout(tOpen);
    if (open && openedBy !== 'click' && !(openedBy === 'focus' && full.contains(document.activeElement))) closeSoon();
  });
  node.addEventListener('focusin', (e) => {
    if (dock.contains(e.target)) return; // pointer-only duplicate
    clearTimeout(tClose);
    if (!open && !effPinned()) setOpen(true, 'focus');
  });
  node.addEventListener('focusout', (e) => {
    if (e.relatedTarget && node.contains(e.relatedTarget)) return;
    if (open && openedBy === 'focus' && !hover) closeSoon();
  });
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open && !effPinned()) {
      e.stopPropagation();
      setOpen(false);
      $('#view')?.focus({ preventScroll: true });
    }
  });
  // Choosing a destination tucks the overlay away.
  node.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    if (open && !effPinned()) { suppress = hover; setOpen(false); }
  });
  // Touch / no-hover: the dock's mark opens the overlay; tapping outside closes it.
  menuBtn.addEventListener('click', () => {
    if (effPinned()) return;
    setOpen(!open, 'click');
  });
  document.addEventListener('pointerdown', (e) => {
    if (open && !effPinned() && !node.contains(e.target) && (openedBy === 'click' || e.pointerType === 'touch')) setOpen(false);
  });
  pinBtn.addEventListener('click', () => togglePin());
  wide.addEventListener('change', apply);
  desktop.addEventListener('change', () => { if (!desktop.matches) setOpen(false); });

  function togglePin() {
    if (!wide.matches) { setOpen(!open, 'click'); return; }
    pinned = !pinned;
    savePinned(pinned);
    if (!pinned) {
      // Unpinned: stay open only while the pointer (or keyboard focus) is in the rail.
      open = hover || full.contains(document.activeElement);
      openedBy = open ? (hover ? 'hover' : 'focus') : null;
    } else {
      open = false;
    }
    apply();
  }
  apply();
  return { togglePin, close: () => setOpen(false), get pinned() { return pinned; } };
}

/* ------------------------------------------------------- phone More sheet */
function openMore(trigger) {
  if ($('.more-layer')) return closeMore();
  const prev = document.activeElement;
  const sheet = el('div', { class: 'more-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'All sections' },
    el('div', { class: 'more-head' },
      el('a', { class: 'rail-brand', href: '#home', 'aria-label': 'Wise AI OS home' }, el('img', { src: LOGO, alt: 'Wise AI' }), el('span', { class: 'os-tag' }, 'OS')),
      el('button', { type: 'button', class: 'icon-btn more-close', 'aria-label': 'Close menu', onClick: () => closeMore() }, icon('x', 18))),
    navMap('sheet'),
    el('div', { class: 'rail-foot' },
      connIndicator(),
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-lock', onClick: () => lock() }, icon('lock', 15), el('span', { class: 'lbl' }, 'Lock'))));
  const layer = el('div', { class: 'more-layer' }, el('div', { class: 'more-scrim', onClick: () => closeMore() }), sheet);
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeMore(); }
    else if (e.key === 'Tab') trapFocus(e, sheet);
  };
  sheet.addEventListener('click', (e) => { if (e.target.closest('a[href]')) setTimeout(() => closeMore(), 0); });
  layer._close = () => {
    document.removeEventListener('keydown', onKey, true);
    trigger?.setAttribute('aria-expanded', 'false');
    layer.classList.add('is-leaving');
    setTimeout(() => layer.remove(), 220);
    if (prev && prev.focus && prev.isConnected) prev.focus({ preventScroll: true });
  };
  document.addEventListener('keydown', onKey, true);
  document.body.append(layer);
  trigger?.setAttribute('aria-expanded', 'true');
  updateBadges();
  markActive();
  setTimeout(() => sheet.querySelector('.more-close')?.focus(), 30);
}
function closeMore() {
  const layer = $('.more-layer:not(.is-leaving)');
  if (layer) layer._close();
}

function renderShell() {
  clear(app);
  navCounts = [];
  connNodes = [];
  const parts = buildRail();

  const topbar = el('header', { class: 'topbar' },
    el('a', { href: '#home', 'aria-label': 'Wise AI OS home' }, el('img', { src: LOGO, alt: 'Wise AI' })),
    el('span', { class: 'os-tag' }, 'OS'),
    connIndicator(),
    searchTrigger('icon-btn topbar-search', true),
    el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Lock', onClick: () => lock() }, icon('lock', 19)));

  const moreBtn = el('button', { type: 'button', class: 'tab-item', dataset: { route: 'more' }, 'aria-label': 'More sections', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onClick: (e) => openMore(e.currentTarget) },
    icon('more', 22), el('span', {}, 'More'));
  const tabbar = el('nav', { class: 'tabbar', 'aria-label': 'Quick sections' },
    ROUTES.filter((r) => r.tab).slice(0, 4).map((r) => el('a', { class: 'tab-item', href: `#${r.id}`, dataset: { route: r.id } },
      icon(r.icon, 22), el('span', { class: 'nav-label' }, r.label), countBadge(r))),
    moreBtn);
  tabbar.addEventListener('click', (e) => { if (e.target.closest('a[href]')) closeMore(); });

  const view = el('div', { id: 'view', tabindex: '-1' });
  const main = el('main', { class: 'main', id: 'main' }, view);
  const shell = el('div', { class: 'shell' }, parts.node, el('div', { class: 'shell-main' }, topbar, main));
  app.append(shell, tabbar);
  rail = railController(shell, parts);

  onConnection((c) => {
    connNodes = connNodes.filter((n) => n.node.isConnected);
    for (const n of connNodes) paintConn(n, c);
  });
}

function editableTarget(t) {
  return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

function shellKeys() {
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      if (document.querySelector('.modal-backdrop')) return;
      e.preventDefault();
      if (palette.isOpen()) palette.close(); else palette.open(document.activeElement);
      return;
    }
    if (e.key === '[' && !e.metaKey && !e.ctrlKey && !e.altKey && !editableTarget(e.target)
      && !palette.isOpen() && !document.querySelector('.modal-backdrop, .drawer, .more-layer') && window.innerWidth > 760) {
      e.preventDefault();
      rail.togglePin();
    }
  });
}

function markActive() {
  const id = current.route;
  const tabbed = ROUTES.find((r) => r.id === id)?.tab;
  for (const a of document.querySelectorAll('[data-route]')) {
    const on = a.dataset.route === id || (a.dataset.route === 'more' && !tabbed);
    a.classList.toggle('is-active', on);
    if (a.tagName === 'A') { if (a.dataset.route === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
  }
}

function updateBadges() {
  const unread = state.leads.filter((l) => l.unread && !l.archived).length;
  navCounts = navCounts.filter((c) => c.isConnected);
  for (const c of navCounts) {
    c.hidden = !unread;
    c.textContent = unread > 99 ? '99+' : String(unread);
    c.setAttribute('aria-label', `${unread} unread`);
  }
  const r = ROUTES.find((x) => x.id === current.route);
  document.title = `${unread ? `(${unread}) ` : ''}${r ? `${r.label} · ` : ''}Wise AI OS`;
}

function parseHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [route, ...rest] = raw.split('/');
  const known = ROUTES.find((r) => r.id === route);
  return { route: known ? route : 'home', param: known && rest.length ? rest.join('/') : null };
}

function errorCard(title, err, retry) {
  return el('div', { class: 'page' },
    el('div', { class: 'card err-card' },
      el('div', { class: 'empty' },
        el('div', { class: 'empty-icon' }, icon('alert', 22)),
        el('p', { class: 'empty-title' }, title),
        el('p', { class: 'muted' }, err?.message ? String(err.message).slice(0, 300) : 'Something went wrong loading this section.'),
        retry ? el('div', { class: 'row' }, el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: retry }, icon('refresh', 14), 'Try again')) : null)));
}

function skeleton() {
  return el('div', { class: 'page', 'aria-busy': 'true' },
    el('div', { class: 'skeleton', style: 'height:120px' }),
    el('div', { class: 'grid cols-3' }, el('div', { class: 'skeleton', style: 'height:90px' }), el('div', { class: 'skeleton', style: 'height:90px' }), el('div', { class: 'skeleton', style: 'height:90px' })),
    el('div', { class: 'skeleton', style: 'height:260px' }));
}

async function loadView(routeId) {
  if (viewCache.has(routeId)) return viewCache.get(routeId);
  const r = ROUTES.find((x) => x.id === routeId);
  const mod = await r.view();
  if (typeof mod.default !== 'function') throw new Error(`The ${r.label} module has no default view export.`);
  viewCache.set(routeId, mod);
  return mod;
}

let renderSeq = 0;
async function render({ navigated = false } = {}) {
  const { route, param } = parseHash();
  const view = $('#view');
  if (!view) return;
  const seq = ++renderSeq;
  const sameRoute = current.route === route && current.param === param;
  current.route = route;
  current.param = param;
  markActive();
  updateBadges();
  if (!state.loaded) { clear(view).append(skeleton()); return; }
  let mod;
  try {
    mod = await loadView(route);
  } catch (err) {
    if (seq !== renderSeq) return;
    current.node = null;
    clear(view).append(errorCard(`${ROUTES.find((r) => r.id === route).label} could not load`, err, () => { viewCache.delete(route); render(); }));
    return;
  }
  if (seq !== renderSeq) return;
  let node;
  try {
    node = mod.default({ state, param });
  } catch (err) {
    node = errorCard('This section hit a problem', err, () => render());
    setTimeout(() => { throw err; }, 0);
  }
  const y = window.scrollY;
  current.node = node;
  clear(view).append(node);
  if (navigated && !sameRoute) {
    window.scrollTo(0, 0);
    view.focus({ preventScroll: true });
  } else {
    window.scrollTo(0, y);
  }
}

function onStateChange() {
  updateBadges();
  if (!current.node || !state.loaded) return;
  if (typeof current.node.onState === 'function') {
    try { current.node.onState(); } catch (err) { setTimeout(() => { throw err; }, 0); }
  } else if (!document.querySelector('.modal-backdrop')) {
    render();
  } else {
    pendingRender = true;
  }
}
let pendingRender = false;
// A modal owns the screen: re-render the view underneath once it closes.
new MutationObserver(() => {
  if (pendingRender && !document.querySelector('.modal-backdrop')) { pendingRender = false; render(); }
}).observe(document.body, { childList: true });

/* --------------------------------------------------------- live toasts */
function watchEvents() {
  onRealtime(({ table, type, row }) => {
    if (table !== 'events' || type !== 'INSERT' || !row) return;
    const lead = row.lead_id ? leadById(row.lead_id) : null;
    const who = lead ? leadName(lead) : null;
    if (row.kind === 'sms_reply') toast(who ? `New reply from ${who}` : 'New SMS reply', 'info');
    else if (row.kind === 'booking') toast(who ? `New booking: ${who}` : 'New booking', 'ok');
    else if (row.kind === 'website_lead') toast(who ? `New website lead: ${who}` : 'New website lead', 'info');
    else if (row.kind === 'opt_out') toast(who ? `${who} opted out` : 'Someone opted out', 'warn');
    else if (row.kind === 'booking_cancelled') toast(who ? `Booking cancelled: ${who}` : 'A booking was cancelled', 'warn');
  });
}

/* ------------------------------------------------------------- idle lock */
function idleLock() {
  let last = Date.now();
  const bump = () => { last = Date.now(); };
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) window.addEventListener(ev, bump, { passive: true });
  const check = () => { if (Date.now() - last > IDLE_MS) lock(); };
  setInterval(check, 30000);
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    check();
    // Back after a while: realtime may have missed changes while the device slept.
    if (hiddenAt && Date.now() - hiddenAt > 120000) loadAll().catch(() => {});
  });
}

/* ------------------------------------------------------------------ boot */
async function boot(gate) {
  if (booted) return;
  booted = true;
  gate?.destroy();
  renderShell();
  palette = createPalette({ routes: ROUTES, onLock: () => lock(), onTogglePin: () => rail.togglePin() });
  shellKeys();
  window.addEventListener('hashchange', () => render({ navigated: true }));
  onChange(onStateChange);
  watchEvents();
  idleLock();
  render({ navigated: true });
  const load = async () => {
    try {
      await loadAll();
      subscribe();
      render();
    } catch (err) {
      const view = $('#view');
      if (view) clear(view).append(errorCard('Could not load your data', err, load));
    }
  };
  await load();
  setInterval(() => refreshSmsStatus(), 5 * 60 * 1000);
}

const gate = renderGate();
sb.auth.onAuthStateChange((event, session) => {
  if (session && !booted) setTimeout(() => boot(gate), 0);
});
// Escape hatch for links like #leads/<id> before unlocking: they still resolve after boot.
export { ROUTES, go };
