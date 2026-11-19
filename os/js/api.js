// Wise AI OS data layer: Supabase client, PIN login, shared state, realtime,
// and the mutations every view uses.
//
// Conventions:
//  - Reads populate `state`; listeners registered with onChange() are called
//    (batched to one call per animation frame) whenever state changes.
//  - Mutation helpers (saveLead, addLeads, ...) patch `state` locally, notify,
//    and THROW an Error with a readable message on failure. Wrap them in
//    try/catch and toast the error.
//  - fn() and sendSms() never throw on HTTP errors.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY, FUNCTIONS_URL } from './config.js?v=20261119b';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false }
});

const DEVICE_KEY = 'wiseos.device';
const PINLEN_KEY = 'wiseos.pinlen';

function storageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function storageSet(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } }

/* ------------------------------------------------------------------- auth */

/**
 * Exchange the PIN for a session via the hq-login edge function.
 * → {ok:true} | {ok:false, error:'bad_pin'|'locked'|'network'|..., remaining?, retry_after_s?}
 */
export async function login(pin, memberId) {
  let res;
  try {
    res = await fetch(`${FUNCTIONS_URL}hq-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ pin: String(pin), member_id: memberId || undefined, device_token: storageGet(DEVICE_KEY) || undefined })
    });
  } catch {
    return { ok: false, error: 'network' };
  }
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok || !data.ok) {
    return {
      ok: false,
      error: data.error || (res.status === 404 ? 'not_deployed' : `http_${res.status}`),
      remaining: data.remaining,
      retry_after_s: data.retry_after_s
    };
  }
  if (data.device_token) storageSet(DEVICE_KEY, data.device_token);
  const { error } = await sb.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token });
  if (error) return { ok: false, error: 'session' };
  storageSet(PINLEN_KEY, String(String(pin).length));
  if (data.member) {
    state.me = data.member;
    storageSet(WHO_KEY, data.member.id);
    storageSet(`${PINLEN_KEY}.${data.member.id}`, String(String(pin).length));
  }
  return { ok: true, member: data.member || null };
}

/* -------------------------------------------------------------------- team
   More than one person can sign in. Everyone sees the same hub; `state.me` is who
   is signed in ({id, name, role, email_hint}) and `state.team` is everyone work can
   be given to ([{id, name, initials, role, can_sign_in, active, sort}]).
     await who()                  → [{id, name, initials}] the people on the lock screen (public)
     lastWho()                    → the member id that last signed in on this device, or null
     pinLengthFor(memberId)       → that person's PIN length on this device, or 0 if unknown
     memberById(id), memberName(id, fallback), isMine(row)   helpers for owner_id
     await teamSave({member, pin, sign_in, email})   owner only → {ok, member} | {ok:false, message}
     await setMyEmail(email)      → {ok} | {ok:false, message}
     await resetRequest(memberId) → {ok} | {ok:false, error, message}    (public, from the lock screen)
     await resetConfirm(token, newPin) → {ok} | {ok:false, error, message} */
const WHO_KEY = 'wiseos.who';

async function publicFn(body) {
  try {
    const res = await fetch(`${FUNCTIONS_URL}hq-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify(body)
    });
    let data = {};
    try { data = await res.json(); } catch { data = {}; }
    return { status: res.status, data };
  } catch {
    return { status: 0, data: { error: 'network' } };
  }
}

export async function who() {
  const { status, data } = await publicFn({ action: 'who' });
  return status === 200 && Array.isArray(data.people) ? data.people : [];
}

export const lastWho = () => storageGet(WHO_KEY) || null;
export function pinLengthFor(memberId) {
  const n = Number(storageGet(`${PINLEN_KEY}.${memberId}`));
  return n >= 4 && n <= 12 ? n : 0;
}

export const memberById = (id) => (state.team || []).find((m) => m.id === id) || null;
export const memberName = (id, fallback = 'Nobody yet') => memberById(id)?.name || fallback;
/** True when the record is yours or has no owner (unowned work is everyone's to see). */
export const isMine = (row) => !row?.owner_id || row.owner_id === state.me?.id;

/** Refresh who is signed in (after a reload the session is gone, so this runs after login). */
export async function loadMe() {
  const { status, data } = await fn('hq-login', { action: 'me' });
  if (status === 200 && data?.member) state.me = data.member;
  notify();
  return state.me;
}

const TEAM_ERRORS = {
  owner_only: 'Only the owner can manage the team.',
  weak_pin: 'A PIN is 4 to 12 digits.',
  unauthorized: 'Your session has expired. Lock and unlock, then try again.',
  email_not_configured: 'Email is not set up yet, so a reset link cannot be sent. Ask the owner to reset your PIN in Settings.',
  too_many: 'Too many reset requests. Try again in an hour.',
  bad_token: 'That reset link has expired or was already used. Ask for a new one.',
  network: 'Could not reach the sign-in service. Check your connection.'
};
const teamError = (status, data) => {
  const error = data?.error || (status === 0 ? 'network' : `http_${status}`);
  return { ok: false, error, message: data?.detail || TEAM_ERRORS[error] || 'That did not work. Try again.' };
};

export async function teamSave({ member, pin, sign_in: signIn, email } = {}) {
  const body = { action: 'team_save', member: member || {} };
  if (pin) body.pin = String(pin);
  if (signIn) body.sign_in = true;
  if (typeof email === 'string') body.email = email;
  const { status, data } = await fn('hq-login', body);
  if (status === 200 && data?.ok) {
    upsertInto(state.team, data.member);
    state.team.sort((a, b) => (a.sort - b.sort) || String(a.created_at).localeCompare(String(b.created_at)));
    notify();
    return { ok: true, member: data.member };
  }
  return teamError(status, data);
}

export async function setMyEmail(email) {
  const { status, data } = await fn('hq-login', { action: 'set_email', email: String(email || '') });
  if (status === 200 && data?.ok) { await loadMe(); return { ok: true }; }
  return teamError(status, data);
}

