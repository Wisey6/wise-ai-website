// Wise AI OS shell: PIN gate, router, navigation, idle lock, live indicators.
import { el, $, clear, icon, toast, go, trapFocus } from './ui.js?v=20261119b';
import { createPalette } from './palette.js?v=20261119b';
import {
  sb, state, login, lock, loadAll, subscribe, onChange, onRealtime, onConnection,
  refreshSmsStatus, knownPinLength, leadById, leadName,
  who, lastWho, pinLengthFor, resetRequest, resetConfirm, isMine
} from './api.js?v=20261119b';
import { ownerBadge, initialsOf } from './owners.js?v=20261119b';

/* ------------------------------------------------------------ route registry
   The single source of truth for navigation. Top-level entries are either a
   section or a group of sections; `soon: true` marks a planned section (shown
   dimmed, never a link). Making a section real is a one-line change: drop
   `soon` and add `view` (a lazy import whose default export is (ctx) => Node).
   `tab` marks the routes in the phone tab bar (max 4); `foot` puts a section at
   the foot of the collapsed dock; `href` links out (new tab). */
export const NAV = [
  { id: 'home', label: 'Today', icon: 'home', tab: true, view: () => import('./views/home.js?v=20261119b') },
  { group: 'Grow', icon: 'grow', items: [
    { id: 'leads', label: 'Leads', icon: 'leads', tab: true, view: () => import('./views/leads.js?v=20261119b') },
    { id: 'inbox', label: 'Inbox', icon: 'inbox', tab: true, badge: 'unread', view: () => import('./views/inbox.js?v=20261119b') },
    { id: 'campaigns', label: 'Campaigns', icon: 'send', tab: true, view: () => import('./views/campaigns.js?v=20261119b') },
    { id: 'bookings', label: 'Bookings', icon: 'calendar', view: () => import('./views/bookings.js?v=20261119b') }
  ] },
  { group: 'Sell', icon: 'tag', items: [
    { id: 'pipeline', label: 'Pipeline', icon: 'tag', view: () => import('./views/pipeline.js?v=20261119b') },
    { id: 'proposals', label: 'Proposals', icon: 'book', view: () => import('./views/proposals.js?v=20261119b') },
    { id: 'roi-calculator', label: 'ROI calculator', icon: 'dollar', href: '../roi.html' }
  ] },
  { group: 'Deliver', icon: 'deliver', items: [
    { id: 'clients', label: 'Clients', icon: 'leads', view: () => import('./views/clients.js?v=20261119b') },
    { id: 'projects', label: 'Projects', icon: 'deliver', view: () => import('./views/projects.js?v=20261119b') },
    { id: 'roi-reports', label: 'ROI reports', icon: 'spark', view: () => import('./views/roi-reports.js?v=20261119b') }
  ] },
  { group: 'Money', icon: 'money', items: [
    { id: 'income', label: 'Income', icon: 'money', view: () => import('./views/income.js?v=20261119b') },
    { id: 'costs', label: 'Costs', icon: 'money', view: () => import('./views/costs.js?v=20261119b') },
    { id: 'runway', label: 'Runway', icon: 'spark', view: () => import('./views/runway.js?v=20261119b') }
  ] },
  { group: 'Know', icon: 'book', items: [
    { id: 'playbook', label: 'Playbook', icon: 'book', view: () => import('./views/playbook.js?v=20261119b') },
    { id: 'library', label: 'Library', icon: 'book', view: () => import('./views/library.js?v=20261119b') },
    { id: 'files', label: 'Files', icon: 'archive', view: () => import('./views/files.js?v=20261119b') }
  ] },
  { sep: true },
  { id: 'agents', label: 'Agents', icon: 'agents', badge: 'approvals', view: () => import('./views/agents.js?v=20261119b') },
  { id: 'settings', label: 'Settings', icon: 'settings', foot: true, view: () => import('./views/settings.js?v=20261119b') }
];
const NAV_ITEMS = NAV.flatMap((n) => (n.items ? n.items.map((i) => Object.assign(i, { area: n.group })) : n.sep ? [] : [n]));
/** Live sections (the ones with a view), in navigation order. */
const ROUTES = NAV_ITEMS.filter((r) => r.view);
const groupSoon = (g) => g.items.every((i) => i.soon || i.href);
const IDLE_MS = 15 * 60 * 1000;
const LOGO = '../logo.svg';
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const SHORTCUT = IS_MAC ? '⌘K' : 'Ctrl K';

const app = $('#app');
let booted = false;

/* ================================================================ PIN gate */

