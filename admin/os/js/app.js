// Wise AI OS shell: PIN gate, router, navigation, idle lock, live indicators.
import { el, $, clear, icon, toast, go, modal, trapFocus } from './ui.js';
import {
  sb, state, login, lock, loadAll, subscribe, onChange, onRealtime, onConnection,
  refreshSmsStatus, knownPinLength, leadById, leadName
} from './api.js';

/* ------------------------------------------------------------ route registry
   One line per section. `view` lazily imports a module whose default export is
   (ctx) => Node. `tab` marks the routes shown in the phone tab bar (max 4). */
const ROUTES = [
  { id: 'home', label: 'Today', icon: 'home', tab: true, view: () => import('./views/home.js') },
  { id: 'leads', label: 'Leads', icon: 'leads', tab: true, view: () => import('./views/leads.js') },
  { id: 'inbox', label: 'Inbox', icon: 'inbox', tab: true, view: () => import('./views/inbox.js') },
  { id: 'campaigns', label: 'Campaigns', icon: 'send', tab: true, view: () => import('./views/campaigns.js') },
  { id: 'bookings', label: 'Bookings', icon: 'calendar', view: () => import('./views/bookings.js') },
  { id: 'playbook', label: 'Playbook', icon: 'book', view: () => import('./views/playbook.js') },
  { id: 'settings', label: 'Settings', icon: 'settings', view: () => import('./views/settings.js') }
];
const IDLE_MS = 15 * 60 * 1000;
const LOGO = '../../logo.svg';

const app = $('#app');
let booted = false;

/* ================================================================ PIN gate */

