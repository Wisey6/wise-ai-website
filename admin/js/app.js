// Bootstrap: passcode gate, hash router, shell chrome and idle auto-lock.

import { Vault } from './vault.js';
import { Store, emptyData, metrics } from './store.js';
import { el, $, clear, icon, toast } from './ui.js';
import { overviewView } from './views/overview.js';
import { pipelineView, openDeal } from './views/pipeline.js';
import { clientsView, openClient } from './views/clients.js';
import { workView } from './views/work.js';
import { moneyView } from './views/money.js';
import { settingsView } from './views/settings.js';

const IDLE_LOCK_MS = 20 * 60 * 1000;
const MIN_PASSCODE = 10;

const ROUTES = [
  { id: 'overview', label: 'Overview', icon: 'overview', title: 'Overview' },
  { id: 'pipeline', label: 'Pipeline', icon: 'pipeline', title: 'Pipeline' },
  { id: 'clients',  label: 'Clients',  icon: 'clients',  title: 'Clients' },
  { id: 'work',     label: 'Work',     icon: 'work',     title: 'Projects & tasks' },
  { id: 'money',    label: 'Money',    icon: 'money',    title: 'Money' },
  { id: 'settings', label: 'Settings', icon: 'settings', title: 'Settings' }
];

let store = null;
let idleTimer = null;
let workFilter = 'open';

/* -------------------------------------------------------------------- gate */

function gate() {
  const firstRun = !Vault.exists();
  const root = $('#root');

  const passcode = el('input', {
    type: 'password', id: 'passcode', autocomplete: firstRun ? 'new-password' : 'current-password',
    placeholder: firstRun ? 'Choose a passcode' : 'Passcode', 'aria-label': 'Passcode', autofocus: true
  });
  const confirmField = el('input', {
    type: 'password', id: 'confirm', autocomplete: 'new-password',
    placeholder: 'Confirm passcode', 'aria-label': 'Confirm passcode'
  });
  const message = el('div', { class: 'gate-msg', role: 'status', 'aria-live': 'polite' });
  const submit = el('button', { class: 'btn btn-primary btn-block', type: 'submit' },
    firstRun ? 'Create vault' : 'Unlock');

  const form = el('form', { class: 'gate' },
    el('img', { src: '../logo.svg', alt: 'Wise AI', class: 'gate-logo' }),
    el('h1', {}, 'HQ'),
    el('span', { class: 'eyebrow' }, firstRun ? 'Set up · private' : 'Head office · private'),
    passcode,
    firstRun ? confirmField : null,
    submit,
    message,
    el('div', { class: 'gate-foot' },
      firstRun
        ? 'This encrypts everything you enter, on this device only. There is no reset — if you lose the passcode, the data is unrecoverable.'
        : 'Encrypted locally with AES-GCM. Nothing is sent anywhere.')
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    message.className = 'gate-msg';
    message.textContent = '';
    submit.disabled = true;
    submit.textContent = firstRun ? 'Encrypting…' : 'Unlocking…';

    try {
      if (firstRun) {
        if (passcode.value.length < MIN_PASSCODE) {
          throw new Error(`Use at least ${MIN_PASSCODE} characters.`);
        }
        if (passcode.value !== confirmField.value) {
          throw new Error('Those do not match.');
        }
        const session = await Vault.create(passcode.value, emptyData());
        start(session);
      } else {
        const session = await Vault.unlock(passcode.value);
        start(session);
      }
    } catch (err) {
      submit.disabled = false;
      submit.textContent = firstRun ? 'Create vault' : 'Unlock';
      message.className = 'gate-msg error';
      message.textContent = err.message === 'BAD_PASSCODE' ? 'Wrong passcode.' : err.message;
      passcode.select();
    }
  });

  clear(root).append(el('div', { class: 'gate-wrap' }, form));
  setTimeout(() => passcode.focus(), 60);
}

/* ------------------------------------------------------------------- shell */

function lock() {
  clearTimeout(idleTimer);
  store = null;
  location.hash = '';
  gate();
}

function resetIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    lock();
    toast('Locked after 20 minutes idle.');
  }, IDLE_LOCK_MS);
}

function currentRoute() {
  const id = location.hash.replace('#', '') || 'overview';
  return ROUTES.find((r) => r.id === id) || ROUTES[0];
}

function rail() {
  const route = currentRoute();
  return el('nav', { class: 'rail', 'aria-label': 'Sections' },
    el('div', { class: 'rail-logo' }, el('img', { src: '../favicon.png', alt: 'Wise AI' })),
    el('div', { class: 'rail-nav' },
      ROUTES.map((r) => el('a', {
        class: 'rail-btn', href: `#${r.id}`, dataset: { label: r.label },
        'aria-label': r.label, 'aria-current': r.id === route.id ? 'page' : null
      }, icon(r.icon, 19)))
    ),
    el('button', { class: 'rail-btn', 'aria-label': 'Lock', dataset: { label: 'Lock' }, onClick: lock },
      icon('lock', 18))
  );
}

/** The primary action for the current section, if it has one. */
function primaryAction(route) {
  const actions = {
    pipeline: ['New deal', () => openDeal(store, null)],
    clients:  ['New client', () => openClient(store, null)],
    work:     null,
    money:    null
  };
  const action = actions[route.id];
  if (!action) return null;
  return el('button', { class: 'btn btn-primary btn-sm', onClick: action[1] }, icon('plus', 13), action[0]);
}

function render() {
  if (!store) return;
  const route = currentRoute();
  const m = metrics(store.data);

  const body = {
    overview: () => overviewView(store),
    pipeline: () => pipelineView(store),
    clients:  () => clientsView(store),
    work:     () => workView(store, workFilter),
    money:    () => moneyView(store),
    settings: () => settingsView(store, { onLock: lock })
  }[route.id]();

  const shell = el('div', { class: 'shell' },
    rail(),
    el('main', { class: 'main' },
      el('div', { class: 'container' },
        el('header', { class: 'topbar' },
          el('div', {},
            el('span', { class: 'eyebrow' }, 'Wise AI · Head office'),
            el('h1', { style: 'margin-top:4px' }, route.title)
          ),
          el('div', { class: 'topbar-actions' },
            route.id === 'overview'
              ? el('span', { class: 'muted', style: 'font-size:12.5px' },
                  `${m.activeClients} active · ${m.openTasks} open task${m.openTasks === 1 ? '' : 's'}`)
              : null,
            primaryAction(route)
          )
        ),
        body
      )
    )
  );

  clear($('#root')).append(shell);
}

function start(session) {
  store = new Store(session);
  store.subscribe(render);
  store.emitFilter = (filter) => { workFilter = filter; render(); };

  window.addEventListener('hashchange', render);
  for (const evt of ['pointerdown', 'keydown']) {
    document.addEventListener(evt, resetIdle, { passive: true });
  }
  resetIdle();

  if (!location.hash) location.hash = '#overview';
  render();
}

/* -------------------------------------------------------------------- boot */

if (!window.isSecureContext || !window.crypto?.subtle) {
  $('#root').append(el('div', { class: 'gate-wrap' },
    el('div', { class: 'gate' },
      el('h1', {}, 'Not available'),
      el('p', { class: 'muted', style: 'font-size:13px;line-height:1.6;margin-top:12px' },
        'This console needs WebCrypto, which browsers only expose over HTTPS. Open it at https://wise-ai.au/admin/ or over localhost.'))
  ));
} else {
  gate();
}
