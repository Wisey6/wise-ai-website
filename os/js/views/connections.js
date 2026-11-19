// Settings, Connections: one place to see what the assistant is plugged into, what each
// connection lets it do (and not do), and the one action for each: Connect, Reconnect,
// Disconnect, or the setup steps. No secret is ever typed into the hub: setup steps point to
// Supabase and Google. Statuses come from the existing sources only:
//   Google Drive        files-api.js  gdrive {action:'status'} (connect and disconnect: owner only)
//   Email and calendar  mail-api.js   mail_status (each person's own account)
//   Text messages       api.js        state.sms (sms-send status), refreshSmsStatus()
//   Bookings            api.js        state.bookings (a Cal.com booking has arrived)
//   AI model            agents.js     agentsInfo() (state.agents: key present, spend, cap)
import { el, icon, toast, busy, copyText, confirmDialog, fill } from '../ui.js?v=20261119a';
import { state, refreshSmsStatus } from '../api.js?v=20261119a';
import { FUNCTIONS_URL } from '../config.js?v=20261119a';
import { agentsInfo } from './agents.js?v=20261119a';
import { gdriveCall } from '../files-api.js?v=20261119a';
import { mailStatus, refreshMailStatus, connectMail, disconnectMail, takeMailFlag, onMailChange, MAIL_ERRORS } from '../mail-api.js?v=20261119a';

export const MAIL_LINE = 'The assistant can search and read your inbox and write drafts. Nothing is sent until you press Send.';
export const CAL_LINE = 'In your calendar it can look, find free times and add or change your own events; guests are invited only when you press the button.';

const isOwner = () => state.me?.role === 'owner';
const ownerName = () => (state.team || []).find((m) => m.role === 'owner')?.name || 'the owner';
const usd = (n) => `US$${(Number(n) || 0).toFixed(2)}`;
const STATUS_TONE = { connected: 'ok', 'not-connected': 'mute', 'needs-setup': 'warn', 'not-configured': 'warn', reconnect: 'warn', error: 'warn', loading: 'mute', 'not-built': 'mute' };
const openSteps = new Set();

/** The status: a dot and a plain word or two. */
function statusNode(stateKey, word, detail) {
  return el('span', { class: `badge con-badge is-${STATUS_TONE[stateKey] || 'mute'}` },
    el('span', { class: 'badge-dot', 'aria-hidden': 'true' }), word, detail ? el('strong', { class: 'con-who' }, detail) : null);
}

/**
 * One connection row. `paint({state, word, detail, note, actions, steps, urls})` redraws it.
 * The "How to set up" button expands numbered steps in place.
 */
function connRow(key, name, does, attrs = {}) {
  const status = el('div', { class: 'con-status' });
  const note = el('p', { class: 'con-note small muted' });
  const err = el('p', { class: 'set-err con-err', role: 'alert' });
  const acts = el('div', { class: 'con-acts' });
  const steps = el('div', { class: 'con-steps', id: `con-steps-${key}`, hidden: true });
  const node = el('li', { class: 'con-row', dataset: { conn: key, ...attrs } },
    el('div', { class: 'con-main' },
      el('h3', { class: 'con-name' }, name),
      el('p', { class: 'con-does', dataset: attrs.mailRow !== undefined ? { mailNote: '' } : {} }, ...[].concat(does)),
      note, err),
    status, acts, steps);

  function stepsToggle() {
    const open = openSteps.has(key);
    const b = el('button', { type: 'button', class: 'btn btn-ghost btn-sm con-how', 'aria-expanded': String(open), 'aria-controls': steps.id, dataset: { act: 'how' } },
      'How to set up', el('span', { class: 'con-chev' }, icon('chevron-down', 14)));
    b.addEventListener('click', () => {
      const now = !openSteps.has(key);
      if (now) openSteps.add(key); else openSteps.delete(key);
      b.setAttribute('aria-expanded', String(now));
      steps.hidden = !now;
    });
    return b;
  }

  function paint({ state: st, word, detail = null, note: noteText = '', actions = [], steps: list = null, urls = [], lead = '' }) {
    node.dataset.state = st;
    node.classList.toggle('is-muted', st === 'not-built');
    fill(status, statusNode(st, word, detail));
    note.textContent = noteText || '';
    note.hidden = !noteText;
    const hasSteps = Array.isArray(list) && list.length;
    fill(acts, ...actions, hasSteps ? stepsToggle() : null);
    if (hasSteps) {
      fill(steps,
        lead ? el('p', { class: 'small muted' }, lead) : null,
        el('ol', { class: 'set-steps' }, list.map((t) => el('li', {}, t))),
        urls.map(([label, url]) => el('div', { class: 'set-url' },
          el('span', { class: 'field-label' }, label),
          el('div', { class: 'row nowrap' },
            el('code', { class: 'set-code' }, url),
            el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => copyText(url, 'Address copied') }, icon('copy', 14), 'Copy')))));
      steps.hidden = !openSteps.has(key);
    } else {
      fill(steps);
      steps.hidden = true;
    }
  }
  const setErr = (t) => { err.textContent = t || ''; };
  return { node, paint, setErr };
}