function renderGate() {
  const pinLen = knownPinLength();
  let digits = [];
  let busy = false;
  let lockedUntil = 0;
  let longMode = pinLen > 6;
  let countdownTimer = null;

  const clock = el('div', { class: 'gate-clock', 'aria-hidden': 'true' });
  const date = el('div', { class: 'gate-date' });
  const tick = () => {
    const now = new Date();
    clock.textContent = now.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s?[ap]m$/i, '');
    date.textContent = now.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
  };
  tick();
  const clockTimer = setInterval(tick, 1000);

  const dots = el('div', { class: 'pin-dots', 'aria-hidden': 'true' });
  const live = el('div', { class: 'sr-only', 'aria-live': 'polite' });
  const hint = el('div', { class: 'gate-hint', role: 'status' }, 'Enter your PIN');

  const drawDots = () => {
    const n = Math.max(longMode ? Math.max(pinLen, 6) : pinLen, digits.length);
    clear(dots);
    for (let i = 0; i < n; i++) dots.append(el('span', { class: `pin-dot${i < digits.length ? ' is-filled' : ''}` }));
    live.textContent = `${digits.length} digit${digits.length === 1 ? '' : 's'} entered`;
  };

  const setHint = (text, tone = '') => { hint.textContent = text; hint.className = `gate-hint${tone ? ` is-${tone}` : ''}`; };

  const keys = [];
  const setDisabled = (d) => keys.forEach((k) => { k.disabled = d; });

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
        return;
      }
      const m = Math.floor(left / 60);
      const s = String(left % 60).padStart(2, '0');
      setHint(`Too many attempts. Try again in ${m}:${s}`, 'bad');
    };
    step();
    countdownTimer = setInterval(step, 1000);
  };

  const shake = () => {
    dots.classList.remove('is-shake');
    void dots.offsetWidth;
    dots.classList.add('is-shake');
    setTimeout(() => dots.classList.remove('is-shake'), 450);
  };

  const submit = async () => {
    if (busy || digits.length < 6 || Date.now() < lockedUntil) {
      if (digits.length && digits.length < 6) { setHint('PINs are at least 6 digits', 'warn'); shake(); }
      return;
    }
    busy = true;
    dots.classList.add('is-busy');
    setHint('Unlocking…');
    const pin = digits.join('');
    const res = await login(pin);
    busy = false;
    dots.classList.remove('is-busy');
    if (res.ok) {
      setHint('Welcome back');
      return; // the auth listener boots the shell
    }
    digits = [];
    drawDots();
    if (res.error === 'bad_pin') {
      shake();
      const r = Number(res.remaining);
      setHint(Number.isFinite(r)
        ? `That PIN didn't match. ${r} attempt${r === 1 ? '' : 's'} left before a lockout.`
        : "That PIN didn't match.", 'bad');
      if (navigator.vibrate) navigator.vibrate(120);
    } else if (res.error === 'locked') {
      shake();
      startCountdown(Number(res.retry_after_s) || 300);
    } else if (res.error === 'network' || res.error === 'not_deployed') {
      setHint("Can't reach the sign-in service. Check your connection and try again.", 'warn');
    } else {
      setHint(`Sign-in failed (${res.error}). Try again in a moment.`, 'warn');
    }
  };

  const press = (d) => {
    if (busy || Date.now() < lockedUntil) return;
    if (digits.length >= 12) return;
    digits.push(String(d));
    if (hint.classList.contains('is-bad') || hint.classList.contains('is-warn')) setHint('Enter your PIN');
    drawDots();
    if (!longMode && digits.length === pinLen) submit();
  };
  const back = () => { if (!busy) { digits.pop(); drawDots(); } };
  const reset = () => { if (!busy) { digits = []; drawDots(); } };

  const flash = (label) => {
    const k = keys.find((b) => b.dataset.k === label);
    if (!k) return;
    k.classList.add('is-pressed');
    setTimeout(() => k.classList.remove('is-pressed'), 120);
  };

  const key = (label, onClick, opts = {}) => {
    const b = el('button', {
      type: 'button', class: `key${opts.fn ? ' is-fn' : ''}`, 'aria-label': opts.aria || label, dataset: { k: opts.k || label },
      onClick: (e) => { e.currentTarget.blur(); onClick(); }
    }, opts.icon ? icon(opts.icon, 22) : label);
    keys.push(b);
    return b;
  };

  const keypad = el('div', { class: 'keypad', role: 'group', 'aria-label': 'PIN keypad' },
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => key(String(n), () => press(n))),
    key('Delete', back, { fn: true, icon: 'backspace', aria: 'Delete last digit', k: 'Backspace' }),
    key('0', () => press(0)),
    key('Enter', submit, { fn: true, icon: 'arrow', aria: 'Unlock', k: 'Enter' })
  );

  const longToggle = el('button', { type: 'button' });
  const drawLong = () => { longToggle.textContent = longMode ? 'Using a longer PIN · press Enter' : 'Longer PIN?'; };
  longToggle.addEventListener('click', () => { longMode = !longMode; digits = []; drawDots(); drawLong(); });
  drawLong();

  const gate = el('div', { class: 'gate', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Wise AI OS is locked' },
    el('div', { class: 'gate-time' }, clock, date),
    el('div', { class: 'gate-panel' },
      el('div', { class: 'gate-id' },
        el('div', { class: 'gate-avatar' }, el('img', { src: '../../favicon.png', alt: '' })),
        el('div', { class: 'gate-name' }, 'Wise AI OS')),
      dots, live, hint, keypad),
    el('div', { class: 'gate-foot' },
      el('span', {}, 'Type or tap your PIN'),
      longToggle)
  );

  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^[0-9]$/.test(e.key)) { e.preventDefault(); flash(e.key); press(Number(e.key)); }
    else if (e.key === 'Backspace') { e.preventDefault(); flash('Backspace'); back(); }
    else if (e.key === 'Enter') {
      if (document.activeElement && document.activeElement.closest && document.activeElement.closest('.gate-foot')) return;
      e.preventDefault(); flash('Enter'); submit();
    } else if (e.key === 'Escape') { reset(); setHint('Enter your PIN'); }
    else if (e.key === 'Tab') trapFocus(e, gate);
  };
  document.addEventListener('keydown', onKey);

  drawDots();
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
const navCounts = [];
const connNodes = [];