export async function resetRequest(memberId) {
  const { status, data } = await publicFn({ action: 'reset_request', member_id: memberId });
  return status === 200 && data?.ok ? { ok: true } : teamError(status, data);
}

export async function resetConfirm(token, newPin) {
  const { status, data } = await publicFn({ action: 'reset_confirm', token: String(token || ''), new_pin: String(newPin || '') });
  return status === 200 && data?.ok ? { ok: true } : teamError(status, data);
}

/** Length of the PIN that last unlocked this device (default 6). Never the PIN itself. */
export function knownPinLength() {
  const n = Number(storageGet(PINLEN_KEY));
  return n >= 4 && n <= 12 ? n : 6;
}

/** → {ok:true} | {ok:false, error:'bad_pin'|'weak_pin'|'locked'|..., remaining?, retry_after_s?} */
export async function changePin(oldPin, newPin) {
  const { status, data } = await fn('hq-login', {
    action: 'change_pin', pin: String(oldPin), new_pin: String(newPin), device_token: storageGet(DEVICE_KEY) || undefined
  });
  if (status === 200 && data && data.ok) {
    storageSet(PINLEN_KEY, String(String(newPin).length));
    if (state.me?.id) storageSet(`${PINLEN_KEY}.${state.me.id}`, String(String(newPin).length));
    return { ok: true };
  }
  return { ok: false, error: data?.error || `http_${status}`, remaining: data?.remaining, retry_after_s: data?.retry_after_s };
}

/** Sign out and return to the PIN gate. */
export async function lock() {
  try { await sb.removeAllChannels(); } catch { /* ignore */ }
  try { await sb.auth.signOut({ scope: 'local' }); } catch { /* ignore */ }
  location.reload();
}

export async function session() {
  const { data } = await sb.auth.getSession();
  return data.session || null;
}

/* ------------------------------------------------------------ edge functions */

