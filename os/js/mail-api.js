// Email and calendar client helpers: the signed-in person's OWN Google account, through the
// `gdrive` function's mail actions (mail_status, mail_connect_url, mail_disconnect, mail_send,
// mail_discard), and their own email drafts (public.mail_drafts, readable by the owner of each
// row only). Imports api.js with the same ?v= stamp as every other module so there is one `state`.
//
// Sending happens only here, when the person presses Send on a draft card: the assistant has no
// way to send.
import { fn, sb, state } from './api.js?v=20261119a';

const SETTINGS_PATH = 'Settings, under Your sign-in';

/** Plain-English text for each failure code and for the ?mail= sign-in result. */
export const MAIL_ERRORS = {
  not_configured: 'Google sign-in is not set up for the hub yet.',
  not_connected: `Your email is not connected. Connect it in ${SETTINGS_PATH}.`,
  reconnect_needed: `Google needs you to sign in again. Reconnect in ${SETTINGS_PATH}.`,
  mail_api_off: 'Gmail API is not switched on in Google Cloud yet.',
  calendar_api_off: 'Google Calendar API is not switched on in Google Cloud yet.',
  scope_missing: `Google did not give the hub that permission. Reconnect in ${SETTINGS_PATH} and tick every box.`,
  busy: 'Google is busy right now. Try again in a minute.',
  gone: 'That draft is no longer in Gmail. It was sent or deleted there.',
  already_sent: 'That email was already sent.',
  discarded: 'That draft was discarded.',
  sending: 'That email is already being sent.',
  too_many: 'An email from the hub can go to at most 10 people.',
  no_recipients: 'That draft has nobody to send to. Add someone in Gmail first.',
  daily_limit: 'You have sent 30 emails from the hub today, the daily limit. It resets at midnight.',
  not_found: 'That draft is no longer here.',
  network: 'Cannot reach the hub. Check your connection.',
  unauthorized: 'Your session has expired. Lock and unlock, then try again.'
};
export const MAIL_RESULTS = {
  connected: ['Your email and calendar are connected.', 'ok'],
  connected_read_only: ['Your email is connected for reading only. To let the assistant write drafts, connect again and tick every box.', 'warn'],
  denied: ['Not connected: the Google sign-in was cancelled.', 'warn'],
  expired: ['That sign-in link expired. Press Connect again.', 'warn'],
  bad_state: ['That sign-in could not be checked. Press Connect again.', 'bad'],
  not_in_org: ['That Google account is not part of the business Google Workspace.', 'bad'],
  no_refresh: ['Google did not grant lasting access. Press Connect again and allow access.', 'bad'],
  scope_missing: ['Google did not give read access to your email. Press Connect again and tick every box.', 'bad'],
  api_off: ['Gmail API is not switched on in Google Cloud yet. Switch it on, then connect again.', 'bad'],
  in_use: ['That Google account is already connected by another team member.', 'bad'],
  not_configured: ['Google sign-in is not set up for the hub yet.', 'warn'],
  busy: ['Google was busy. Try again in a minute.', 'warn'],
  error: ['The Google sign-in did not finish. Try again.', 'bad']
};

const subs = new Set();
function emit() { for (const f of [...subs]) { try { f(); } catch (e) { setTimeout(() => { throw e; }, 0); } } }
/** Call `cb()` whenever the connection or a draft changes. Returns an unsubscribe. */
export function onMailChange(cb) { subs.add(cb); return () => subs.delete(cb); }

async function call(action, body = {}) {
  const { status, data } = await fn('gdrive', { action, ...body });
  if (data && typeof data === 'object' && 'ok' in data) return data;
  if (status === 0) return { ok: false, error: 'network', message: MAIL_ERRORS.network };
  if (status === 401) return { ok: false, error: 'unauthorized', message: MAIL_ERRORS.unauthorized };
  return { ok: false, error: 'server_error', message: 'Something went wrong. Try again in a minute.' };
}
const messageOf = (r) => r?.message || MAIL_ERRORS[r?.error] || 'Something went wrong. Try again in a minute.';

