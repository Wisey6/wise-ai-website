// Wise AI OS shell: PIN gate, router, navigation, idle lock, live indicators.
import { el, $, clear, icon, toast, go, trapFocus } from './ui.js?v=20261118d';
import { createPalette } from './palette.js?v=20261118d';
import {
  sb, state, login, lock, loadAll, subscribe, onChange, onRealtime, onConnection,
  refreshSmsStatus, knownPinLength, leadById, leadName,
  who, lastWho, pinLengthFor, resetRequest, resetConfirm, isMine
} from './api.js?v=20261118d';
import { ownerBadge, initialsOf } from './owners.js?v=20261118d';

/* ------------------------------------------------------------ route registry
   The single source of truth for navigation. Top-level entries are either a
   section or a group of sections; `soon: true` marks a planned section (shown
   dimmed, never a link). Making a section real is a one-line change: drop
   `soon` and add `view` (a lazy import whose default export is (ctx) => Node).
   `tab` marks the routes in the phone tab bar (max 4); `foot` puts a section at
   the foot of the collapsed dock; `href` links out (new tab). */
export const NAV = [
  { id: 'home', label: 'Today', icon: 'home', tab: true, view: () => import('./views/home.js?v=20261118d') },
  { group: 'Grow', icon: 'grow', items: [
    { id: 'leads', label: 'Leads', icon: 'leads', tab: true, view: () => import('./views/leads.js?v=20261118d') },
    { id: 'inbox', label: 'Inbox', icon: 'inbox', tab: true, badge: 'unread', view: () => import('./views/inbox.js?v=20261118d') },
    { id: 'campaigns', label: 'Campaigns', icon: 'send', tab: true, view: () => import('./views/campaigns.js?v=20261118d') },
    { id: 'bookings', label: 'Bookings', icon: 'calendar', view: () => import('./views/bookings.js?v=20261118d') }
  ] },
  { group: 'Sell', icon: 'tag', items: [
    { id: 'pipeline', label: 'Pipeline', icon: 'tag', view: () => import('./views/pipeline.js?v=20261118d') },
    { id: 'proposals', label: 'Proposals', icon: 'book', view: () => import('./views/proposals.js?v=20261118d') },
    { id: 'roi-calculator', label: 'ROI calculator', icon: 'dollar', href: '../roi.html' }
  ] },
  { group: 'Deliver', icon: 'deliver', items: [
    { id: 'clients', label: 'Clients', icon: 'leads', view: () => import('./views/clients.js?v=20261118d') },
    { id: 'projects', label: 'Projects', icon: 'deliver', view: () => import('./views/projects.js?v=20261118d') },
    { id: 'roi-reports', label: 'ROI reports', icon: 'spark', view: () => import('./views/roi-reports.js?v=20261118d') }
  ] },
  { group: 'Money', icon: 'money', items: [
    { id: 'income', label: 'Income', icon: 'money', view: () => import('./views/income.js?v=20261118d') },
    { id: 'costs', label: 'Costs', icon: 'money', view: () => import('./views/costs.js?v=20261118d') },
    { id: 'runway', label: 'Runway', icon: 'spark', view: () => import('./views/runway.js?v=20261118d') }
  ] },
  { group: 'Know', icon: 'book', items: [
    { id: 'playbook', label: 'Playbook', icon: 'book', view: () => import('./views/playbook.js?v=20261118d') },
    { id: 'library', label: 'Library', icon: 'book', view: () => import('./views/library.js?v=20261118d') },
    { id: 'files', label: 'Files', icon: 'archive', view: () => import('./views/files.js?v=20261118d') }
  ] },
  { sep: true },
  { id: 'agents', label: 'Agents', icon: 'agents', badge: 'approvals', view: () => import('./views/agents.js?v=20261118d') },
  { id: 'settings', label: 'Settings', icon: 'settings', foot: true, view: () => import('./views/settings.js?v=20261118d') }
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
      meChip(),
      connIndicator(),
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-lock', onClick: () => lock(), title: 'Lock (signs out)' },
        icon('lock', 15), el('span', { class: 'lbl' }, 'Lock'))));

  // The collapsed dock shows one icon per AREA (Today, Grow, Sell, Deliver, Money,
  // Know, Agents), lit when the current route is inside it; hovering or focusing
  // still expands to the full grouped map. Grow carries the unread count, Agents
  // the approvals count.
  const dockItem = (r) => (r.view
    ? el('a', { class: 'dock-item', href: `#${r.id}`, tabindex: '-1', title: r.label, dataset: { route: r.id } }, icon(r.icon, 19), countBadge(r, 'dock-count'))
    : el('span', { class: 'dock-item is-soon' }, icon(r.icon, 19)));
  const areaItem = (g) => {
    const live = g.items.filter((i) => i.view);
    if (!live.length) return el('span', { class: 'dock-item is-soon', title: g.group }, icon(g.icon, 19));
    const badged = live.find((i) => i.badge);
    return el('a', { class: 'dock-item dock-area', href: `#${live[0].id}`, tabindex: '-1', title: g.group, dataset: { area: g.group, routes: live.map((i) => i.id).join(' ') } },
      icon(g.icon, 19), badged ? countBadge(badged, 'dock-count') : null);
  };
  const areas = NAV.filter((n) => !n.sep && !(n.foot)).map((n) => (n.items ? areaItem(n) : dockItem(n)));
  const menuBtn = el('button', { type: 'button', class: 'dock-menu', tabindex: '-1' },
    el('span', { class: 'dock-mark' }, el('img', { src: LOGO, alt: '' })));
  const dock = el('div', { class: 'rail-dock', 'aria-hidden': 'true' },
    menuBtn,
    el('button', { type: 'button', class: 'dock-item dock-search', tabindex: '-1', onClick: (e) => palette?.open(e.currentTarget) }, icon('search', 19)),
    el('div', { class: 'dock-list' }, areas),
    el('div', { class: 'dock-foot' },
      ROUTES.filter((r) => r.foot).map(dockItem),
      connIndicator('conn-dock'),
      meChip('dock'),
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

function onStateChange() {
  updateBadges();
  updateMe();
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
  import('./agent-dock.js?v=20261118d').then((m) => m.mountAgentDock()).catch((e) => setTimeout(() => { throw e; }, 0));
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
