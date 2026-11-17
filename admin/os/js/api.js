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
import { SUPABASE_URL, SUPABASE_KEY, FUNCTIONS_URL } from './config.js';

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
export async function login(pin) {
  let res;
  try {
    res = await fetch(`${FUNCTIONS_URL}hq-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ pin: String(pin), device_token: storageGet(DEVICE_KEY) || undefined })
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
  return { ok: true };
}

/** Length of the PIN that last unlocked this device (default 6). Never the PIN itself. */
export function knownPinLength() {
  const n = Number(storageGet(PINLEN_KEY));
  return n >= 6 && n <= 12 ? n : 6;
}

/** → {ok:true} | {ok:false, error:'bad_pin'|'weak_pin'|'locked'|..., remaining?, retry_after_s?} */
export async function changePin(oldPin, newPin) {
  const { status, data } = await fn('hq-login', {
    action: 'change_pin', pin: String(oldPin), new_pin: String(newPin), device_token: storageGet(DEVICE_KEY) || undefined
  });
  if (status === 200 && data && data.ok) {
    storageSet(PINLEN_KEY, String(String(newPin).length));
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
  sms: null,
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
export function notify() {
  if (notifyQueued) return;
  notifyQueued = true;
  const run = () => {
    notifyQueued = false;
    for (const cb of [...changeListeners]) {
      try { cb(state); } catch (e) { reportError(e); }
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
  Object.assign(state, { settings, leads, templates, campaigns, bookings, events, suppressions, messages, loaded: true });
  notify();
  refreshSmsStatus();
  return state;
}

/** sms-send {action:'status'} → state.sms (or null when unavailable). */
export async function refreshSmsStatus() {
  const { status, data } = await fn('sms-send', { action: 'status' });
  state.sms = status === 200 && data && typeof data.configured === 'boolean' ? data : null;
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

const TABLE_KEY = { leads: 'leads', messages: 'messages', bookings: 'bookings', events: 'events' };

function upsertInto(list, row, { prepend = false, key = 'id' } = {}) {
  const i = list.findIndex((r) => r[key] === row[key]);
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
  } else if (table === 'leads') {
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
      notify();
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
  'next_followup_at', 'unread', 'notes', 'tags', 'archived', 'hook', 'pain', 'est_monthly_value'];

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
    const { data, error } = await sb.from('leads').insert(toInsert.slice(i, i + 500)).select();
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
    if (!/stop/i.test(text) && settings?.optout_text) text += ` ${settings.optout_text}`;
  }
  return text;
}

/** GSM-7 aware segment count for an SMS body. */
export function smsSegments(text) {
  const s = String(text || '');
  const gsm = /^[\n\r -~£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¡ÄÖÑÜ§¿äöñüà€^{}\\[\]~|]*$/.test(s);
  const per = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  if (s.length <= per) return { chars: s.length, segments: s.length ? 1 : 0, gsm };
  return { chars: s.length, segments: Math.ceil(s.length / multi), gsm };
}

export const leadById = (id) => state.leads.find((l) => l.id === id) || null;
export const campaignById = (id) => state.campaigns.find((c) => c.id === id) || null;
export const isSuppressed = (phone) => Boolean(phone) && state.suppressions.some((s) => s.phone === phone);