function renderGate() {
  // Windows-style lock: a resting screen with the clock; clicking or typing opens
  // "who is signing in" (the person last here is preselected), then that person's
  // numbers-only PIN field. No on-screen keypad. Forgot PIN and the emailed reset
  // link (#reset/<token>) are steps of the same screen.
  let busy = false;
  let countdownTimer = null;
  let step = 'rest';           // rest | people | pin | forgot | reset
  let people = null;           // [{id, name, initials}] once known; [] = picker unavailable
  let chosen = null;           // the person whose PIN field is showing (null = the owner, fallback)
  let firstDigitWaiting = '';
  const lockedUntil = new Map(); // per person: member id (or 'owner') → ms
  const lockKey = () => chosen?.id || 'owner';

  const resetMatch = /^#reset\/([A-Za-z0-9_-]{16,256})$/.exec(location.hash || '');
  const resetToken = resetMatch ? resetMatch[1] : null;

  // Auto-submit only when this device knows the PIN's length for that person.
  const storedLen = () => { try { return Number(localStorage.getItem('wiseos.pinlen')) || 0; } catch { return 0; } };
  const lenFor = () => (chosen ? pinLengthFor(chosen.id) : storedLen());

  const peopleReady = who().then((list) => { people = Array.isArray(list) ? list : []; return people; }).catch(() => { people = []; return people; });

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

  const pinInput = (name, label, placeholder) => el('input', {
    class: 'pin-input', type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '12',
    autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
    placeholder, 'aria-label': label, name
  });
  const digitsOnly = (inp, onInput) => {
    inp.addEventListener('beforeinput', (e) => {
      if (e.data && /\D/.test(e.data) && e.inputType !== 'insertFromPaste') e.preventDefault();
    });
    inp.addEventListener('input', () => {
      const clean = inp.value.replace(/\D/g, '').slice(0, 12);
      if (clean !== inp.value) inp.value = clean;
      onInput?.(clean);
    });
  };

  const input = pinInput('wiseos-pin', 'PIN', 'PIN');
  const go = el('button', { type: 'submit', class: 'pin-go', 'aria-label': 'Unlock' }, icon('arrow', 18));
  const field = el('form', { class: 'pin-field', novalidate: true }, input, go);

  const unlockBtn = el('button', { type: 'button', class: 'gate-unlock', 'aria-label': 'Unlock Wise AI OS' },
    el('span', { class: 'gate-unlock-ring' }, icon('lock', 22)),
    el('span', { class: 'gate-unlock-label' }, 'Click to unlock'));

  const panel = el('div', { class: 'gate-panel' }, unlockBtn);
  const REST_FOOT = 'Click the lock, or start typing your PIN';
  const foot = el('span', {}, REST_FOOT);

  const setDisabled = (d) => { input.disabled = d; go.disabled = d; };
  const fillNode = (node, ...kids) => { clear(node); node.append(...kids.flat().filter(Boolean)); };

  const shake = (node = field) => {
    node.classList.remove('is-shake');
    void node.offsetWidth;
    node.classList.add('is-shake');
    setTimeout(() => node.classList.remove('is-shake'), 450);
  };

  const ring = (p, size = 'lg') => el('span', { class: `gate-ring is-${size}`, 'aria-hidden': 'true' },
    p ? (String(p.initials || '').trim() || String(p.name || '?').trim().slice(0, 1)).toUpperCase().slice(0, 3) : icon('lock', 20));

  const pinHint = () => (lenFor() ? 'Enter your PIN' : 'Enter your PIN, then press Enter');

  const startCountdown = (secs, key = lockKey()) => {
    lockedUntil.set(key, Date.now() + secs * 1000);
    paintCountdown();
  };
  function paintCountdown() {
    clearInterval(countdownTimer);
    const until = lockedUntil.get(lockKey()) || 0;
    if (step !== 'pin' || Date.now() >= until) { if (step === 'pin') setDisabled(false); return; }
    setDisabled(true);
    const tickDown = () => {
      const left = Math.max(0, Math.ceil(((lockedUntil.get(lockKey()) || 0) - Date.now()) / 1000));
      if (!left || step !== 'pin') {
        clearInterval(countdownTimer);
        if (step === 'pin') { setDisabled(false); setHint(pinHint()); input.focus(); }
        return;
      }
      const m = Math.floor(left / 60);
      const sec = String(left % 60).padStart(2, '0');
      setHint(`Too many attempts. Try again in ${m}:${sec}`, 'bad');
    };
    tickDown();
    countdownTimer = setInterval(tickDown, 1000);
  }

  const submit = async () => {
    if (busy || Date.now() < (lockedUntil.get(lockKey()) || 0)) return;
    const pin = input.value;
    if (pin.length < 4) {
      if (pin.length) { setHint('PINs are at least 4 digits', 'warn'); shake(); }
      return;
    }
    busy = true;
    field.classList.add('is-busy');
    setDisabled(true);
    setHint('Unlocking…');
    const who0 = chosen;
    const res = await login(pin, who0?.id);
    busy = false;
    field.classList.remove('is-busy');
    if (res.ok) {
      setHint(who0 ? `Welcome back, ${who0.name}` : 'Welcome back');
      return; // the auth listener boots the shell
    }
    input.value = '';
    if (res.error === 'locked') {
      shake();
      startCountdown(Number(res.retry_after_s) || 300, who0?.id || 'owner');
      return;
    }
    setDisabled(false);
    input.focus();
    if (res.error === 'bad_pin') {
      shake();
      const r = Number(res.remaining);
      setHint(Number.isFinite(r) && res.remaining !== null && res.remaining !== undefined
        ? `That PIN didn't match. ${r} attempt${r === 1 ? '' : 's'} left before a lockout.`
        : "That PIN didn't match.", 'bad');
      if (navigator.vibrate) navigator.vibrate(120);
    } else if (res.error === 'network' || res.error === 'not_deployed') {
      setHint("Can't reach the sign-in service. Check your connection and try again.", 'warn');
    } else {
      setHint(`Sign-in failed (${res.error}). Try again in a moment.`, 'warn');
    }
  };

  digitsOnly(input, (clean) => {
    if (hint.classList.contains('is-bad') || hint.classList.contains('is-warn') || hint.classList.contains('is-ok')) {
      if (Date.now() >= (lockedUntil.get(lockKey()) || 0)) setHint(pinHint());
    }
    const n = lenFor();
    if (n >= 4 && clean.length === n) submit();
  });
  field.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

  const linkBtn = (label, onClick, data) => el('button', { type: 'button', class: 'gate-link', dataset: data || {}, onClick }, label);
  const lastPerson = () => (people || []).find((p) => p.id === (chosen?.id || lastWho())) || null;

  /* ---------------------------------------------------------------- steps */
  function setStep(s, footText) {
    step = s;
    gate.dataset.step = s;
    gate.classList.toggle('is-open', s !== 'rest');
    foot.textContent = footText;
    clearInterval(countdownTimer);
  }

  function showRest() {
    if (busy) return;
    setStep('rest', REST_FOOT);
    input.value = '';
    fillNode(panel, unlockBtn);
    unlockBtn.focus();
  }

  function showPeople(note = '') {
    setStep('people', 'Choose who is signing in · Esc to go back');
    const pre = lastPerson();
    const btns = people.map((p) => el('button', {
      type: 'button', class: `gate-person${pre && pre.id === p.id ? ' is-last' : ''}`, dataset: { member: p.id },
      'aria-label': `${p.name}${pre && pre.id === p.id ? ' (signed in last on this device)' : ''}`,
      onClick: () => showPin(p)
    }, ring(p, 'lg'), el('span', { class: 'gate-person-name' }, p.name)));
    const list = el('div', { class: 'gate-people', role: 'group', 'aria-label': 'Who is signing in' }, btns);
    list.addEventListener('keydown', (e) => {
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
    });
    fillNode(panel, el('p', { class: 'gate-ask' }, 'Who is signing in?'), list, hint);
    setHint(note || '', note ? 'ok' : '');
    (btns.find((b) => b.dataset.member === pre?.id) || btns[0])?.focus();
  }

  function showPin(person, digit = '', note = '') {
    chosen = person || null;
    setStep('pin', 'Numbers only · Esc to go back');
    const multi = (people || []).length > 1;
    const links = el('div', { class: 'gate-links' },
      multi ? linkBtn('Not you?', () => showPeople(), { act: 'not-you' }) : null,
      multi && chosen ? el('span', { class: 'gate-sep', 'aria-hidden': 'true' }) : null,
      chosen ? linkBtn('Forgot PIN?', () => showForgot(), { act: 'forgot' }) : null);
    fillNode(panel,
      chosen ? el('div', { class: 'gate-who', dataset: { member: chosen.id } }, ring(chosen, 'lg'), el('span', { class: 'gate-who-name' }, chosen.name)) : null,
      field, hint, links.childNodes.length ? links : null);
    input.value = '';
    setHint(note || pinHint(), note ? 'ok' : '');
    setDisabled(false);
    input.focus();
    if (digit) { input.value = digit; input.dispatchEvent(new Event('input', { bubbles: true })); }
    paintCountdown();
  }

  function showForgot() {
    if (!chosen) return;
    const p = chosen;
    setStep('forgot', 'Esc to go back');
    const send = el('button', { type: 'button', class: 'gate-btn is-primary', dataset: { act: 'send-reset' } }, 'Email me a reset link');
    const back = linkBtn('Back to sign in', () => showPin(p), { act: 'back' });
    const msg = el('p', { class: 'gate-msg' }, `We will email a one-time link to the address on file for ${p.name}. It lasts 20 minutes.`);
    const actions = el('div', { class: 'gate-actions' }, send, back);
    fillNode(panel, el('div', { class: 'gate-who' }, ring(p, 'lg'), el('span', { class: 'gate-who-name' }, 'Forgot your PIN?')), msg, actions, hint);
    setHint('');
    send.focus();
    send.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      send.disabled = true;
      setHint('Sending…');
      const r = await resetRequest(p.id);
      busy = false;
      if (r.ok) {
        msg.textContent = `If there is an email on file for ${p.name}, a reset link is on its way. It lasts 20 minutes.`;
        fillNode(actions, linkBtn('Back to sign in', () => showPin(p), { act: 'back' }));
        setHint('');
        actions.querySelector('button')?.focus();
        return;
      }
      send.disabled = false;
      const owner = (people || [])[0];
      if (r.error === 'email_not_configured') {
        msg.textContent = owner && owner.id !== p.id
          ? `Email is not set up yet. Ask ${owner.name} to reset your PIN in Settings.`
          : 'Email is not set up yet, so a reset link cannot be sent.';
        fillNode(actions, linkBtn('Back to sign in', () => showPin(p), { act: 'back' }));
        setHint('');
        actions.querySelector('button')?.focus();
      } else if (r.error === 'too_many') {
        setHint('Too many reset requests. Try again in an hour.', 'warn');
      } else {
        setHint(r.message || 'That did not work. Try again.', 'warn');
      }
    });
  }

  function showReset(token) {
    setStep('reset', 'Numbers only, 4 to 12 digits');
    const a = pinInput('new-pin', 'New PIN', 'New PIN');
    const b = pinInput('new-pin-again', 'New PIN again', 'New PIN again');
    const save = el('button', { type: 'submit', class: 'gate-btn is-primary', dataset: { act: 'save-pin' } }, 'Save new PIN');
    const form = el('form', { class: 'gate-reset', novalidate: true },
      el('div', { class: 'pin-field is-plain' }, a), el('div', { class: 'pin-field is-plain' }, b), save);
    digitsOnly(a, () => setHint(''));
    digitsOnly(b, () => setHint(''));
    const done = () => { try { history.replaceState(null, '', location.pathname + location.search); } catch { /* */ } };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      if (!/^\d{4,12}$/.test(a.value)) { setHint('A PIN is 4 to 12 digits.', 'warn'); shake(a.parentNode); a.focus(); return; }
      if (a.value !== b.value) { setHint('The two PINs do not match.', 'warn'); shake(b.parentNode); b.focus(); return; }
      busy = true;
      save.disabled = true;
      setHint('Saving…');
      const r = await resetConfirm(token, a.value);
      busy = false;
      save.disabled = false;
      if (r.ok) {
        done();
        await peopleReady;
        const p = lastPerson();
        if ((people || []).length > 1 && !p) showPeople('PIN changed. Sign in with the new one.');
        else showPin(p || (people || [])[0] || null, '', 'PIN changed. Sign in with the new one.');
        return;
      }
      if (r.error === 'bad_token') {
        done();
        fillNode(panel,
          el('div', { class: 'gate-who' }, ring(null, 'lg'), el('span', { class: 'gate-who-name' }, 'That link has expired')),
          el('p', { class: 'gate-msg' }, 'Reset links last 20 minutes and work once. Ask for a new one from the sign-in screen.'),
          el('div', { class: 'gate-actions' }, linkBtn('Back to sign in', () => openSignIn(), { act: 'back' })), hint);
        setHint('');
        panel.querySelector('.gate-actions button')?.focus();
        return;
      }
      setHint(r.error === 'weak_pin' ? 'A PIN is 4 to 12 digits.' : (r.message || 'That did not work. Try again.'), 'warn');
    });
    fillNode(panel, el('div', { class: 'gate-who' }, ring(null, 'lg'), el('span', { class: 'gate-who-name' }, 'Choose a new PIN')), form, hint,
      el('div', { class: 'gate-links' }, linkBtn('Cancel', () => { done(); showRest(); }, { act: 'cancel' })));
    setHint('');
    a.focus();
  }

  async function openSignIn(digit = '') {
    if (step !== 'rest' && step !== 'reset' && step !== 'forgot') return;
    if (people === null) {
      firstDigitWaiting += digit;
      gate.classList.add('is-open');
      const list = await peopleReady;
      digit = firstDigitWaiting;
      firstDigitWaiting = '';
      if (step !== 'rest' && step !== 'reset' && step !== 'forgot') return;
      if (!list) return;
    }
    if (!people.length) { showPin(null, digit); return; }          // picker unavailable: the owner's PIN field
    if (people.length === 1) { showPin(people[0], digit); return; }
    const p = lastPerson();
    if (p) showPin(p, digit);
    else showPeople(digit ? '' : '');
  }

  unlockBtn.addEventListener('click', () => openSignIn());

  const gate = el('div', { class: 'gate', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Wise AI OS is locked', dataset: { step: 'rest' } },
    el('div', { class: 'gate-top' },
      el('div', { class: 'gate-brand' }, el('img', { src: LOGO, alt: 'Wise AI' }), el('span', { class: 'os-tag' }, 'OS')),
      el('div', { class: 'gate-lock', 'aria-hidden': 'true' }, icon('lock', 13), 'Locked')),
    el('div', { class: 'gate-time' }, clock, date),
    panel,
    el('div', { class: 'gate-foot' }, foot)
  );

  // Clicking anywhere on the resting screen opens sign-in, as on Windows.
  gate.addEventListener('click', (e) => {
    if (step === 'rest' && !e.target.closest('button, a, input')) openSignIn();
  });

  const back = () => {
    if (busy) return;
    if (step === 'pin') {
      if ((people || []).length > 1) showPeople(); else showRest();
    } else if (step === 'forgot') showPin(chosen);
    else if (step === 'people') showRest();
  };

  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (step === 'rest') {
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); openSignIn(e.key); }
      else if (e.key === 'Enter' || e.key === ' ') { if (document.activeElement === unlockBtn || !gate.contains(document.activeElement)) { e.preventDefault(); openSignIn(); } }
      else if (e.key === 'Tab') trapFocus(e, gate);
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); back(); }
    else if (e.key === 'Tab') trapFocus(e, gate);
    else if (step === 'pin' && document.activeElement !== input && /^[0-9]$/.test(e.key) && !input.disabled) {
      // A digit typed while focus is elsewhere still lands in the field.
      e.preventDefault();
      input.focus();
      input.value = (input.value + e.key).slice(0, 12);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (step === 'people' && /^[0-9]$/.test(e.key)) {
      setHint('Choose who is signing in first', 'warn');
    }
  };
  document.addEventListener('keydown', onKey);

  document.body.append(gate);
  if (resetToken) showReset(resetToken);

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
let meNodes = [];
let palette = null;
let rail = null;