function navLink(r, cls) {
  const count = el('span', { class: 'nav-count', hidden: true, 'aria-label': '' });
  if (r.id === 'inbox') navCounts.push(count);
  return el('a', { class: cls, href: `#${r.id}`, dataset: { route: r.id } },
    icon(r.icon, cls === 'tab-item' ? 22 : 18),
    el('span', { class: 'nav-label' }, r.label),
    count);
}

function connIndicator() {
  const label = el('span', { class: 'conn-label' }, 'Connecting');
  const node = el('span', { class: 'conn', role: 'status', title: 'Live connection' }, el('span', { class: 'conn-dot' }), label);
  connNodes.push({ node, label });
  return node;
}

function openMore() {
  const items = ROUTES.filter((r) => !r.tab).map((r) => {
    const a = navLink(r, 'nav-item');
    a.addEventListener('click', () => setTimeout(() => $('.modal-backdrop .icon-btn')?.click(), 0));
    return a;
  });
  const lockBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-block', onClick: () => lock() }, icon('lock', 16), 'Lock now');
  modal({
    title: 'More',
    body: el('nav', { class: 'nav more-sheet', 'aria-label': 'More sections' }, items, el('div', { style: 'height:8px' }), lockBtn),
    hideConfirm: true,
    cancelLabel: 'Close'
  });
  markActive();
}

function renderShell() {
  clear(app);
  const nav = el('nav', { class: 'nav', 'aria-label': 'Sections' }, ROUTES.map((r) => navLink(r, 'nav-item')));
  const rail = el('aside', { class: 'rail' },
    el('a', { class: 'rail-brand', href: '#home', 'aria-label': 'Wise AI OS home' },
      el('img', { src: LOGO, alt: 'Wise AI' }), el('span', { class: 'os-tag' }, 'OS')),
    nav,
    el('div', { class: 'rail-foot' },
      connIndicator(),
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-lock', onClick: () => lock(), title: 'Lock (signs out)' },
        icon('lock', 15), el('span', { class: 'lbl' }, 'Lock'))));

  const topbar = el('header', { class: 'topbar' },
    el('a', { href: '#home', 'aria-label': 'Wise AI OS home' }, el('img', { src: LOGO, alt: 'Wise AI' })),
    connIndicator(),
    el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Lock', onClick: () => lock() }, icon('lock', 19)));

  const tabbar = el('nav', { class: 'tabbar', 'aria-label': 'Sections' },
    ROUTES.filter((r) => r.tab).slice(0, 4).map((r) => navLink(r, 'tab-item')),
    el('button', { type: 'button', class: 'tab-item', dataset: { route: 'more' }, onClick: openMore, 'aria-label': 'More sections' },
      icon('more', 22), el('span', {}, 'More')));

  const view = el('div', { id: 'view', tabindex: '-1' });
  const main = el('main', { class: 'main', id: 'main' }, view);
  app.append(el('div', { class: 'shell' }, rail, el('div', { style: 'min-width:0' }, topbar, main)), tabbar);

  onConnection((c) => {
    for (const { node, label } of connNodes) {
      node.className = `conn is-${c}`;
      label.textContent = c === 'live' ? 'Live' : c === 'offline' ? 'Offline' : 'Connecting';
      node.title = c === 'live' ? 'Live: updates arrive instantly' : c === 'offline' ? 'Offline: changes will not arrive' : 'Connecting to live updates';
    }
  });
}

function markActive() {
  const id = current.route;
  for (const a of document.querySelectorAll('[data-route]')) {
    const on = a.dataset.route === id || (a.dataset.route === 'more' && !ROUTES.find((r) => r.id === id)?.tab);
    a.classList.toggle('is-active', on);
    if (a.tagName === 'A') { if (a.dataset.route === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
  }
}

function updateBadges() {
  const unread = state.leads.filter((l) => l.unread && !l.archived).length;
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