/* ------------------------------------------------------------ the connection */
let status = null;          // last mail_status answer, or null
let statusAsked = null;     // promise while asking
/** The cached status ({configured, connected, email, can_draft, ...}) or null before the first answer. */
export const mailStatus = () => status;
/** Is the caller's own email connected and readable? */
export const mailConnected = () => Boolean(status?.ok && status.connected && !status.needs_reconnect && status.can_read);

/** Ask the server for the caller's own connection (once; `force` asks again). */
export function refreshMailStatus(force = false) {
  if (statusAsked && !force) return statusAsked;
  statusAsked = call('mail_status').then((r) => { status = r; emit(); return r; });
  return statusAsked;
}

/** Go to Google to connect (or reconnect) the caller's own account. Resolves to an error result when it cannot. */
export async function connectMail() {
  const r = await call('mail_connect_url');
  if (!r.ok || typeof r.url !== 'string' || !/^https:\/\/accounts\.google\.com\//.test(r.url)) return { ok: false, error: r.error || 'server_error', message: messageOf(r) };
  location.assign(r.url);
  return { ok: true };
}
export async function disconnectMail() {
  const r = await call('mail_disconnect');
  if (r.ok) { status = { ...(status || {}), ok: true, connected: false, email: null, can_read: false, can_draft: false, can_calendar: false }; emit(); }
  return r.ok ? r : { ...r, message: messageOf(r) };
}

/** Read and remove the ?mail=<result> flag Google's sign-in returns with. Null when there is none. */
export function takeMailFlag() {
  try {
    const q = new URLSearchParams(location.search);
    if (!q.has('mail')) return null;
    const flag = q.get('mail');
    q.delete('mail');
    history.replaceState(history.state, '', `${location.pathname}${q.toString() ? `?${q}` : ''}${location.hash}`);
    const [text, tone] = MAIL_RESULTS[flag] || MAIL_RESULTS.error;
    return { flag, text, tone };
  } catch { return null; }
}

/* ------------------------------------------------------------ drafts */
const COLS = 'id,chat_id,to_addrs,cc_addrs,subject,is_reply,status,created_at,sent_at,discarded_at,gmail_draft_message_id';
const drafts = new Map();     // draft id → row
const busyIds = new Set();
const errs = new Map();       // draft id → message
let loaded = null;
let channel = null;

/** The person's own drafts (their rows only, by row security). Starts a small live subscription once. */
export function loadMailDrafts(force = false) {
  if (loaded && !force) return loaded;
  loaded = (async () => {
    if (!sb) return;
    const { data, error } = await sb.from('mail_drafts').select(COLS).order('created_at', { ascending: false }).limit(300);
    if (!error && Array.isArray(data)) { for (const r of data) if (r?.id) drafts.set(r.id, r); emit(); }
    if (!channel && sb.channel) {
      channel = sb.channel('wiseos-mail-drafts').on('postgres_changes', { event: '*', schema: 'public', table: 'mail_drafts' }, (p) => {
        const row = p.new && p.new.id ? p.new : null;
        if (row && (!state.me || !row.member_id || row.member_id === state.me.id)) { drafts.set(row.id, { ...(drafts.get(row.id) || {}), ...row }); emit(); }
      }).subscribe();
    }
  })().catch(() => {});
  return loaded;
}

/** Live state of one draft: {status, sent_at, ...} from mail_drafts (null when unknown), busy, error. */
export function draftState(id) {
  return { row: drafts.get(id) || null, busy: busyIds.has(id), error: errs.get(id) || null };
}
/** A short stamp of every draft's state (for redraw checks). */
export const mailStamp = () => [...drafts.values(), ...proposals.values()].map((r) => `${r.id}:${r.status}`).join(',') + `|${[...busyIds].join(',')}|${[...errs.values()].join(',')}|${status?.connected ? 1 : 0}`;

/** The Gmail link that opens the draft (community-documented compose= form; falls back to Drafts). */
export function gmailDraftLink(row, fallback) {
  const email = status?.email;
  const id = row?.gmail_draft_message_id;
  const who = email && /^[^\s@]+@[^\s@]+$/.test(email) ? `?authuser=${encodeURIComponent(email)}` : '';
  if (id && /^[A-Za-z0-9]{6,64}$/.test(id)) return `https://mail.google.com/mail/u/${who}#drafts?compose=${id}`;
  return typeof fallback === 'string' && /^https:\/\/mail\.google\.com\//.test(fallback) ? fallback : `https://mail.google.com/mail/u/${who}#drafts`;
}

async function act(action, id) {
  if (!id || busyIds.has(id)) return null;
  busyIds.add(id); errs.delete(id); emit();
  const r = await call(action, { draft_id: id });
  busyIds.delete(id);
  const d = r.draft;
  if (d && d.id) {
    drafts.set(d.id, { ...(drafts.get(d.id) || {}), id: d.id, status: d.status, sent_at: d.sent_at, discarded_at: d.discarded_at, to_addrs: d.to, cc_addrs: d.cc, subject: d.subject });
  }
  if (!r.ok) errs.set(id, messageOf(r));
  emit();
  return r.ok ? r : { ...r, message: messageOf(r) };
}
/* ------------------------------------------------------------ calendar proposals (guests) */
const PCOLS = 'id,chat_id,action,title,when_text,guests,location,status,created_at,expires_at,done_at';
const proposals = new Map();   // proposal id → row
let pLoaded = null;
let pChannel = null;
/** The person's own calendar proposals (their rows only). Starts a small live subscription once. */
export function loadProposals(force = false) {
  if (pLoaded && !force) return pLoaded;
  pLoaded = (async () => {
    if (!sb) return;
    const { data, error } = await sb.from('calendar_proposals').select(PCOLS).order('created_at', { ascending: false }).limit(200);
    if (!error && Array.isArray(data)) { for (const r of data) if (r?.id) proposals.set(r.id, r); emit(); }
    if (!pChannel && sb.channel) {
      pChannel = sb.channel('wiseos-cal-proposals').on('postgres_changes', { event: '*', schema: 'public', table: 'calendar_proposals' }, (p) => {
        const row = p.new && p.new.id ? p.new : null;
        if (row) { proposals.set(row.id, { ...(proposals.get(row.id) || {}), ...row }); emit(); }
      }).subscribe();
    }
  })().catch(() => {});
  return pLoaded;
}
export function proposalState(id) { return { row: proposals.get(id) || null, busy: busyIds.has(id), error: errs.get(id) || null }; }
const CAL_ERRORS = { expired: 'That waited more than a day, so it was dropped. Ask the assistant again.', done: 'That was already done.', cancelled: 'That was cancelled.', event_gone: 'That event is no longer in your calendar.' };
async function calAct(action, id) {
  if (!id || busyIds.has(id)) return null;
  busyIds.add(id); errs.delete(id); emit();
  const r = await call(action, { proposal_id: id });
  busyIds.delete(id);
  const p = r.proposal;
  if (p && p.proposal_id) proposals.set(p.proposal_id, { ...(proposals.get(p.proposal_id) || {}), id: p.proposal_id, status: p.status, done_at: p.done_at });
  if (!r.ok) errs.set(id, r.message || CAL_ERRORS[r.error] || MAIL_ERRORS[r.error] || 'That did not go through. Try again in a minute.');
  emit();
  return r;
}
/** The person pressed Add and invite / Send update / Cancel and notify: Google emails the guests. */
export const confirmProposal = (id) => calAct('cal_confirm', id);
/** The person dismissed it: nothing happens in the calendar. */
export const cancelProposal = (id) => calAct('cal_cancel', id);

/** The person pressed Send. */
export const sendDraft = (id) => act('mail_send', id);
/** The person pressed Discard (deletes the unsent Gmail draft). */
export const discardDraft = (id) => act('mail_discard', id);