const soonTag = () => el('span', { class: 'soon-tag' }, 'Soon');

function countBadge(r, cls = 'nav-count') {
  if (r.badge !== 'unread' && r.badge !== 'approvals') return null;
  const c = el('span', { class: cls, hidden: true, dataset: { count: r.badge } });
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

/** Who is signed in: initials + name (or the ring alone in the dock). Repainted on state changes. */
function meChip(variant = 'full') {
  const node = el('a', { class: `me-chip is-${variant}`, href: '#settings', dataset: { me: '' }, tabindex: variant === 'dock' ? '-1' : null });
  meNodes.push({ node, variant });
  paintMe({ node, variant });
  return node;
}
function paintMe({ node, variant }) {
  const me = state.me;
  const key = me ? `${me.id}|${me.name}|${(state.team || []).length}` : '';
  if (node.dataset.key === key) return;
  node.dataset.key = key;
  node.hidden = !me;
  if (!me) return;
  node.title = `Signed in as ${me.name}. Your sign-in settings`;
  node.setAttribute('aria-label', `Signed in as ${me.name}. Open your sign-in settings`);
  const ring = me.id && (state.team || []).some((m) => m.id === me.id)
    ? ownerBadge(me.id, { size: variant === 'dock' ? 'md' : 'sm', title: false })
    : el('span', { class: 'own-ring is-sm is-me' }, initialsOf(me) || '?');
  node.replaceChildren(ring, ...(variant === 'dock' ? [] : [el('span', { class: 'me-chip-name' }, me.name)]));
}
function updateMe() {
  meNodes = meNodes.filter((n) => n.node.isConnected);
  for (const n of meNodes) paintMe(n);
}

function searchTrigger(cls, compact = false) {
  return el('button', {
    type: 'button', class: cls, dataset: { palette: '' }, 'aria-haspopup': 'dialog',
    'aria-keyshortcuts': 'Control+K Meta+K', 'aria-label': compact ? `Search or jump to (${SHORTCUT})` : null,
    onClick: (e) => palette?.open(e.currentTarget)
  }, icon('search', compact ? 19 : 15), compact ? null : el('span', { class: 'nav-search-ph' }, 'Search or jump to…'), compact ? null : el('kbd', {}, SHORTCUT));
}

/* -------------------------------------------------------------- the rail
   Desktop (>= 1100px): the sidebar is OPEN by default, a fixed-width list of
   every group and its pages, the current page marked. Nothing on it moves when
   the pointer passes over it. The toggle in its head (or `[`) folds it into the
   64px icon strip; the choice is remembered on this device (wiseos.sidebar).
   Folded (the default from 761px to 1099px): one icon per group that never
   moves. Hovering or focusing a group's icon shows a small flyout right beside
   it with that group's pages; single-page items show a tooltip. Only one of the
   two halves is live at a time (the other is inert). */
const SIDEBAR_KEY = 'wiseos.sidebar';

function buildRail() {
  const toggleBtn = el('button', { type: 'button', class: 'rail-toggle', 'aria-controls': 'rail', dataset: { navToggle: 'collapse' } }, icon('panel', 17));
  const full = el('div', { class: 'rail-full' },
    el('div', { class: 'rail-head' },
      el('a', { class: 'rail-brand', href: '#home', 'aria-label': 'Wise AI OS home' },
        el('img', { src: LOGO, alt: 'Wise AI' }), el('span', { class: 'os-tag' }, 'OS')),
      toggleBtn),
    el('div', { class: 'rail-search' }, searchTrigger('nav-search')),
    navMap('rail'),
    el('div', { class: 'rail-foot' },
      meChip(),
      connIndicator(),
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-lock', onClick: () => lock(), title: 'Lock (signs out)' },
        icon('lock', 15), el('span', { class: 'lbl' }, 'Lock'))));

  // The folded strip: one icon per AREA (Today, Grow, Sell, Deliver, Money, Know,
  // Agents), lit when the current route is inside it. Grow carries the unread
  // count, Agents the approvals count. Each group icon owns a flyout (its pages).
  const tipped = (node, tip) => { node.dataset.tip = tip; return node; };
  const dockItem = (r) => tipped(el('a', { class: 'dock-item dock-nav', href: `#${r.id}`, 'aria-label': r.label, dataset: { route: r.id } },
    icon(r.icon, 19), countBadge(r, 'dock-count')), r.label);
  const flyEntry = (r) => (r.href
    ? el('a', { class: 'fly-item is-external', href: r.href, target: '_blank', rel: 'noopener' },
      el('span', { class: 'nav-label' }, r.label), el('span', { class: 'nav-ext' }, icon('external', 12)), el('span', { class: 'sr-only' }, ' (opens in a new tab)'))
    : el('a', { class: 'fly-item', href: `#${r.id}`, dataset: { route: r.id } }, el('span', { class: 'nav-label' }, r.label), countBadge(r)));
  const areaItem = (g, i) => {
    const live = g.items.filter((it) => it.view);
    const badged = live.find((it) => it.badge);
    const id = `rail-fly-${i}`;
    const trig = el('a', {
      class: 'dock-item dock-area dock-nav', href: `#${live[0].id}`, 'aria-label': g.group, 'aria-expanded': 'false', 'aria-controls': id,
      dataset: { area: g.group, routes: live.map((it) => it.id).join(' ') }
    }, icon(g.icon, 19), badged ? countBadge(badged, 'dock-count') : null);
    const fly = el('div', { class: 'rail-fly', id, hidden: true, role: 'group', 'aria-label': `${g.group} pages`, dataset: { fly: g.group } },
      el('div', { class: 'rail-fly-box' },
        el('div', { class: 'rail-fly-head', 'aria-hidden': 'true' }, g.group),
        el('ul', { class: 'rail-fly-list' }, g.items.filter((it) => it.view || it.href).map((it) => el('li', {}, flyEntry(it))))));
    return el('div', { class: 'dock-slot', dataset: { slot: g.group } }, trig, fly);
  };
  const areas = NAV.filter((n) => !n.sep && !n.foot).map((n, i) => (n.items ? areaItem(n, i) : dockItem(n)));
  const expandBtn = tipped(el('button', { type: 'button', class: 'dock-item dock-expand dock-nav', 'aria-label': 'Expand sidebar', 'aria-controls': 'rail', 'aria-expanded': 'false', dataset: { navToggle: 'expand' } },
    icon('panel', 18)), 'Expand sidebar  [');
  const searchBtn = tipped(el('button', { type: 'button', class: 'dock-item dock-search dock-nav', 'aria-label': `Search or jump to (${SHORTCUT})`, 'aria-haspopup': 'dialog', dataset: { palette: '' }, onClick: (e) => palette?.open(e.currentTarget) },
    icon('search', 19)), `Search or jump to  ${SHORTCUT}`);
  const me = meChip('dock');
  me.classList.add('dock-nav');
  me.removeAttribute('tabindex');
  const tip = el('div', { class: 'rail-tip', 'aria-hidden': 'true', hidden: true });
  const dock = el('nav', { class: 'rail-dock', 'aria-label': 'Sections' },
    el('a', { class: 'dock-menu dock-nav', href: '#home', 'aria-label': 'Wise AI OS home' },
      el('span', { class: 'dock-mark' }, el('img', { src: LOGO, alt: '' }))),
    expandBtn,
    searchBtn,
    el('div', { class: 'dock-list' }, areas),
    el('div', { class: 'dock-foot' },
      ROUTES.filter((r) => r.foot).map(dockItem),
      connIndicator('conn-dock'),
      tipped(me, 'Your sign-in'),
      tipped(el('button', { type: 'button', class: 'dock-item dock-nav', 'aria-label': 'Lock', onClick: () => lock() }, icon('lock', 18)), 'Lock (signs out)')),
    tip);

  const node = el('aside', { class: 'rail', id: 'rail', 'aria-label': 'Main navigation' }, dock, full);
  return { node, full, dock, toggleBtn, expandBtn, tip };
}