const btn = (label, act, cls = 'btn-ghost', ic = null) => el('button', { type: 'button', class: `btn ${cls} btn-sm`, dataset: { act } }, ic ? icon(ic, 14) : null, label);

/* ------------------------------------------------------------ Google Drive */
const DRIVE_SETUP = [
  'In Google Cloud (console.cloud.google.com), signed in as the Workspace admin, create a project for the hub and switch on the Google Drive API.',
  'Set up the Google sign-in app with its audience as Internal, and create a web client with the redirect address below, exactly.',
  'Copy the client ID and secret, and add them in Supabase, Edge Functions, Secrets, as GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. They are never typed into the hub.',
  'Come back here and press Connect. One connection serves the whole team.'
];
function driveRow() {
  const r = connRow('drive', 'Google Drive', 'Business files, for the whole team. The assistant can search the business folder, read Docs, Sheets and text files, and move, rename and file things there, each with an Undo. It never deletes anything.');
  let s = null;
  const load = async () => { s = await gdriveCall('status'); paint(); };
  const connect = (b) => busy(b, async () => {
    r.setErr('');
    const res = await gdriveCall('connect_url');
    if (!res.ok || typeof res.url !== 'string') { r.setErr(res.message || 'Could not start the Google sign-in. Try again in a minute.'); return; }
    location.assign(res.url);
  });
  const disconnect = async (b) => {
    const ok = await confirmDialog('Disconnect Google Drive?', 'Files will stop showing Google Drive and the assistant can no longer reach it, for everyone, until it is connected again. Nothing in Drive changes, and links to clients and projects stay.', { confirmLabel: 'Disconnect' });
    if (!ok) return;
    busy(b, async () => {
      const res = await gdriveCall('disconnect');
      if (res.ok) { toast('Google Drive disconnected'); load(); } else r.setErr(res.message || 'Could not disconnect. Try again in a minute.');
    });
  };
  function paint() {
    const owner = s?.can_connect ?? isOwner();
    const who = s?.owner_name || ownerName();
    const mk = (label, act, cls, fnc) => { const b = btn(label, act, cls); b.addEventListener('click', () => fnc(b)); return b; };
    if (!s) return r.paint({ state: 'loading', word: 'Checking…' });
    if (!s.ok) return r.paint({ state: 'error', word: 'Not reachable', note: s.message || 'The Drive service did not answer. Try again in a minute.' });
    if (!s.configured) {
      return r.paint(owner
        ? { state: 'needs-setup', word: 'Needs setup', steps: DRIVE_SETUP, urls: [['Redirect address for Google', `${FUNCTIONS_URL}gdrive`]], lead: 'About ten minutes, once. The full clicks are in the setup notes (supabase/README.md, Google Drive).' }
        : { state: 'needs-setup', word: 'Needs setup', note: `${who} can finish the Google setup.` });
    }
    if (s.connected && s.needs_reconnect) {
      return r.paint({ state: 'reconnect', word: 'Needs reconnecting', note: owner ? 'Google sign-ins lapse after six months without use, or when access is removed. Sign in again and everything carries on.' : `Ask ${who} to reconnect it.`,
        actions: owner ? [mk('Reconnect', 'drive-connect', 'btn-primary', connect), mk('Disconnect', 'drive-disconnect', 'btn-ghost', disconnect)] : [] });
    }
    if (s.connected) {
      return r.paint({ state: 'connected', word: 'Connected as', detail: s.account?.name || 'the business account',
        actions: owner ? [mk('Disconnect', 'drive-disconnect', 'btn-ghost', disconnect)] : [] });
    }
    return r.paint({ state: 'not-connected', word: 'Not connected', note: owner ? '' : `Only ${who} can connect it.`,
      actions: owner ? [mk('Connect', 'drive-connect', 'btn-primary', connect)] : [] });
  }
  paint();
  load();
  return { node: r.node, update: paint };
}