/** POST to an edge function with the session bearer. Never throws: → {status, data}. */
export async function fn(name, body = {}) {
  const s = await session();
  try {
    const res = await fetch(`${FUNCTIONS_URL}${name}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: SUPABASE_KEY,
        authorization: `Bearer ${s?.access_token || SUPABASE_KEY}`
      },
      body: JSON.stringify(body)
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
  } catch {
    return { status: 0, data: { error: 'network' } };
  }
}

/* ------------------------------------------------------------------ state */

/**
 * Shared state. `messages` holds the last 30 days of messages (all channels),
 * oldest first, kept live by realtime; use messagesFor(leadId) for a full thread.
 * `events` holds the latest 200, newest first.
 */
export const state = {
  settings: null,
  leads: [],
  templates: [],
  campaigns: [],
  bookings: [],
  events: [],
  suppressions: [],
  messages: [],
  // stage 2: Sell, Deliver, Money, Know
  clients: [],
  deals: [],
  proposals: [],
  projects: [],
  tasks: [],
  roi_reports: [],
  income: [],
  costs: [],
  library: [],
  me: null,
  team: [],
  ai: null,
  agents: null,
  agent_runs: [],
  agent_actions: [],
  agent_chats: [],
  agent_changes: [],
  agent_memory: [],
  sms: null,
  smsChecked: false,
  loaded: false,
  connection: 'connecting'
};

const changeListeners = new Set();
const messageListeners = new Set();
const realtimeListeners = new Set();
let notifyQueued = false;

/** Register a state listener. Returns an unsubscribe function. */
export function onChange(cb) { changeListeners.add(cb); return () => changeListeners.delete(cb); }
/** Called with each new/updated message row from realtime. Returns unsubscribe. */
export function onMessage(cb) { messageListeners.add(cb); return () => messageListeners.delete(cb); }
/** Called with {table, type:'INSERT'|'UPDATE'|'DELETE', row, old} for every realtime change. */
export function onRealtime(cb) { realtimeListeners.add(cb); return () => realtimeListeners.delete(cb); }

/** Schedule listeners (batched). */
/** What changed since the last flush: table names, or '*' when it could be anything. */
let dirty = new Set();
export function notify(what = '*') {
  dirty.add(what);
  if (notifyQueued) return;
  notifyQueued = true;
  const run = () => {
    notifyQueued = false;
    const changed = dirty;
    dirty = new Set();
    for (const cb of [...changeListeners]) {
      try { cb(state, changed); } catch (e) { reportError(e); }
    }
  };
  if (typeof requestAnimationFrame === 'function' && document.visibilityState === 'visible') requestAnimationFrame(run);
  else setTimeout(run, 0);
}

function reportError(e) {
  // Surface programming errors without spamming the console in normal use.
  setTimeout(() => { throw e; }, 0);
}

function fail(error, fallback) {
  if (!error) return;
  const msg = error.message || fallback || 'Something went wrong';
  throw new Error(msg);
}

async function selectAll(table, build) {
  const page = 1000;
  let from = 0;
  const out = [];
  for (;;) {
    let q = sb.from(table).select('*');
    if (build) q = build(q);
    const { data, error } = await q.range(from, from + page - 1);
    fail(error, `Could not load ${table}`);
    out.push(...data);
    if (data.length < page) break;
    from += page;
  }
  return out;
}

const daysAgoIso = (d) => new Date(Date.now() - d * 86400000).toISOString();

/** Load everything the views need. Resolves to state. */
export async function loadAll() {
  const [settings, leads, templates, campaigns, bookings, events, suppressions, messages] = await Promise.all([
    sb.from('settings').select('*').eq('id', 1).maybeSingle().then(({ data, error }) => { fail(error); return data; }),
    selectAll('leads', (q) => q.order('created_at', { ascending: false })),
    selectAll('templates', (q) => q.order('step', { ascending: true })),
    selectAll('campaigns', (q) => q.order('created_at', { ascending: true })),
    selectAll('bookings', (q) => q.order('starts_at', { ascending: true })),
    sb.from('events').select('*').order('at', { ascending: false }).limit(200).then(({ data, error }) => { fail(error); return data; }),
    selectAll('suppressions', (q) => q.order('created_at', { ascending: false })),
    selectAll('messages', (q) => q.gte('created_at', daysAgoIso(30)).order('created_at', { ascending: true }))
  ]);
  const business = await Promise.all(BUSINESS_TABLES.map((t) => selectAll(t, (q) => q.order('created_at', { ascending: false }))));
  BUSINESS_TABLES.forEach((t, i) => { state[t] = business[i]; });
  Object.assign(state, { settings, leads, templates, campaigns, bookings, events, suppressions, messages, loaded: true });
  notify();
  refreshSmsStatus();
  aiStatus();
  loadAgents();
  loadTeam();
  return state;
}

/** sms-send {action:'status'} → state.sms (or null when unavailable). */
export async function refreshSmsStatus() {
  const { status, data } = await fn('sms-send', { action: 'status' });
  state.sms = status === 200 && data && typeof data.configured === 'boolean' ? data : null;
  state.smsChecked = true;
  notify();
  return state.sms;
}

/* --------------------------------------------------------------- realtime */

let channel = null;
const connectionListeners = new Set();
/** cb('live'|'connecting'|'offline'). Returns unsubscribe. */
export function onConnection(cb) { connectionListeners.add(cb); cb(state.connection); return () => connectionListeners.delete(cb); }
function setConnection(c) {
  if (state.connection === c) return;
  state.connection = c;
  for (const cb of connectionListeners) cb(c);
}

/** Stage 2 tables. Each is loaded whole, kept live, and saved through saveRow / deleteRow. */
export const BUSINESS_TABLES = ['clients', 'deals', 'proposals', 'projects', 'tasks', 'roi_reports', 'income', 'costs', 'library'];
const TABLE_KEY = {
  leads: 'leads', messages: 'messages', bookings: 'bookings', events: 'events',
  agent_runs: 'agent_runs', agent_actions: 'agent_actions', team_members: 'team',
  agent_chats: 'agent_chats', agent_changes: 'agent_changes', agent_memory: 'agent_memory',
  ...Object.fromEntries(BUSINESS_TABLES.map((t) => [t, t]))
};

function upsertInto(list, row, { prepend = false, key = 'id' } = {}) {
  const i = list.findIndex((r) => r[key] === row[key]);
  // A late live-update echo of an older save must not overwrite a newer one.
  if (i >= 0 && row.updated_at && list[i].updated_at && String(row.updated_at) < String(list[i].updated_at)) return;
  if (i >= 0) list[i] = { ...list[i], ...row };
  else if (prepend) list.unshift(row);
  else list.push(row);
}

function applyChange(table, type, row, old) {
  const list = state[TABLE_KEY[table]];
  if (!list) return;
  if (type === 'DELETE') {
    const id = old?.id;
    const i = list.findIndex((r) => r.id === id);
    if (i >= 0) list.splice(i, 1);
    return;
  }
  if (table === 'events') {
    upsertInto(list, row, { prepend: true });
    if (list.length > 200) list.length = 200;
  } else if (table === 'agent_runs' || table === 'agent_actions' || table === 'agent_changes') {
    upsertInto(list, row, { prepend: true });
    if (list.length > 200) list.length = 200;
  } else if (table === 'agent_chats') {
    // Realtime also delivers rows this person may not read back; keep only their own.
    if (state.me && row.member_id !== state.me.id) return;
    upsertInto(list, row, { prepend: true });
    list.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  } else if (table === 'agent_memory') {
    const i = list.findIndex((r) => r.id === row.id);
    if (!row.active) { if (i >= 0) list.splice(i, 1); }
    else upsertInto(list, row, { prepend: true });
  } else if (table === 'leads' || BUSINESS_TABLES.includes(table)) {
    upsertInto(list, row, { prepend: true });
  } else if (table === 'bookings') {
    upsertInto(list, row);
    list.sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
  } else {
    upsertInto(list, row);
  }
}

/** Open the realtime channel (call once after sign-in). */
export function subscribe() {
  if (channel) return channel;
  setConnection('connecting');
  channel = sb.channel('wise-os');
  for (const table of Object.keys(TABLE_KEY)) {
    channel.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
      const type = payload.eventType;
      const row = payload.new;
      applyChange(table, type, row, payload.old);
      for (const cb of realtimeListeners) { try { cb({ table, type, row, old: payload.old }); } catch (e) { reportError(e); } }
      if (table === 'messages' && type !== 'DELETE') {
        for (const cb of messageListeners) { try { cb(row); } catch (e) { reportError(e); } }
      }
      notify(table);
    });
  }
  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') setConnection('live');
    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setConnection('connecting');
    else if (status === 'CLOSED') setConnection('offline');
  });
  window.addEventListener('offline', () => setConnection('offline'));
  window.addEventListener('online', () => setConnection(channel ? 'connecting' : 'offline'));
  return channel;
}

/* -------------------------------------------------------------- mutations */

/** Full thread for a lead, oldest first. */
export async function messagesFor(leadId) {
  const { data, error } = await sb.from('messages').select('*').eq('lead_id', leadId).order('created_at', { ascending: true });
  fail(error, 'Could not load the conversation');
  return data;
}

const LEAD_FIELDS = ['business', 'contact_name', 'phone', 'email', 'website', 'suburb', 'industry', 'source',
  'number_source_url', 'status', 'campaign_id', 'sequence_step', 'last_contacted_at', 'last_reply_at',
  'next_followup_at', 'unread', 'notes', 'tags', 'archived', 'hook', 'pain', 'est_monthly_value', 'owner_id'];

function cleanLead(patch) {
  const out = {};
  for (const k of LEAD_FIELDS) {
    if (!(k in patch)) continue;
    let v = patch[k];
    if (typeof v === 'string') v = v.trim();
    if (v === '' && k !== 'notes') v = null;
    if (k === 'phone' && v) v = normalisePhone(v) || v;
    if (k === 'est_monthly_value' && v !== null) v = Number(v) || null;
    if (k === 'tags') v = Array.isArray(v) ? v : String(v || '').split(',').map((t) => t.trim()).filter(Boolean);
    out[k] = v;
  }
  return out;
}

function friendlyDbError(error) {
  if (!error) return null;
  if (error.code === '23505') return new Error('A lead with that phone number already exists');
  if (error.code === '23514') return new Error('One of the values is not allowed');
  return new Error(error.message || 'Could not save');
}

/** Update a lead (or create one when id is null). Returns the saved row. */
export async function saveLead(id, patch) {
  const row = cleanLead(patch);
  const q = id
    ? sb.from('leads').update(row).eq('id', id).select().single()
    : sb.from('leads').insert(row).select().single();
  const { data, error } = await q;
  if (error) throw friendlyDbError(error);
  upsertInto(state.leads, data, { prepend: true });
  notify();
  return data;
}

/** Apply the same patch to many leads. Returns the updated rows. */
export async function saveLeads(ids, patch) {
  if (!ids.length) return [];
  const row = cleanLead(patch);
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from('leads').update(row).in('id', ids.slice(i, i + 200)).select();
    if (error) throw friendlyDbError(error);
    out.push(...data);
  }
  for (const r of out) upsertInto(state.leads, r, { prepend: true });
  notify();
  return out;
}

/**
 * Bulk insert leads. Phones are normalised; rows whose phone already exists
 * (in the database or earlier in this batch) or is suppressed are skipped.
 * → {inserted, skipped, duplicates, suppressed, rows}
 */
export async function addLeads(rows) {
  const clean = rows.map(cleanLead);
  const phones = [...new Set(clean.map((r) => r.phone).filter(Boolean))];
  const existing = new Set();
  const suppressed = new Set();
  for (let i = 0; i < phones.length; i += 200) {
    const chunk = phones.slice(i, i + 200);
    const [a, b] = await Promise.all([
      sb.from('leads').select('phone').in('phone', chunk),
      sb.from('suppressions').select('phone').in('phone', chunk)
    ]);
    fail(a.error); fail(b.error);
    a.data.forEach((r) => existing.add(r.phone));
    b.data.forEach((r) => suppressed.add(r.phone));
  }
  const seen = new Set();
  const toInsert = [];
  let dup = 0;
  let sup = 0;
  for (const r of clean) {
    if (r.phone) {
      if (suppressed.has(r.phone)) { sup++; continue; }
      if (existing.has(r.phone) || seen.has(r.phone)) { dup++; continue; }
      seen.add(r.phone);
    }
    toInsert.push(r);
  }
  const inserted = [];
  for (let i = 0; i < toInsert.length; i += 500) {
    const { data, error } = await sb.from('leads').insert(toInsert.slice(i, i + 500), { defaultToNull: false }).select();
    if (error) throw friendlyDbError(error);
    inserted.push(...data);
  }
  for (const r of inserted) upsertInto(state.leads, r, { prepend: true });
  notify();
  return { inserted: inserted.length, skipped: dup + sup, duplicates: dup, suppressed: sup, rows: inserted };
}

export async function deleteLead(id) {
  const { error } = await sb.from('leads').delete().eq('id', id);
  fail(error, 'Could not delete the lead');
  const i = state.leads.findIndex((l) => l.id === id);
  if (i >= 0) state.leads.splice(i, 1);
  state.messages = state.messages.filter((m) => m.lead_id !== id);
  state.events = state.events.filter((e) => e.lead_id !== id);
  notify();
}

/** Insert an events row (it arrives in state through realtime too). */
export async function logEvent(kind, leadId, summary) {
  const { data, error } = await sb.from('events').insert({ kind, lead_id: leadId || null, summary }).select().single();
  fail(error, 'Could not log the event');
  upsertInto(state.events, data, { prepend: true });
  notify();
  return data;
}

/** Insert a messages row (e.g. a logged call or note: {lead_id, channel:'call'|'note', direction:'out', status:'manual', body}). */
export async function addMessage(row) {
  const { data, error } = await sb.from('messages').insert({ direction: 'out', status: 'manual', ...row }).select().single();
  fail(error, 'Could not save');
  upsertInto(state.messages, data);
  for (const cb of messageListeners) { try { cb(data); } catch (e) { reportError(e); } }
  notify();
  return data;
}

/** Add a number to the suppression list (idempotent). */
export async function suppress(phone, reason = 'manual') {
  const p = normalisePhone(phone) || phone;
  if (!p) throw new Error('No phone number to suppress');
  const { data, error } = await sb.from('suppressions').upsert({ phone: p, reason }, { onConflict: 'phone', ignoreDuplicates: true }).select();
  fail(error, 'Could not add to the do-not-contact list');
  if (!state.suppressions.some((s) => s.phone === p)) state.suppressions.unshift(data?.[0] || { phone: p, reason, created_at: new Date().toISOString() });
  notify();
}

export async function saveSettings(patch) {
  const { data, error } = await sb.from('settings').update(patch).eq('id', 1).select().single();
  fail(error, 'Could not save settings');
  state.settings = data;
  notify();
  refreshSmsStatus();
  return data;
}

export async function saveTemplate(row) {
  const { id, created_at: _c, ...rest } = row;
  const q = id ? sb.from('templates').update(rest).eq('id', id).select().single() : sb.from('templates').insert(rest).select().single();
  const { data, error } = await q;
  fail(error, 'Could not save the template');
  upsertInto(state.templates, data);
  state.templates.sort((a, b) => a.step - b.step);
  notify();
  return data;
}

export async function deleteTemplate(id) {
  const { error } = await sb.from('templates').delete().eq('id', id);
  fail(error, 'Could not delete the template');
  state.templates = state.templates.filter((t) => t.id !== id);
  notify();
}

/* ------------------------------------------------- stage 2 generic records
   One pair of functions for every business table (see BUSINESS_TABLES):
     saveRow('deals', {title, stage})            → inserts, returns the saved row
     saveRow('deals', {id, stage: 'won'})        → patches that row, returns it
     deleteRow('deals', id)
   state[table] is updated at once (newest first) and views are notified; the
   realtime channel keeps other tabs and devices in step. Both throw an Error
   with a readable message on failure. */
export async function saveRow(table, row) {
  if (!BUSINESS_TABLES.includes(table)) throw new Error(`Unknown table ${table}`);
  const { id, created_at: _c, updated_at: _u, ...rest } = row;
  const q = id
    ? sb.from(table).update(rest).eq('id', id).select().single()
    : sb.from(table).insert(rest).select().single();
  const { data, error } = await q;
  fail(error, 'Could not save');
  upsertInto(state[table], data, { prepend: true });
  notify();
  return data;
}

export async function deleteRow(table, id) {
  if (!BUSINESS_TABLES.includes(table)) throw new Error(`Unknown table ${table}`);
  const { error } = await sb.from(table).delete().eq('id', id);
  fail(error, 'Could not delete');
  const i = state[table].findIndex((r) => r.id === id);
  if (i >= 0) state[table].splice(i, 1);
  // Children removed or unlinked by the database: mirror that locally.
  if (table === 'projects') state.tasks = state.tasks.filter((t) => t.project_id !== id);
  if (table === 'clients') state.roi_reports = state.roi_reports.filter((r) => r.client_id !== id);
  notify();
}

export const rowById = (table, id) => (state[table] || []).find((r) => r.id === id) || null;

/** Turn a lead into a client (or return the client already made from it). Marks the lead won. */
export async function leadToClient(lead) {
  const existing = state.clients.find((c) => c.lead_id === lead.id);
  if (existing) return existing;
  const client = await saveRow('clients', {
    name: lead.business || lead.contact_name || lead.phone || 'New client',
    contact_name: lead.contact_name, email: lead.email, phone: lead.phone, website: lead.website,
    industry: lead.industry, suburb: lead.suburb, lead_id: lead.id,
    started_on: new Date().toISOString().slice(0, 10),
    notes: lead.notes || null
  });
  if (lead.status !== 'won') await saveLead(lead.id, { status: 'won' });
  return client;
}

/** Open a deal in the pipeline for a lead (or return the open one it already has). */
export async function leadToDeal(lead) {
  const open = state.deals.find((d) => d.lead_id === lead.id && !d.archived && !['won', 'lost'].includes(d.stage));
  if (open) return open;
  return saveRow('deals', {
    title: lead.business || lead.contact_name || 'New deal', lead_id: lead.id, stage: 'qualified',
    next_step: 'Intro call', notes: lead.pain || null
  });
}

/* ------------------------------------------------------------ AI assistance
   Button-triggered drafting through the ai-assist function. Nothing is ever sent
   to a client from here: every result is a draft for the operator to read and edit.
     await ai('hook', {lead, notes})                       → res.result {options[], ask}
     await ai('reply', {lead, thread, booking_url})        → res.result {options[]}
     await ai('proposal', {recipient, notes, roi})         → res.result {problem, solution, scope[]}
     await ai('roi_summary', {client, period, numbers, metrics, notes}) → res.result {summary, next_steps}
   Always returns an object and never throws: {ok:true, result, cost_usd} or
   {ok:false, error, message} where `message` is ready to show in a toast.
   state.ai = {configured, enabled, spent_usd, cap_usd} | null (refreshed by aiStatus()). */
const AI_ERRORS = {
  ai_not_configured: 'AI drafting is not connected yet. Add the API key in Supabase to turn it on.',
  disabled: 'AI drafting is switched off in Settings.',
  cap_reached: 'This month\'s AI budget is used up. Raise the cap in Settings to keep drafting.',
  declined: 'The AI declined to write that one. Try rewording your notes.',
  too_long: 'That was too much to draft in one go. Trim the notes and try again.',
  bad_output: 'The draft came back garbled. Try again.',
  ai_error: 'The AI service had a problem. Try again in a minute.',
  unauthorized: 'Your session has expired. Lock and unlock, then try again.',
  bad_request: 'There was nothing to work from. Add some notes first.',
  network: 'Could not reach the AI service. Check your connection.'
};

export async function aiStatus() {
  const { status, data } = await fn('ai-assist', { action: 'status' });
  state.ai = status === 200 && data && typeof data.configured === 'boolean' ? data : null;
  notify();
  return state.ai;
}

export async function ai(task, context) {
  const { status, data } = await fn('ai-assist', { task, context });
  const res = data && typeof data === 'object' ? data : {};
  if (state.ai && typeof res.spent_usd === 'number') state.ai = { ...state.ai, spent_usd: res.spent_usd };
  if (status === 200 && res.ok) return res;
  const error = res.error || (status === 0 ? 'network' : 'ai_error');
  return { ...res, ok: false, error, message: res.detail || AI_ERRORS[error] || AI_ERRORS.ai_error };
}

/* ------------------------------------------------------------------- agents
   Four scoped assistants behind the `agent` function: researcher, briefing, ask, doer.
   They never change a record. A change they suggest is an agent_actions row that the
   operator approves; applyAgentAction() then makes that one change here, in the browser,
   with the operator's own session, through the allowlist below.
     state.agents        {configured, enabled, agents{}, spent_usd, cap_usd, runs_today{}, limits{}} | null
     state.agent_runs    latest 200, newest first, live
     state.agent_actions latest 200, newest first, live
     await agentRun('researcher', {lead_id})         await agentRun('briefing', {refresh})
     await agentRun('ask', {question, history})      await agentRun('doer', {instruction})
   agentRun never throws: {ok:true, ...} or {ok:false, error, message}. */
const AGENT_ERRORS = {
  ...AI_ERRORS,
  disabled: 'That agent is switched off in Settings.',
  cap_reached: 'This month\'s agent budget is used up. Raise it in Settings to keep going.',
  daily_limit: 'That agent has hit its limit for today. It resets at midnight.',
  empty: 'There is nothing in the hub for it to work from yet.',
  bad_request: 'It needs a bit more to go on.'
};

export async function loadTeam() {
  try {
    const { data, error } = await sb.from('team_members').select('*').order('sort').order('created_at');
    if (!error) state.team = data;
  } catch { /* the team list simply stays empty */ }
  notify();
  if (!state.me) await loadMe();
  return state.team;
}

export async function loadAgents() {
  try {
    const [runs, actions] = await Promise.all([
      sb.from('agent_runs').select('*').order('at', { ascending: false }).limit(200),
      sb.from('agent_actions').select('*').order('created_at', { ascending: false }).limit(200)
    ]);
    if (!runs.error) state.agent_runs = runs.data;
    if (!actions.error) state.agent_actions = actions.data;
  } catch { /* the agents area simply stays empty */ }
  loadChats();
  notify();
  return agentStatus();
}

export async function agentStatus() {
  const { status, data } = await fn('agent', { action: 'status' });
  state.agents = status === 200 && data && typeof data.configured === 'boolean' ? data : null;
  notify('agents');
  return state.agents;
}

export async function agentRun(agent, input = {}) {
  const { status, data } = await fn('agent', { agent, ...input });
  const res = data && typeof data === 'object' ? data : {};
  if (state.agents && typeof res.spent_usd === 'number') state.agents = { ...state.agents, spent_usd: res.spent_usd };
  if (status === 200 && res.ok) return res;
  const error = res.error || (status === 0 ? 'network' : 'ai_error');
  return { ...res, ok: false, error, message: res.detail || AGENT_ERRORS[error] || AGENT_ERRORS.ai_error };
}

/* ------------------------------------------------------------ the assistant
   One conversation-based assistant (`agent` function, agent 'chat'). It reads the hub and
   makes the changes it is asked for; every change is an agent_changes row that can be undone.
     state.agent_chats    this person's conversations, most recent first, live
     state.agent_changes  latest 200 changes it made, newest first, live
     state.agent_memory   what it remembers (this person's notes + the business's), live
   Every call below never throws: {ok:true, ...} or {ok:false, error, message}. */
export async function loadChats() {
  try {
    const [chats, changes, memory] = await Promise.all([
      sb.from('agent_chats').select('*').order('updated_at', { ascending: false }).limit(200),
      sb.from('agent_changes').select('*').order('at', { ascending: false }).limit(200),
      sb.from('agent_memory').select('*').eq('active', true).order('created_at', { ascending: false }).limit(200)
    ]);
    if (!chats.error) state.agent_chats = chats.data;
    if (!changes.error) state.agent_changes = changes.data;
    if (!memory.error) state.agent_memory = memory.data;
  } catch { /* the assistant simply starts with no history */ }
  notify('agent_chats');
}

async function agentCall(body) {
  const { status, data } = await fn('agent', body);
  const res = data && typeof data === 'object' ? data : {};
  if (state.agents && typeof res.spent_usd === 'number') state.agents = { ...state.agents, spent_usd: res.spent_usd };
  if (status === 200 && res.ok) return res;
  const error = res.error || (status === 0 ? 'network' : 'ai_error');
  return { ...res, ok: false, error, message: res.detail || AGENT_ERRORS[error] || AGENT_ERRORS.ai_error };
}

/** Send one message. No chat_id starts a new conversation. */
export async function chatSend({ chat_id, message }) {
  const res = await agentCall({ agent: 'chat', ...(chat_id ? { chat_id } : {}), message });
  if (res.ok) {
    upsertInto(state.agent_chats, { id: res.chat_id, title: res.title || 'New conversation', member_id: state.me?.id || null, archived: false, updated_at: new Date().toISOString() }, { prepend: true });
    state.agent_chats.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    for (const c of res.changes || []) if (c && c.id && !state.agent_changes.some((x) => x.id === c.id)) state.agent_changes.unshift(c);
    if (res.draft && res.draft.lead_id && res.draft.body) {
      try { sessionStorage.setItem('wiseos.draft.' + res.draft.lead_id, res.draft.body); } catch { /* private window */ }
    }
    notify('agent_chats');
  }
  return res;
}

/** The messages of one conversation, oldest first. */
export async function chatMessages(chatId) {
  try {
    const { data, error } = await sb.from('agent_chat_messages').select('*').eq('chat_id', chatId).order('id', { ascending: true }).limit(500);
    if (error) return { ok: false, error: 'load', message: 'Could not load that conversation.' };
    return { ok: true, messages: (data || []).filter((m) => m.model !== 'recap') };
  } catch { return { ok: false, error: 'network', message: 'Could not load that conversation.' }; }
}

export async function chatRename(chatId, title) {
  const res = await agentCall({ action: 'chat_rename', chat_id: chatId, title });
  if (res.ok) { upsertInto(state.agent_chats, { id: chatId, title: res.title || title }); notify('agent_chats'); }
  return res;
}

export async function chatArchive(chatId, archived = true) {
  const res = await agentCall({ action: 'chat_archive', chat_id: chatId, archived });
  if (res.ok) { upsertInto(state.agent_chats, { id: chatId, archived }); notify('agent_chats'); }
  return res;
}

export async function chatDelete(chatId) {
  const res = await agentCall({ action: 'chat_delete', chat_id: chatId });
  if (res.ok) { state.agent_chats = state.agent_chats.filter((c) => c.id !== chatId); notify('agent_chats'); }
  return res;
}

/** Put one change the assistant made back the way it was. */
export async function undoChange(changeId) {
  const res = await agentCall({ action: 'undo', change_id: changeId });
  if (res.ok) { upsertInto(state.agent_changes, { id: changeId, undone_at: res.undone_at || new Date().toISOString() }); notify('agent_chats'); }
  return res;
}

export async function memoryDelete(id) {
  const res = await agentCall({ action: 'memory_delete', id });
  if (res.ok) { state.agent_memory = state.agent_memory.filter((m) => m.id !== id); notify('agent_chats'); }
  return res;
}

const LEAD_STATUSES_AGENT = ['new', 'queued', 'contacted', 'replied', 'interested', 'booked', 'won', 'lost'];
const DEAL_STAGES_AGENT = ['qualified', 'proposal', 'negotiation'];
const isoDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const text = (v, max) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);

/** The only changes an approved agent proposal can make. Anything else is refused. */
const AGENT_APPLY = {
  async 'lead.set_status'(p) {
    const lead = leadById(p.lead_id);
    if (!lead || lead.status === 'dnc' || !LEAD_STATUSES_AGENT.includes(p.status)) throw new Error('That lead or status is not allowed');
    await saveLead(lead.id, { status: p.status });
    return { open: `#leads/${lead.id}` };
  },
  async 'lead.set_followup'(p) {
    const lead = leadById(p.lead_id);
    if (!lead || lead.status === 'dnc' || !isoDate(p.date)) throw new Error('That lead or date is not allowed');
    await saveLead(lead.id, { next_followup_at: new Date(`${p.date}T09:00:00`).toISOString() });
    return { open: `#leads/${lead.id}` };
  },
  async 'lead.set_hook'(p) {
    const lead = leadById(p.lead_id);
    const hook = text(p.hook, 160);
    if (!lead || !hook) throw new Error('That lead or line is not allowed');
    await saveLead(lead.id, { hook });
    return { open: `#leads/${lead.id}` };
  },
  async 'note.add'(p) {
    const note = text(p.text, 500);
    if (!note) throw new Error('The note is empty or too long');
    const stamp = new Date().toLocaleDateString('en-AU');
    if (p.lead_id) {
      const lead = leadById(p.lead_id);
      if (!lead) throw new Error('That lead no longer exists');
      await saveLead(lead.id, { notes: `${lead.notes ? `${lead.notes}\n` : ''}[${stamp}] ${note}` });
      return { open: `#leads/${lead.id}` };
    }
    const client = rowById('clients', p.client_id);
    if (!client) throw new Error('That client no longer exists');
    await saveRow('clients', { id: client.id, notes: `${client.notes ? `${client.notes}\n` : ''}[${stamp}] ${note}` });
    return { open: `#clients/${client.id}` };
  },
  async 'task.create'(p) {
    const title = text(p.title, 200);
    if (!title) throw new Error('The task needs a title');
    const row = { title };
    if (p.client_id && rowById('clients', p.client_id)) row.client_id = p.client_id;
    if (p.project_id && rowById('projects', p.project_id)) row.project_id = p.project_id;
    if (isoDate(p.due_on)) row.due_on = p.due_on;
    if (['low', 'medium', 'high'].includes(p.priority)) row.priority = p.priority;
    await saveRow('tasks', row);
    return { open: '#projects/tasks' };
  },
  async 'deal.create'(p) {
    const title = text(p.title, 200);
    if (!title) throw new Error('The deal needs a title');
    const row = { title, stage: 'qualified' };
    if (p.lead_id && leadById(p.lead_id)) row.lead_id = p.lead_id;
    if (p.client_id && rowById('clients', p.client_id)) row.client_id = p.client_id;
    if (Number(p.value) > 0) row.value = Number(p.value);
    if (Number(p.monthly_value) > 0) row.monthly_value = Number(p.monthly_value);
    if (text(p.next_step, 200)) row.next_step = text(p.next_step, 200);
    const deal = await saveRow('deals', row);
    return { open: `#pipeline/${deal.id}` };
  },
  async 'deal.update'(p) {
    const deal = rowById('deals', p.deal_id);
    if (!deal || ['won', 'lost'].includes(deal.stage)) throw new Error('That deal is closed or gone');
    const patch = { id: deal.id };
    if (p.stage !== undefined) {
      if (!DEAL_STAGES_AGENT.includes(p.stage)) throw new Error('Closing a deal is yours to do');
      patch.stage = p.stage;
    }
    if (text(p.next_step, 200)) patch.next_step = text(p.next_step, 200);
    if (isoDate(p.next_step_on)) patch.next_step_on = p.next_step_on;
    if (Number.isFinite(Number(p.probability)) && p.probability !== undefined) patch.probability = Math.min(100, Math.max(0, Math.round(Number(p.probability))));
    await saveRow('deals', patch);
    return { open: `#pipeline/${deal.id}` };
  },
  async 'message.draft'(p) {
    const lead = leadById(p.lead_id);
    const body = text(p.body, 600);
    if (!lead || !body || lead.status === 'dnc' || isSuppressed(lead.phone)) throw new Error('That lead cannot be messaged');
    // A draft only: it is placed in the inbox reply box for the operator to read and send.
    try { sessionStorage.setItem(`wiseos.draft.${lead.id}`, body); } catch { throw new Error('Could not hand the draft to the inbox'); }
    return { open: `#inbox/${lead.id}` };
  },
  async 'invoice.draft'(p) {
    const client = rowById('clients', p.client_id);
    const description = text(p.description, 200);
    const amount = Number(p.amount);
    if (!client || !description || !(amount > 0) || amount > 50000) throw new Error('That invoice is not allowed');
    const row = await saveRow('income', { client_id: client.id, description, amount, kind: p.kind === 'retainer' ? 'retainer' : 'one_off', status: 'draft' });
    return { open: `#income/${row.id}` };
  }
};

async function decideAction(id, patch) {
  const { data, error } = await sb.from('agent_actions').update({ ...patch, decided_at: new Date().toISOString(), decided_by: state.me?.id || null }).eq('id', id).select().single();
  fail(error, 'Could not record the decision');
  upsertInto(state.agent_actions, data, { prepend: true });
  notify();
  return data;
}

/** Apply one proposal the operator approved. → {ok:true, open} or {ok:false, message}. */
export async function applyAgentAction(action) {
  const current = state.agent_actions.find((a) => a.id === action.id) || action;
  if (current.status !== 'proposed') return { ok: false, message: 'That suggestion has already been dealt with.' };
  const apply = AGENT_APPLY[current.kind];
  if (!apply) return { ok: false, message: 'That kind of change is not allowed.' };
  try {
    const out = await apply(current.payload || {});
    await decideAction(current.id, { status: 'applied', result: 'Done' });
    return { ok: true, ...out };
  } catch (e) {
    try { await decideAction(current.id, { status: 'failed', result: String(e.message || e).slice(0, 300) }); } catch { /* keep the original error */ }
    return { ok: false, message: e.message || 'Could not apply that change.' };
  }
}

export async function rejectAgentAction(id) {
  try { await decideAction(id, { status: 'rejected' }); return { ok: true }; }
  catch (e) { return { ok: false, message: e.message }; }
}

export async function saveCampaign(row) {
  const { id, created_at: _c, ...rest } = row;
  const q = id ? sb.from('campaigns').update(rest).eq('id', id).select().single() : sb.from('campaigns').insert(rest).select().single();
  const { data, error } = await q;
  fail(error, 'Could not save the campaign');
  upsertInto(state.campaigns, data);
  notify();
  return data;
}

/**
 * Send (or record as manually sent) SMS through sms-send.
 * → the response data ({results, sent, failed} or {error}) plus `_status` (HTTP status).
 */
export async function sendSms({ lead_ids, template_id, body, mode } = {}) {
  const { status, data } = await fn('sms-send', { lead_ids, template_id, body, mode });
  const out = { ...(data || {}), _status: status };
  if (status === 0) out.error = out.error || 'network';
  refreshSmsStatus();
  return out;
}

/* ---------------------------------------------------------------- helpers */

/**
 * Normalise a phone number to E.164 (identical to the edge functions):
 * strip spaces, dashes, brackets; 04XXXXXXXX → +614XXXXXXXX; 614… → +614…;
 * +6104… → +614…; anything else not matching ^\+\d{8,15}$ → null.
 */
export function normalisePhone(raw) {
  if (raw === null || raw === undefined) return null;
  let p = String(raw).replace(/[\s\-()]/g, '');
  if (/^04\d{8}$/.test(p)) p = `+61${p.slice(1)}`;
  else if (/^614\d{8}$/.test(p)) p = `+${p}`;
  else if (/^\+6104\d{8}$/.test(p)) p = `+61${p.slice(4)}`;
  return /^\+\d{8,15}$/.test(p) ? p : null;
}

export const isAuMobile = (p) => /^\+614\d{8}$/.test(p || '');

export function firstName(lead) {
  const w = String(lead?.contact_name || '').trim().split(/\s+/)[0];
  return w || '';
}

export function leadName(lead) {
  return (lead?.business || '').trim() || (lead?.contact_name || '').trim() || lead?.phone || lead?.email || 'Unnamed lead';
}

/** "$2,400" or '' */
export function formatValue(v) {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return '';
  return `$${Math.round(Number(v)).toLocaleString('en-AU')}`;
}

/** Fill template variables (same set as sms-send). */
export function renderTemplate(body, lead = {}, settings = state.settings || {}) {
  const vars = {
    first_name: firstName(lead) || 'there',
    business: (lead.business || '').trim() || 'your business',
    suburb: (lead.suburb || '').trim(),
    industry: (lead.industry || '').trim(),
    sender: settings?.sender_name || '',
    booking_url: settings?.booking_url || '',
    hook: (lead.hook || '').trim(),
    pain: (lead.pain || '').trim(),
    value: formatValue(lead.est_monthly_value)
  };
  return String(body || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

/**
 * The text that will actually be sent: renderTemplate plus, for a lead who has
 * never replied, the sender name and opt-out (mirrors sms-send).
 */
export function composeSms(body, lead, settings = state.settings || {}, { hasReplied } = {}) {
  let text = renderTemplate(body, lead, settings).trim();
  const replied = hasReplied ?? Boolean(lead?.last_reply_at);
  if (!replied) {
    const sender = settings?.sender_name || '';
    if (sender && !text.toLowerCase().includes(sender.toLowerCase())) text += ` - ${sender}`;
    if (!hasOptOut(text)) text += ` ${(settings?.optout_text || '').trim() || 'Reply STOP to opt out'}`;
  }
  return text;
}

/**
 * True when the text already carries an opt-out instruction. Mirrors hasOptOut in
 * supabase/functions/_shared/template.ts: a bare "stop" (as in "stop losing jobs") does not count.
 */
export function hasOptOut(body) {
  return /\bSTOP\b/.test(body) || /\b(reply|text|txt|send|sms)\s+stop\b/i.test(body);
}

/** GSM-7 aware segment count for an SMS body. */
export function smsSegments(text) {
  const s = String(text || '');
  const BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
  const EXT = '^{}\\[~]|€';   // each costs two septets
  let units = 0;
  let gsm = true;
  for (const ch of s) {
    if (BASIC.includes(ch)) units += 1;
    else if (EXT.includes(ch)) units += 2;
    else { gsm = false; break; }
  }
  if (!gsm) {
    const n = s.length;   // UCS-2: counted in UTF-16 code units
    return { chars: n, segments: n === 0 ? 0 : n <= 70 ? 1 : Math.ceil(n / 67), gsm };
  }
  return { chars: units, segments: units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153), gsm };
}

export const leadById = (id) => state.leads.find((l) => l.id === id) || null;
export const campaignById = (id) => state.campaigns.find((c) => c.id === id) || null;
export const isSuppressed = (phone) => Boolean(phone) && state.suppressions.some((s) => s.phone === phone);