function readSidebar() { try { return localStorage.getItem(SIDEBAR_KEY) === 'collapsed' ? 'collapsed' : 'open'; } catch { return 'open'; } }
function saveSidebar(v) { try { localStorage.setItem(SIDEBAR_KEY, v); } catch { /* private mode: this visit only */ } }

const inTri = ([x, y], [ax, ay], [bx, by], [cx, cy]) => {
  const s = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = s(x, y, ax, ay, bx, by); const d2 = s(x, y, bx, by, cx, cy); const d3 = s(x, y, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};

function railController(shell, parts) {
  const { node, full, dock, toggleBtn, expandBtn, tip } = parts;
  const wide = matchMedia('(min-width: 1100px)');
  let pref = readSidebar();   // the remembered choice for wide screens
  let midOpen = false;        // 761-1099px: opened for now, not remembered
  const isOpen = () => (wide.matches ? pref === 'open' : midOpen);

  /* ---------------------------------------------------------- open / folded */
  const apply = () => {
    const open = isOpen();
    const had = document.activeElement;
    shell.classList.toggle('nav-open', open);
    node.dataset.state = open ? 'open' : 'collapsed';
    node.classList.toggle('is-expanded', open);
    full.inert = !open;
    dock.inert = open;
    toggleBtn.setAttribute('aria-expanded', String(open));
    toggleBtn.setAttribute('aria-label', 'Collapse sidebar');
    toggleBtn.title = 'Collapse sidebar ( [ )';
    expandBtn.setAttribute('aria-expanded', String(open));
    if (open) { hideFly(); hideTip(); }
    // The toggle that was pressed disappears: keep focus on its twin.
    if (had === toggleBtn && !open) expandBtn.focus({ preventScroll: true });
    else if (had === expandBtn && open) toggleBtn.focus({ preventScroll: true });
  };
  function togglePin() {
    if (wide.matches) { pref = pref === 'open' ? 'collapsed' : 'open'; saveSidebar(pref); } else midOpen = !midOpen;
    apply();
  }
  toggleBtn.addEventListener('click', togglePin);
  expandBtn.addEventListener('click', togglePin);
  wide.addEventListener('change', () => { midOpen = false; apply(); });
  matchMedia('(min-width: 761px)').addEventListener('change', () => { midOpen = false; hideFly(); hideTip(); apply(); });

  // Arrow keys move through the open list, as Tab does.
  full.querySelector('.nav').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...full.querySelectorAll('.nav a.nav-item')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  });

  /* -------------------------------------------------------------- tooltips */
  let tipFor = null;
  let tTip = 0;
  let tipShownAt = 0;
  function showTip(target) {
    clearTimeout(tTip);
    if (isOpen() || !target.isConnected) return;
    tipFor = target;
    tip.textContent = target.dataset.tip;
    tip.hidden = false;
    const r = target.getBoundingClientRect();
    tip.style.left = `${Math.round(r.right + 10)}px`;
    tip.style.top = `${Math.round(r.top + r.height / 2 - tip.offsetHeight / 2)}px`;
    tipShownAt = Date.now();
  }
  function hideTip() { clearTimeout(tTip); tipFor = null; tip.hidden = true; }

  /* --------------------------------------------------------------- flyouts */
  const slots = [...dock.querySelectorAll('.dock-slot')].map((s) => ({ s, trig: s.querySelector('.dock-area'), fly: s.querySelector('.rail-fly') }));
  let openSlot = null;
  let hoverSlot = null;
  let suppress = null;        // after choosing, a slot stays shut until the pointer leaves it
  let lastPointer = 'mouse';
  let tOpen = 0;
  let tClose = 0;
  let tSwitch = 0;
  const trail = [];

  function place(slot) {
    const r = slot.trig.getBoundingClientRect();
    const f = slot.fly;
    // The flyout starts at the icon's right edge; its transparent left padding
    // bridges the gap to the panel, so the pointer never crosses empty space.
    f.style.left = `${Math.round(r.right)}px`;
    const h = f.offsetHeight;
    f.style.top = `${Math.round(Math.max(8, Math.min(r.top - 7, window.innerHeight - h - 8)))}px`;
  }
  function showFly(slot) {
    clearTimeout(tOpen); clearTimeout(tClose); clearTimeout(tSwitch);
    if (isOpen()) return;
    hideTip();
    if (openSlot === slot) return;
    if (openSlot) hideFly();
    openSlot = slot;
    slot.fly.hidden = false;
    place(slot);
    slot.s.classList.add('is-open');
    slot.trig.setAttribute('aria-expanded', 'true');
  }
  function hideFly() {
    clearTimeout(tOpen); clearTimeout(tClose); clearTimeout(tSwitch);
    const slot = openSlot;
    if (!slot) return;
    openSlot = null;
    const refocus = slot.fly.contains(document.activeElement);
    slot.fly.hidden = true;
    slot.s.classList.remove('is-open');
    slot.trig.setAttribute('aria-expanded', 'false');
    if (refocus) focusQuietly(slot.trig);
  }
  // Return focus to an icon without reopening its flyout.
  let quiet = false;
  function focusQuietly(n) { quiet = true; try { n.focus({ preventScroll: true }); } finally { quiet = false; } }
  const closeSoon = (ms = 280) => {
    clearTimeout(tClose);
    tClose = setTimeout(() => {
      if (openSlot && (openSlot.fly.matches(':hover') || openSlot.trig.matches(':hover'))) return;
      if (openSlot && openSlot.s.contains(document.activeElement) && document.activeElement.matches(':focus-visible')) return;
      hideFly();
    }, ms);
  };
  // Heading for the open flyout? Then brushing over a neighbouring icon on the way does not switch.
  function aimingAtOpen() {
    const now = performance.now();
    const recent = trail.filter((t) => now - t[2] < 250);
    if (!openSlot || recent.length < 2) return false;
    const [px, py] = recent[0];
    const [x, y] = recent[recent.length - 1];
    if (x <= px) return false;
    const b = openSlot.fly.querySelector('.rail-fly-box').getBoundingClientRect();
    return inTri([x, y], [px, py], [b.left, b.top - 24], [b.left, b.bottom + 24]);
  }
  node.addEventListener('pointermove', (e) => {
    lastPointer = e.pointerType || 'mouse';
    trail.push([e.clientX, e.clientY, performance.now()]);
    if (trail.length > 6) trail.shift();
  }, { passive: true });
  node.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType || 'mouse'; }, { passive: true });

  for (const slot of slots) {
    const { trig, fly } = slot;
    trig.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'touch') return;
      hoverSlot = slot;
      clearTimeout(tOpen); clearTimeout(tClose);
      if (suppress === slot || isOpen()) return;
      if (openSlot === slot) return;
      if (openSlot) {
        trail.push([e.clientX, e.clientY, performance.now()]);   // enter fires before the move
        if (aimingAtOpen()) {
          clearTimeout(tSwitch);
          tSwitch = setTimeout(() => { if (hoverSlot === slot && trig.matches(':hover')) showFly(slot); }, 160);
        } else showFly(slot);
        return;
      }
      tOpen = setTimeout(() => showFly(slot), 110);
    });
    trig.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'touch') return;
      if (hoverSlot === slot) hoverSlot = null;
      if (suppress === slot) suppress = null;
      clearTimeout(tOpen);
      if (openSlot === slot) closeSoon();
    });
    fly.addEventListener('pointerenter', () => { clearTimeout(tClose); clearTimeout(tSwitch); });
    fly.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch' && openSlot === slot) closeSoon(); });
    trig.addEventListener('focus', () => { if (!quiet && trig.matches(':focus-visible')) showFly(slot); });
    slot.s.addEventListener('focusout', (e) => {
      if (e.relatedTarget && slot.s.contains(e.relatedTarget)) return;
      if (openSlot === slot && !trig.matches(':hover') && !fly.matches(':hover')) hideFly();
    });
    trig.addEventListener('click', (e) => {
      // A tap on a touch screen opens the flyout first; a second tap goes to the first page.
      if (lastPointer === 'touch' && openSlot !== slot) { e.preventDefault(); showFly(slot); return; }
      suppress = slot;
      hideFly();
    });
    trig.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
        e.preventDefault();
        showFly(slot);
        fly.querySelector('a')?.focus();
      }
    });
    fly.addEventListener('keydown', (e) => {
      const links = [...fly.querySelectorAll('a')];
      const i = links.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        links[(i + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length]?.focus();
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        links[e.key === 'Home' ? 0 : links.length - 1]?.focus();
      } else if (e.key === 'ArrowLeft' || e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        hideFly();
        focusQuietly(trig);
      }
    });
    fly.addEventListener('click', (e) => {
      if (!e.target.closest('a[href]')) return;
      suppress = slot.trig.matches(':hover') ? slot : null;
      hideFly();
      if (document.activeElement && fly.contains(document.activeElement)) document.activeElement.blur();
    });
  }

  // Tooltips for the single-page icons and the tools.
  for (const t of dock.querySelectorAll('[data-tip]')) {
    t.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'touch' || isOpen()) return;
      hideFly();
      clearTimeout(tTip);
      tTip = setTimeout(() => showTip(t), Date.now() - tipShownAt < 600 ? 0 : 260);
    });
    t.addEventListener('pointerleave', () => { clearTimeout(tTip); if (!tip.hidden) { tipShownAt = Date.now(); hideTip(); } });
    t.addEventListener('focus', () => { if (t.matches(':focus-visible')) { hideFly(); showTip(t); } });
    t.addEventListener('blur', () => { if (tipFor === t) hideTip(); });
    t.addEventListener('click', () => hideTip());
  }

  // Up and down move through the strip's icons.
  dock.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...dock.querySelectorAll('.dock-nav')].filter((n) => !n.hidden);
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (openSlot || tipFor)) {
      const back = openSlot && openSlot.s.contains(document.activeElement) ? openSlot.trig : null;
      hideFly(); hideTip();
      if (back) focusQuietly(back);
    }
  });
  document.addEventListener('pointerdown', (e) => { if (openSlot && !openSlot.s.contains(e.target)) hideFly(); });
  dock.querySelector('.dock-list').addEventListener('scroll', () => { hideFly(); hideTip(); }, { passive: true });
  window.addEventListener('resize', () => { hideFly(); hideTip(); });
  window.addEventListener('hashchange', () => { hideFly(); hideTip(); });

  apply();
  return { togglePin, toggle: togglePin, close: hideFly, get pinned() { return isOpen(); }, get open() { return isOpen(); } };
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
      meChip(),
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
  meNodes = [];
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
  for (const a of document.querySelectorAll('.dock-area[data-routes]')) a.classList.toggle('is-active', a.dataset.routes.split(' ').includes(id));
}