/* ---------------------------------------------------- Email and calendar
   Each person connects their OWN Google account (Gmail and calendar). Only they can use it:
   the assistant searches, reads and drafts in it when they ask; nothing is sent until they
   press Send on a draft. The one implementation (it used to sit under Your sign-in). */
function mailRow() {
  const r = connRow('mail', 'Email and calendar', ['Your own Google account, just for you. ', MAIL_LINE, ' ', CAL_LINE], { mailRow: '' });
  const connectBtn = (label) => {
    const b = btn(label, 'mail-connect', 'btn-primary', 'mail');
    b.addEventListener('click', () => busy(b, async () => {
      r.setErr('');
      const res = await connectMail();
      if (!res.ok) r.setErr(res.message);
    }));
    return b;
  };
  const disconnectBtn = () => {
    const b = btn('Disconnect', 'mail-disconnect');
    b.addEventListener('click', async () => {
      const ok = await confirmDialog('Disconnect your email?', 'The assistant will no longer be able to search, read or draft in your email. Drafts already in Gmail stay there.', { confirmLabel: 'Disconnect' });
      if (!ok) return;
      busy(b, async () => {
        const res = await disconnectMail();
        if (res.ok) toast('Your email is disconnected.'); else r.setErr(res.message);
      });
    });
    return b;
  };
  function update() {
    const s = mailStatus();
    if (!s) return r.paint({ state: 'loading', word: 'Checking…' });
    if (!s.ok) return r.paint({ state: 'error', word: 'Not reachable', note: s.message || MAIL_ERRORS.network });
    if (!s.configured) {
      return r.paint(isOwner()
        ? { state: 'not-configured', word: 'Needs setup', lead: 'It uses the same Google app as Google Drive, so set that up first.',
          steps: ['In Google Cloud, in the same project as Drive, switch on the Gmail API and the Google Calendar API.', 'Come back here and press Connect, sign in with your own wise-ai.au account and tick every box.', 'Each person on the team connects their own account here.'] }
        : { state: 'not-configured', word: 'Needs setup', note: `Google sign-in is not set up for the hub yet. ${ownerName()} can finish it.` });
    }
    if (s.connected && s.needs_reconnect) return r.paint({ state: 'reconnect', word: 'Needs reconnecting', detail: s.email || null, actions: [connectBtn('Reconnect'), disconnectBtn()] });
    if (s.connected) {
      return r.paint({ state: 'connected', word: 'Connected as', detail: s.email || 'your Google account',
        note: s.can_draft ? '' : 'Reading only: connect again and tick every box to allow drafts.',
        actions: [s.can_draft ? null : connectBtn('Connect again'), disconnectBtn()].filter(Boolean) });
    }
    return r.paint({ state: 'not-connected', word: 'Not connected', actions: [connectBtn('Connect')] });
  }
  let seen = false;
  const off = onMailChange(() => { if (r.node.isConnected) seen = true; else if (seen) { off(); return; } update(); });
  update();
  refreshMailStatus(true);
  // Back from Google's sign-in: say how it went once.
  const flag = takeMailFlag();
  if (flag) { toast(flag.text, flag.tone); if (flag.flag === 'api_off') r.setErr(MAIL_ERRORS.mail_api_off); }
  return { node: r.node, update };
}

/* ------------------------------------------------------- Text messages */
const SMS_STEPS = [
  'Create a Twilio account at twilio.com.',
  'In Twilio, buy an Australian mobile number that can send SMS. Australian numbers need a regulatory bundle approved first.',
  'In Supabase, open Edge Functions, then Secrets, and add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER (the number as +614…). The values come from the Twilio console; they are never typed into the hub.',
  'In Twilio, open Phone Numbers, your number, Messaging. Set “A message comes in” to Webhook, HTTP POST, with the address below.',
  'Text the number from your phone and check the message arrives in the Inbox, then press Recheck here.'
];
function smsRow() {
  const r = connRow('sms', 'Text messages (Twilio)', 'The assistant reads text conversations with leads from the Inbox and can write a reply for you to check. It cannot send a text: sending stays with a person, in the Inbox.');
  const recheck = () => {
    const b = btn('Recheck', 'sms-recheck', 'btn-ghost', 'refresh');
    b.addEventListener('click', () => busy(b, async () => {
      await refreshSmsStatus();
      update();
      toast(state.sms?.configured ? 'Text messages are connected' : state.sms ? 'Text messages are not set up yet' : 'The send service did not answer', state.sms?.configured ? 'ok' : 'warn');
    }));
    return b;
  };
  function update() {
    const sms = state.sms;
    if (!state.smsChecked) return r.paint({ state: 'loading', word: 'Checking…' });
    if (sms === null) return r.paint({ state: 'error', word: 'Not reachable', note: 'The send service did not answer.', actions: [recheck()] });
    if (sms.configured) {
      return r.paint({ state: 'connected', word: 'Connected', note: `Sending is live. ${sms.sent_today ?? 0} of ${sms.daily_cap ?? 0} sent today.`, actions: [recheck()] });
    }
    return r.paint(isOwner()
      ? { state: 'needs-setup', word: 'Needs setup', note: 'Until then, texts go from your phone with “Copy & mark sent”, and everything is still recorded.', actions: [recheck()],
        steps: SMS_STEPS, urls: [['Incoming messages webhook', `${FUNCTIONS_URL}twilio-webhook`]] }
      : { state: 'needs-setup', word: 'Needs setup', note: `${ownerName()} can set this up.`, actions: [recheck()] });
  }
  update();
  return { node: r.node, update };
}