function updateBadges() {
  // Unread replies on your own leads and on leads nobody owns yet.
  const unread = state.leads.filter((l) => l.unread && !l.archived && isMine(l)).length;
  const approvals = (state.agent_actions || []).filter((a) => a.status === 'proposed').length;
  navCounts = navCounts.filter((c) => c.isConnected);
  for (const c of navCounts) {
    const n = c.dataset.count === 'approvals' ? approvals : unread;
    c.hidden = !n;
    c.textContent = n > 99 ? '99+' : String(n);
    c.setAttribute('aria-label', c.dataset.count === 'approvals' ? `${n} waiting for approval` : `${n} unread`);
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

// Changes that only concern the assistant (its runs, chats, change log, memory, status).
// The command bar listens for these itself; the page behind it must not be rebuilt for
// them, or it flickers while the assistant works.
const ASSISTANT_ONLY = new Set(['agent_runs', 'agent_chats', 'agent_changes', 'agent_memory', 'agents']);
const ASSISTANT_PAGES = new Set(['agents']);
// Today and Settings show a little of the assistant (briefing, spend): refresh them once,
// after it has gone quiet, not on every step it takes.
const ASSISTANT_LATER = new Set(['home', 'settings']);
let laterTimer = 0;
function onStateChange(_state, changed) {
  updateBadges();
  updateMe();
  if (!current.node || !state.loaded) return;
  if (changed && changed.size && !changed.has('*') && [...changed].every((t) => ASSISTANT_ONLY.has(t)) && !ASSISTANT_PAGES.has(current.route)) {
    if (ASSISTANT_LATER.has(current.route)) {
      clearTimeout(laterTimer);
      laterTimer = setTimeout(() => { if (ASSISTANT_LATER.has(current.route) && !document.querySelector('.modal-backdrop') && typeof current.node?.onState !== 'function') render(); }, 4000);
    }
    return;
  }
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
    // Replies on someone else's lead are theirs to see; yours and unowned ones toast here.
    if (row.kind === 'sms_reply' && lead && !isMine(lead)) return;
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
  // The Wise AI agent launcher (top right; above the tab bar on phones). Loaded after the shell.
  import('./agent-dock.js?v=20261119b').then((m) => m.mountAgentDock()).catch((e) => setTimeout(() => { throw e; }, 0));
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