/* ------------------------------------------------------------- Bookings */
function calRow() {
  const r = connRow('cal', 'Bookings (Cal.com)', 'Bookings made on your Cal.com page arrive in the hub, matched to the lead. The assistant can read them; it cannot book, move or cancel a call.');
  function update() {
    const seen = (state.bookings || []).some((b) => b.cal_uid);
    if (seen) return r.paint({ state: 'connected', word: 'Connected', note: 'Bookings are arriving.' });
    const steps = [
      'In Cal.com, open Settings, Developer, Webhooks, and add a new webhook with the address below.',
      'Tick Booking Created, Booking Rescheduled and Booking Cancelled.',
      'Set a secret (a long random string) there, and add the same value in Supabase, Edge Functions, Secrets, as CAL_WEBHOOK_SECRET.',
      'Ask for the phone number on your event type, so bookings match the right lead.'
    ];
    return r.paint(isOwner()
      ? { state: 'needs-setup', word: 'Needs setup', note: 'No booking has come through yet. If it is already set up, this changes with the first booking.', steps, urls: [['Booking webhook', `${FUNCTIONS_URL}cal-webhook`]] }
      : { state: 'needs-setup', word: 'Needs setup', note: `No booking has come through yet. ${ownerName()} can set this up.` });
  }
  update();
  return { node: r.node, update };
}

/* ------------------------------------------------------------- AI model */
function aiRow() {
  const r = connRow('ai', 'AI model (Anthropic)', 'The model behind the assistant, the Researcher and the morning briefing. Every run counts towards the monthly budget, and they all stop once it is spent.');
  const link = () => el('a', { class: 'btn btn-ghost btn-sm', href: '#settings/agents', dataset: { act: 'ai-settings' } }, 'Agents settings');
  function update() {
    const info = agentsInfo();
    if (!info.reachable) return r.paint({ state: 'error', word: 'Status unavailable', note: 'The assistant service did not answer. Try again in a minute.', actions: [link()] });
    const spend = `${usd(info.spent)} of ${usd(info.cap)} spent this month.`;
    if (info.connected) return r.paint({ state: 'connected', word: 'Connected', note: spend, actions: [link()] });
    return r.paint(isOwner()
      ? { state: 'needs-setup', word: 'Needs setup', actions: [link()], steps: ['Get an API key from your Anthropic account (console.anthropic.com).', 'In Supabase, open Edge Functions, then Secrets, and add it as ANTHROPIC_API_KEY. It is never stored in the hub.', 'Come back here: this row shows Connected within a minute or two.'] }
      : { state: 'needs-setup', word: 'Needs setup', note: `${ownerName()} can set this up.`, actions: [link()] });
  }
  update();
  return { node: r.node, update };
}

/* ------------------------------------------------------- not built yet */
function laterRow(key, name, does) {
  const r = connRow(key, name, does);
  r.paint({ state: 'not-built', word: 'Not built yet' });
  return { node: r.node, update() {} };
}

/** The Connections list: one row per connection. */
export function connectionsList() {
  const rows = [
    driveRow(),
    mailRow(),
    smsRow(),
    calRow(),
    aiRow(),
    laterRow('stripe', 'Payments (Stripe)', 'Read-only payouts and invoices.'),
    laterRow('bank', 'Bank feed', 'CommBank CSV import.')
  ];
  const node = el('ul', { class: 'con-list', dataset: { connections: '' } }, rows.map((x) => x.node));
  return { node, update: () => rows.forEach((x) => x.update()) };
}
