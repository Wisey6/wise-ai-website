// The Wise AI assistant: one conversation, used by the owl dropdown and the Agents page.
// It reads the hub and makes the changes it is asked for; every change comes back as a
// "what I did" line with a link to the record and an Undo. It never sends anything.
//
// One store for both surfaces, so a conversation, its typed draft and a reply that is
// still on its way are the same wherever you look at them. Everything the assistant
// returns reaches the page as text nodes through el(); links are hub hashes only.
import {
  el, icon, fill, clear, toast, busy, confirmDialog, modal, field, input, timeAgo, timeOnly, dayKey, dayLabel, plural
} from './ui.js?v=20261118d';
import {
  state, chatSend, chatMessages, chatRename, chatArchive, chatDelete, undoChange, memoryDelete,
  agentStatus, saveSettings, rowById, sb
} from './api.js?v=20261118d';
import { safeHash, ASK_PREFILL_KEY } from './ask.js?v=20261118d';
import { agentsInfo, usd } from './views/agents.js?v=20261118d';

export const MAX_MESSAGE = 4000;

/** Example asks for an empty conversation. They fill the composer; they never send. */
export const CHAT_EXAMPLES = [
  'Add a lead: a dental clinic in Manly that found us through the website',
  'What is unpaid, and what is overdue?',
  'Create a task for the newest project: send the first draft by Friday',
  'What are my running costs next month?',
  'Which deals have gone quiet in the last fortnight?'
];

export const CHAT_MODELS = [
  { id: 'claude-haiku-5-5', label: 'Fast and cheap', line: 'Quick answers and simple changes. It can miss detail in longer, many-part requests.' },
  { id: 'claude-sonnet-5-5', label: 'Smart (recommended)', line: 'Handles most questions and multi-step changes well, at a sensible cost per message.' },
  { id: 'claude-opus-5-5', label: 'Smartest, costs about twice as much', line: 'Best on tricky requests that touch many records. Uses the budget about twice as fast.' }
];
const MODEL_NAME = { 'claude-haiku-5-5': 'Haiku', 'claude-sonnet-5-5': 'Sonnet', 'claude-opus-5-5': 'Opus' };

const ERRORS = {
  cap_reached: ['This month’s agent budget is used up.', '#settings', 'Raise it in Settings'],
  disabled: ['The assistant is switched off.', '#settings', 'Turn it on in Settings'],
  daily_limit: ['It has reached today’s limit of 300 messages. It resets at midnight.'],
  ai_not_configured: ['The assistant is not connected yet. It needs the Anthropic API key in Supabase.', '#settings', 'Open Settings'],
  declined: ['It would not help with that one. Try putting it another way.'],
  too_long: ['That message is too long for one go. Trim it or split it in two.'],
  network: ['Could not reach the assistant. Check your connection and try again.'],
  unauthorized: ['Your session has expired. Lock and unlock, then try again.'],
  not_found: ['That conversation is no longer there. Start a new one.'],
  ai_error: ['The assistant had a problem on its end. Try again in a minute.']
};

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => typeof v === 'string' && v.trim() !== '';
const firstLine = (t) => { const s = String(t || '').trim().split('\n')[0].trim(); return s.length > 120 ? `${s.slice(0, 119)}…` : s; };

/* ================================================================== the store */

const S = {
  current: undefined,     // chat id, or null for a new conversation, or undefined (not chosen yet)
  chosen: false,          // did the person pick it (otherwise the newest is shown)
  drafts: new Map(),      // 'new' | chatId → composer text
  msgs: new Map(),        // chatId → {status:'loading'|'ok'|'error', list, fetchedFor, message}
  pending: new Map(),     // 'new' | chatId → {text, at}
  errors: new Map(),      // 'new' | chatId → {error, message, href, link, text}
  extra: new Map(),       // message id → {changes, draft}: what only the live response carries
  previews: new Map(),    // chatId → first line of the first message
  undoing: new Set(),
  undoErr: new Map(),
  undoneLocal: new Map(), // change id → undone_at, from undo results (file changes are not in agent_changes)
  seq: 0
};
const keyOf = (id = S.current) => id || 'new';
const subs = new Set();
function emit() {
  for (const f of [...subs]) {
    try { if (f() === false) subs.delete(f); } catch (e) { setTimeout(() => { throw e; }, 0); }
  }
}

/** Follow the assistant's own changes (a send starting or finishing, an undo). */
export function onChatChange(fn) { subs.add(() => { fn(); return true; }); }

/** Is a reply on its way in any conversation? (The launcher speeds up.) */
export const chatBusy = () => S.pending.size > 0;

const liveChats = () => state.agent_chats.filter((c) => !c.archived);
const chatById = (id) => state.agent_chats.find((c) => c.id === id) || null;

function ensureCurrent() {
  const newest = liveChats()[0]?.id ?? null;
  if (S.current === undefined) { S.current = newest; return; }
  // Nothing picked yet and the history has just arrived: show the newest.
  if (S.current === null && !S.chosen && newest && !(S.drafts.get('new') || '').trim() && !S.pending.has('new') && !S.errors.has('new')) { S.current = newest; return; }
  if (S.current && state.agent_chats.length && !chatById(S.current) && !S.pending.has(S.current) && !S.msgs.has(S.current)) { S.current = newest; }
}

function norm(m) {
  const x = S.extra.get(String(m.id)) || {};
  return {
    id: m.id, at: m.at, role: m.role === 'user' ? 'user' : 'assistant', text: String(m.text ?? ''),
    steps: arr(m.steps), links: arr(m.links), model: m.model || null, cost_usd: m.cost_usd,
    changes: arr(m.changes ?? x.changes), draft: m.draft ?? x.draft ?? null
  };
}

async function loadMsgs(id) {
  const prev = S.msgs.get(id);
  const stamp = chatById(id)?.updated_at || '';
  S.msgs.set(id, { list: [], ...prev, status: 'loading' });
  const r = await chatMessages(id);
  if (S.pending.has(id)) return;   // a send finished in the meantime and owns the list
  if (r.ok) S.msgs.set(id, { status: 'ok', list: arr(r.messages).map(norm), fetchedFor: stamp });
  else S.msgs.set(id, { status: 'error', list: prev?.list || [], fetchedFor: stamp, message: r.message || 'Could not load that conversation.' });
  emit();
}
function ensureMsgs(id) {
  if (!id || S.pending.has(id)) return;
  const e = S.msgs.get(id);
  if (e?.status === 'loading' || e?.status === 'error') return;
  const stamp = chatById(id)?.updated_at || '';
  if (e && String(stamp) <= String(e.fetchedFor || '')) return;
  loadMsgs(id);
}

let previewAsked = new Set();
function ensurePreviews() {
  const ids = state.agent_chats.map((c) => c.id).filter((id) => !previewAsked.has(id) && !S.previews.has(id)).slice(0, 40);
  if (!ids.length || !sb) return;
  ids.forEach((id) => previewAsked.add(id));
  Promise.resolve(sb.from('agent_chat_messages').select('chat_id,text').eq('role', 'user').in('chat_id', ids).order('id', { ascending: true }).limit(400))
    .then(({ data, error }) => {
      if (error || !Array.isArray(data)) return;
      let n = 0;
      for (const r of data) if (r && r.chat_id && !S.previews.has(r.chat_id)) { S.previews.set(r.chat_id, firstLine(r.text)); n++; }
      if (n) emit();
    }, () => {});
}

function errorFor(res) {
  const code = res?.error || 'ai_error';
  const [message, href, link] = ERRORS[code] || [res?.message || ERRORS.ai_error[0]];
  return { error: code, message, href, link };
}

/** Send what is in the composer for the current conversation. */
async function send(text) {
  const chatId = S.current || null;
  const key = keyOf(chatId);
  const t = String(text || '').trim();
  if (!t || S.pending.has(key)) return false;
  if (t.length > MAX_MESSAGE) { S.errors.set(key, { ...errorFor({ error: 'too_long' }), text: t }); emit(); return false; }
  S.chosen = true;
  S.errors.delete(key);
  S.drafts.set(key, '');
  const at = new Date().toISOString();
  S.pending.set(key, { text: t, at });
  emit();
  const res = await chatSend({ chat_id: chatId || undefined, message: t });
  S.pending.delete(key);
  if (!res.ok) {
    S.errors.set(key, { ...errorFor(res), text: t });
    if (!(S.drafts.get(key) || '').trim()) S.drafts.set(key, t);   // the text is never lost
    if (['cap_reached', 'disabled', 'daily_limit'].includes(res.error)) agentStatus();
    emit();
    return false;
  }
  const id = res.chat_id || chatId;
  const m = res.message && typeof res.message === 'object' ? res.message : {};
  const n = ++S.seq;
  const mid = m.id ?? `local-a-${n}`;
  S.extra.set(String(mid), { changes: arr(res.changes), draft: res.draft && safeHash(`#inbox/${res.draft.lead_id}`) ? res.draft : null });
  const you = { id: `local-u-${n}`, role: 'user', text: t, at, steps: [], links: [], changes: [] };
  const reply = norm({ ...m, id: mid, role: 'assistant', at: m.at || new Date().toISOString(), model: m.model || res.model, cost_usd: m.cost_usd ?? res.cost_usd });
  const before = chatId ? (S.msgs.get(id)?.list || []) : [];
  S.msgs.set(id, { status: 'ok', list: [...before, you, reply], fetchedFor: chatById(id)?.updated_at || new Date().toISOString() });
  if (!S.previews.has(id)) S.previews.set(id, firstLine(t));
  if (S.current === chatId) S.current = id;
  if (!chatId) S.drafts.set(id, S.drafts.get('new') || '');
  if (!chatId) S.drafts.set('new', '');
  emit();
  return true;
}

async function doUndo(changeId) {
  if (!changeId || S.undoing.has(changeId)) return;
  S.undoing.add(changeId);
  S.undoErr.delete(changeId);
  emit();
  const r = await undoChange(changeId);
  S.undoing.delete(changeId);
  if (r.ok) { S.undoneLocal.set(changeId, r.undone_at || new Date().toISOString()); toast(r.kind === 'file' ? 'Undone. The file is back the way it was.' : r.kind === 'file_link' ? 'Undone. The file is no longer linked.' : 'Undone. The record is back the way it was.'); }
  else if (r.error === 'already_undone') { S.undoneLocal.set(changeId, r.undone_at || new Date().toISOString()); toast('That change was already undone.'); }
  else { S.undoErr.set(changeId, r.detail || r.message || 'Could not undo that.'); toast(r.detail || r.message || 'Could not undo that.', 'bad'); }
  emit();
}

function openChat(id) {
  S.current = id;
  S.chosen = true;
  if (id) ensureMsgs(id);
  emit();
}
function newChat() {
  S.current = null;
  S.chosen = true;
  emit();
}

async function renameChat(c) {
  const box = input('title', { value: c.title || '', maxlength: 80, required: true, autocomplete: 'off' });
  const v = await modal({ title: 'Rename conversation', body: field('Name', box), confirmLabel: 'Rename' });
  const title = String(v?.title || '').trim();
  if (!title || title === c.title) return;
  const r = await chatRename(c.id, title.slice(0, 80));
  if (r.ok) toast('Renamed'); else toast(r.message, 'bad');
}
function afterGone(id) {
  if (S.current !== id) return;
  const next = liveChats().find((c) => c.id !== id);
  S.current = next ? next.id : null;
}
async function archiveChat(c, archived = true) {
  const r = await chatArchive(c.id, archived);
  if (!r.ok) { toast(r.message, 'bad'); return; }
  if (archived) afterGone(c.id);
  toast(archived ? 'Conversation archived' : 'Conversation restored');
  emit();
}
async function deleteChat(c) {
  const ok = await confirmDialog('Delete this conversation?', `“${c.title || 'New conversation'}” and its messages will be deleted. Anything it changed stays as it is, and can still be undone from the Agents page.`, { confirmLabel: 'Delete' });
  if (!ok) return;
  const r = await chatDelete(c.id);
  if (!r.ok) { toast(r.message, 'bad'); return; }
  afterGone(c.id);
  S.msgs.delete(c.id);
  toast('Conversation deleted');
  emit();
}

/** A question handed over by the palette ("Ask the hub: …?") starts a new conversation. */
export function takeChatPrefill() {
  try {
    const q = sessionStorage.getItem(ASK_PREFILL_KEY);
    if (q === null) return false;
    sessionStorage.removeItem(ASK_PREFILL_KEY);
    S.current = null; S.chosen = true;
    S.drafts.set('new', q.slice(0, MAX_MESSAGE));
    return true;
  } catch { return false; }
}
/** Open a given conversation (deep link). */
export function selectChat(id) { if (id && /^[0-9a-f-]{36}$/i.test(id)) { S.current = id; S.chosen = true; } }

/* ============================================================ rendering bits */

const LIST_RE = /^\s*(?:[-•*]|\d{1,2}[.)])\s+/;
function inline(text) {
  const out = [];
  const re = /\*\*([^*\n]+)\*\*/g;
  let i = 0; let m;
  while ((m = re.exec(text))) {
    if (m.index > i) out.push(text.slice(i, m.index));
    out.push(el('strong', {}, m[1]));
    i = re.lastIndex;
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
}
/** Plain text with paragraphs, simple lists and **bold**, as DOM. Never HTML. */
export function richText(text) {
  const out = [];
  for (const block of String(text || '').replace(/\r/g, '').trim().split(/\n{2,}/)) {
    let para = []; let list = null; let ordered = false;
    const flushP = () => { if (para.length) { out.push(el('p', {}, para.map((l, i) => (i ? [el('br'), inline(l)] : inline(l))))); para = []; } };
    const flushL = () => { if (list) { out.push(el(ordered ? 'ol' : 'ul', {}, list.map((l) => el('li', {}, inline(l))))); list = null; } };
    for (const raw of block.split('\n')) {
      const line = raw.replace(/^\s*#{1,4}\s+/, '');
      if (LIST_RE.test(line)) {
        flushP();
        const o = /^\s*\d/.test(line);
        if (list && o !== ordered) flushL();
        if (!list) { list = []; ordered = o; }
        list.push(line.replace(LIST_RE, ''));
      } else if (line.trim()) { flushL(); para.push(line.trim()); }
    }
    flushP(); flushL();
  }
  return out;
}

const ROUTE_OF = { leads: 'leads', clients: 'clients', deals: 'pipeline', projects: 'projects', income: 'income', costs: 'costs', library: 'library', proposals: 'proposals', roi_reports: 'roi-reports' };
const FILE_TABLES = new Set(['file_changes', 'file_links']);
/** The hub page for a changed record (a file opens on the Files page). */
export function hashFor(table, id) {
  if (!table || !id) return null;
  if (table === 'tasks') { const t = rowById('tasks', id); return t?.project_id ? safeHash(`#projects/${t.project_id}`) : '#projects/tasks'; }
  if (FILE_TABLES.has(table) || table === 'files') return safeHash(`#files/${encodeURIComponent(String(id))}`);
  return ROUTE_OF[table] ? safeHash(`#${ROUTE_OF[table]}/${id}`) : null;
}

const stepText = (s) => (str(s?.text) ? s.text.trim() : str(s?.summary) ? s.summary.trim() : '');
const changeKind = (c) => (['record', 'file', 'file_link'].includes(c.kind) ? c.kind : c.table_name === 'file_changes' ? 'file' : c.table_name === 'file_links' ? 'file_link' : 'record');
/**
 * Changes in one reply: its steps that carry a change_id, plus the response's changes
 * (`id` or `change_id`), merged by id, with live undo state from state.agent_changes and
 * from undo results this session (file changes are not in agent_changes).
 */
function changesOf(m) {
  const by = new Map();
  for (const s of arr(m.steps)) {
    if (!s || !s.change_id || s.ok === false) continue;
    const { kind: _k, text: _t, ...rest } = s;
    by.set(String(s.change_id), { ...rest, id: String(s.change_id), summary: stepText(s), link: s.link });
  }
  for (const c of arr(m.changes)) {
    const id = c && (c.change_id || c.id);
    if (!id) continue;
    const prev = by.get(String(id)) || {};
    by.set(String(id), { ...prev, ...c, id: String(id), summary: str(c.summary) ? c.summary : prev.summary });
  }
  return [...by.values()].map((c) => {
    const live = state.agent_changes.find((x) => x.id === c.id);
    const mine = S.undoneLocal.get(c.id) || null;
    const out = live ? { ...live, ...c, summary: c.summary || live.summary, undone_at: live.undone_at || c.undone_at || mine } : { ...c, undone_at: c.undone_at || mine };
    out.kind = changeKind(out);
    return out;
  });
}
const isDraftStep = (s) => s && !s.change_id && (s.kind === 'draft' || /draft/i.test(String(s.tool || '')));
const isFailedStep = (s) => s && s.ok === false && s.kind !== 'read';
const isPlainWrite = (s) => s && !s.change_id && s.ok !== false && s.kind === 'write';
const readsOf = (m) => arr(m.steps).filter((s) => s && !s.change_id && !isDraftStep(s) && !isFailedStep(s) && !isPlainWrite(s) && (stepText(s) || str(s.tool)));
const linkOf = (c) => safeHash(c.open) || safeHash(c.link) || hashFor(c.table_name, c.row_id);
const OP = { insert: 'New', update: 'Edit', archive: 'Archive', memory: 'Note', move: 'Move', rename: 'Rename', create_folder: 'Folder', link: 'Link' };
const opWord = (c) => OP[c.op] || (/remember|memory/.test(String(c.tool || '')) ? 'Note' : /archive/.test(String(c.tool || '')) ? 'Archive'
  : /folder/.test(String(c.tool || '')) ? 'Folder' : /move/.test(String(c.tool || '')) ? 'Move' : /rename/.test(String(c.tool || '')) ? 'Rename' : /link/.test(String(c.tool || '')) ? 'Link' : 'Done');
const humanTool = (t) => String(t || 'step').replace(/_/g, ' ').replace(/^\w/, (x) => x.toUpperCase());
/** A new folder cannot be undone from the chat (the backend says so); everything else can. */
const canUndo = (c) => Boolean(c.id) && c.undoable !== false && c.op !== 'create_folder' && !/new_folder|create_folder/.test(String(c.tool || ''));

/** One "what I did" line: what changed, a link to it, and Undo (struck through once undone). */
export function changeLine(c, { when = false } = {}) {
  const undone = Boolean(c.undone_at);
  const h = linkOf(c);
  const busyU = S.undoing.has(c.id);
  const err = S.undoErr.get(c.id);
  const sum = str(c.summary) ? c.summary.trim() : `${humanTool(c.tool)}${c.table_name ? ` (${c.table_name})` : ''}`;
  const kind = c.kind || changeKind(c);
  return el('li', { class: `cx-change${undone ? ' is-undone' : ''}${kind !== 'record' ? ' is-file' : ''}`, dataset: { change: c.id || '', op: c.op || '', kind } },
    el('span', { class: 'cx-op' }, opWord(c)),
    el('span', { class: 'cx-change-main' },
      el('span', { class: 'cx-change-sum' }, sum),
      when && c.at ? el('span', { class: 'cx-change-when' }, timeAgo(c.at)) : null,
      err ? el('span', { class: 'cx-change-err', role: 'alert' }, err) : null),
    el('span', { class: 'cx-change-acts' },
      h && !undone ? el('a', { class: 'cx-open', href: h, dataset: { act: 'open-change' } }, 'Open', icon('arrow', 12)) : null,
      !c.id ? null : undone
        ? el('span', { class: 'cx-undone', dataset: { undone: '' } }, 'Undone')
        : canUndo(c)
          ? el('button', { type: 'button', class: 'cx-undo', dataset: { act: 'undo' }, disabled: busyU || null, 'aria-label': `Undo: ${sum}`, onClick: () => doUndo(c.id) }, busyU ? 'Undoing…' : 'Undo')
          : el('span', { class: 'cx-keep', title: 'This one cannot be undone from here.' }, 'Kept')));
}

/** A write that did not happen, or happened without an undo record: said plainly, no Undo. */
function noteLine(s, failed) {
  const h = safeHash(s.link) || hashFor(s.table_name, s.row_id);
  return el('li', { class: `cx-change${failed ? ' is-failed' : ''}`, dataset: { step: failed ? 'failed' : 'write' } },
    el('span', { class: 'cx-op' }, failed ? 'Not done' : opWord(s)),
    el('span', { class: 'cx-change-main' }, el('span', { class: 'cx-change-sum' }, stepText(s) || humanTool(s.tool))),
    el('span', { class: 'cx-change-acts' }, h && !failed ? el('a', { class: 'cx-open', href: h }, 'Open', icon('arrow', 12)) : null));
}

function draftLine(s) {
  const lead = s.lead_id || (s.table_name === 'leads' ? s.row_id : null);
  const h = safeHash(s.link) || (lead ? safeHash(`#inbox/${lead}`) : null);
  return el('li', { class: 'cx-change is-draft' },
    el('span', { class: 'cx-op' }, 'Draft'),
    el('span', { class: 'cx-change-main' }, el('span', { class: 'cx-change-sum' }, stepText(s) || 'Wrote a draft reply. Nothing was sent.')),
    el('span', { class: 'cx-change-acts' }, h ? el('a', { class: 'cx-open', href: h }, 'Inbox', icon('arrow', 12)) : null));
}

function youMsg(m, { pending = false } = {}) {
  return el('li', { class: `cx-msg is-you${pending ? ' is-pending' : ''}`, dataset: { msg: String(m.id ?? ''), role: 'user' } },
    el('div', { class: 'cx-you', title: m.at ? timeOnly(m.at) : null }, m.text));
}

function agentMsg(m) {
  const changes = changesOf(m);
  const drafts = m.draft ? [] : arr(m.steps).filter(isDraftStep);
  const notes = arr(m.steps).filter((s) => isFailedStep(s) || isPlainWrite(s));
  const reads = readsOf(m);
  const seen = new Set(changes.map(linkOf).filter(Boolean));
  const links = arr(m.links).map((l) => ({ label: str(l?.label) ? l.label.trim().slice(0, 80) : '', hash: safeHash(l?.hash) }))
    .filter((l) => l.hash && !seen.has(l.hash) && (seen.add(l.hash) || true)).slice(0, 6);
  const draftHash = m.draft ? safeHash(`#inbox/${m.draft.lead_id}`) : null;
  const meta = [MODEL_NAME[m.model] || null, Number(m.cost_usd) > 0 ? usd(m.cost_usd) : null].filter(Boolean).join(' · ');
  return el('li', { class: 'cx-msg is-agent', dataset: { msg: String(m.id ?? ''), role: 'assistant' } },
    el('p', { class: 'cx-by' }, el('span', { class: 'cx-by-name' }, 'Wise AI'), m.at ? el('span', { class: 'cx-by-time' }, timeOnly(m.at)) : null),
    el('div', { class: 'cx-text' }, m.text.trim() ? richText(m.text) : el('p', { class: 'muted' }, 'No reply came back.')),
    changes.length || drafts.length || notes.length
      ? el('div', { class: 'cx-did', dataset: { did: '' } },
        el('p', { class: 'cx-did-h' }, 'What I did'),
        el('ul', { class: 'cx-changes' }, changes.map((c) => changeLine(c)), drafts.map(draftLine), notes.map((s) => noteLine(s, isFailedStep(s)))))
      : null,
    draftHash ? el('p', { class: 'cx-draft', dataset: { draftNotice: m.draft.lead_id } }, icon('message', 14),
      el('span', {}, 'Draft is in the inbox reply box. Nothing was sent.'),
      el('a', { href: draftHash }, 'Open the inbox', icon('arrow', 12))) : null,
    links.length ? el('div', { class: 'cx-links', dataset: { links: '' } }, links.map((l) => el('a', { class: 'cx-link', href: l.hash }, l.label || l.hash, icon('arrow', 12)))) : null,
    reads.length || meta
      ? el('div', { class: 'cx-foot' },
        reads.length ? el('details', { class: 'cx-reads' }, el('summary', {}, `Looked up ${plural(reads.length, 'thing')}`),
          el('ul', {}, reads.map((s) => el('li', {}, stepText(s) || humanTool(s.tool))))) : null,
        meta ? el('span', { class: 'cx-cost tnum' }, meta) : null)
      : null);
}

function sendIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '18'); svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M12 19V5', 'M6 11l6-6 6 6']) { const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); svg.append(p); }
  return svg;
}

const PHRASES = [[4, 'Reading your hub'], [12, 'Working through it'], [Infinity, 'Still working on it']];
const phrase = (s) => PHRASES.find(([n]) => s < n)[1];

/* ====================================================================== panels */

/** "What it remembers": its notes, whose they are, and Forget. */
export function memoryPanel({ compact = false } = {}) {
  const list = el('ul', { class: 'cx-mem-list' });
  const count = el('span', { class: 'cx-side-count tnum' });
  const node = el('section', { class: `cx-side-sec cx-mem${compact ? ' is-compact' : ''}`, id: 'cx-memory', dataset: { memory: '' }, 'aria-labelledby': 'cx-mem-h' },
    el('div', { class: 'cx-side-head' }, el('h2', { class: 'cx-side-h', id: 'cx-mem-h' }, 'What it remembers'), count),
    list);
  let key = null;
  const update = () => {
    const mem = state.agent_memory || [];
    const k = mem.map((m) => `${m.id}:${m.text}`).join('|') + (state.me?.id || '');
    if (k === key) return;
    key = k;
    count.textContent = mem.length ? String(mem.length) : '';
    fill(list, mem.length ? mem.map((m) => {
      const whose = m.member_id == null ? 'The business' : m.member_id === state.me?.id ? 'Yours' : 'A teammate’s';
      const del = el('button', { type: 'button', class: 'cx-icon-btn', dataset: { act: 'memory-delete' }, 'aria-label': `Forget: ${String(m.text).slice(0, 60)}` }, icon('trash', 14));
      del.addEventListener('click', async () => {
        const ok = await confirmDialog('Forget this?', `“${String(m.text).slice(0, 200)}” will no longer be used in conversations.`, { confirmLabel: 'Forget' });
        if (!ok) return;
        await busy(del, async () => { const r = await memoryDelete(m.id); if (r.ok) toast('Forgotten'); else toast(r.message, 'bad'); });
      });
      return el('li', { class: 'cx-mem-item', dataset: { mem: m.id, scope: m.member_id == null ? 'business' : 'me' } },
        el('div', { class: 'cx-mem-body' }, el('p', { class: 'cx-mem-text' }, m.text), el('p', { class: 'cx-mem-meta' }, whose, m.created_at ? ` · ${timeAgo(m.created_at)}` : '')),
        del);
    }) : el('li', { class: 'cx-side-empty' }, 'Nothing yet. Say “remember that…” in a conversation and it keeps the note here, for you or for the whole business.'));
  };
  update();
  return { node, update };
}

/** The latest changes it made, from every conversation, each with Open and Undo. */
export function changesPanel({ limit = 10 } = {}) {
  const list = el('ul', { class: 'cx-changes is-recent' });
  const node = el('section', { class: 'cx-side-sec cx-recent', dataset: { recent: '' }, 'aria-labelledby': 'cx-recent-h' },
    el('div', { class: 'cx-side-head' }, el('h2', { class: 'cx-side-h', id: 'cx-recent-h' }, 'What it changed lately')),
    list);
  let key = null;
  const update = () => {
    const rows = (state.agent_changes || []).slice(0, limit);
    const k = rows.map((c) => `${c.id}:${c.undone_at || ''}:${S.undoing.has(c.id)}:${S.undoErr.get(c.id) || ''}`).join('|');
    if (k === key) return;
    key = k;
    fill(list, rows.length ? rows.map((c) => changeLine(c, { when: true })) : el('li', { class: 'cx-side-empty' }, 'Nothing yet. Every change it makes is listed here, with a link to the record and an Undo.'));
  };
  update();
  return { node, update };
}

/** Settings: the model the assistant runs on. Saves at once. */
export function chatModelPicker() {
  const name = 'agent_chat_model';
  const opts = CHAT_MODELS.map((m) => {
    const r = el('input', { type: 'radio', class: 'cx-model-in', name, value: m.id });
    r.addEventListener('change', async () => {
      if (!r.checked) return;
      opts.forEach((o) => { o.r.disabled = true; });
      try { await saveSettings({ agent_chat_model: m.id }); toast(`The assistant now uses: ${m.label}`); } catch (e) { toast(e.message, 'bad'); }
      opts.forEach((o) => { o.r.disabled = false; });
      update();
    });
    return { m, r, node: el('label', { class: 'cx-model', dataset: { model: m.id } }, r, el('span', { class: 'cx-model-text' }, el('strong', {}, m.label), el('span', {}, m.line))) };
  });
  const update = () => {
    const v = state.settings?.agent_chat_model || 'claude-sonnet-5-5';
    opts.forEach((o) => { if (!o.r.disabled) o.r.checked = o.m.id === v; });
  };
  update();
  const node = el('fieldset', { class: 'cx-models', dataset: { chatModel: '' } }, el('legend', { class: 'cx-models-legend' }, 'Which model it uses'), opts.map((o) => o.node));
  return { node, update };
}

/* ===================================================================== surface */

/**
 * The chat itself. mode 'dock' (the owl dropdown: one pane at a time, history or the
 * conversation) or 'page' (Agents page: history · conversation · memory and changes).
 * → { node, update, focus, onOpen, setView, view, title }
 */
export function chatSurface({ mode = 'page', active = () => true, side = [], footer = null, onUpdate = null } = {}) {
  const dock = mode === 'dock';
  let view = 'chat';
  let boundKey = null;
  let scrollNext = 'bottom';
  let timer = 0;

  /* -- composer */
  const box = el('textarea', {
    class: 'cx-input', name: 'chat-message', rows: 1, maxlength: String(MAX_MESSAGE), enterkeyhint: 'send', autocomplete: 'off',
    placeholder: 'Ask, or tell it what to do', 'aria-label': 'Message the assistant'
  });
  const sendBtn = el('button', { type: 'submit', class: 'cx-send', 'aria-label': 'Send', title: 'Send (Enter)', dataset: { act: 'chat-send' } }, sendIcon());
  const count = el('span', { class: 'cx-count tnum', hidden: true });
  const notice = el('div', { class: 'cx-notice' });
  const form = el('form', { class: 'cx-composer', novalidate: true },
    notice,
    el('div', { class: 'cx-box' }, box, sendBtn),
    el('div', { class: 'cx-under' }, el('span', { class: 'cx-hint' }, el('kbd', {}, 'Enter'), 'to send', el('span', { class: 'cx-hint-sep', 'aria-hidden': 'true' }, '·'), el('kbd', {}, 'Shift'), el('kbd', {}, 'Enter'), 'for a new line'), count));
  const grow = () => {
    box.style.height = 'auto';
    const max = dock ? 168 : 240;
    box.style.height = `${Math.min(max, Math.max(24, box.scrollHeight))}px`;
    box.style.overflowY = box.scrollHeight > max ? 'auto' : 'hidden';
  };
  const drawCount = () => {
    const n = box.value.length;
    count.hidden = n < MAX_MESSAGE - 600;
    count.textContent = `${n.toLocaleString('en-AU')} / ${MAX_MESSAGE.toLocaleString('en-AU')}`;
  };
  box.addEventListener('input', () => { S.drafts.set(keyOf(), box.value); grow(); drawCount(); paintSend(); });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const t = box.value.trim();
    if (!t) { box.focus(); return; }
    if (!ready() || S.pending.has(keyOf())) return;
    scrollNext = 'bottom';
    send(t);
    box.value = ''; grow(); drawCount();
    box.focus();
  });
  const ready = () => agentsInfo().ready('chat');
  const paintSend = () => {
    const k = keyOf();
    sendBtn.disabled = !box.value.trim() || S.pending.has(k) || !ready();
    form.classList.toggle('is-waiting', S.pending.has(k));
  };

  /* -- conversation */
  const live = el('p', { class: 'sr-only', 'aria-live': 'polite' });
  const log = el('ol', { class: 'cx-log', 'aria-label': 'Conversation' });
  const scroller = el('div', { class: 'cx-scroll' }, log);
  const convTitle = el('h2', { class: 'cx-title', id: `cx-title-${mode}` });
  const convActs = el('div', { class: 'cx-conv-acts' });
  const histToggle = el('button', { type: 'button', class: 'btn btn-ghost btn-sm cx-hist-toggle', dataset: { act: 'chat-history' }, 'aria-expanded': 'false' }, icon('list', 14), 'Conversations');
  histToggle.addEventListener('click', () => setView(view === 'history' ? 'chat' : 'history'));
  const convHead = dock ? null : el('div', { class: 'cx-conv-head' }, el('div', { class: 'cx-conv-title' }, el('p', { class: 'eyebrow' }, 'Conversation'), convTitle), el('div', { class: 'cx-conv-tools' }, histToggle, convActs));
  const conv = el('section', { class: 'cx-conv', 'aria-labelledby': dock ? null : `cx-title-${mode}`, 'aria-label': dock ? 'Conversation' : null }, convHead, scroller, form, live);

  /* -- history */
  const list = el('ul', { class: 'cx-list', 'aria-label': 'Conversations' });
  const archivedBox = el('div', { class: 'cx-archived' });
  const newBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm cx-new', dataset: { act: 'chat-new' }, 'aria-label': 'New conversation', title: 'New conversation' }, icon('plus', 14), 'New');
  newBtn.addEventListener('click', () => { newChat(); setView('chat'); focus(); });
  const backBtn = dock ? null : el('button', { type: 'button', class: 'btn btn-ghost btn-sm cx-back', dataset: { act: 'chat-back' }, onClick: () => { setView('chat'); focus(); } }, 'Back to the conversation');
  const hist = el('section', { class: 'cx-hist', 'aria-labelledby': `cx-hist-h-${mode}` },
    backBtn,
    el('div', { class: 'cx-hist-head' }, el('h2', { class: 'cx-side-h', id: `cx-hist-h-${mode}` }, 'Conversations'), newBtn),
    list, archivedBox, footer);

  /* -- side (page) */
  const mem = dock ? null : memoryPanel();
  const recent = dock ? null : changesPanel();
  const sidePane = dock ? null : el('aside', { class: 'cx-side', 'aria-label': 'Memory and recent changes' }, mem.node, recent.node, side);

  const node = el('div', { class: `cx is-${mode}`, dataset: { view, chatSurface: mode } }, hist, conv, sidePane);

  function setView(v) {
    view = v;
    node.dataset.view = v;
    histToggle.setAttribute('aria-expanded', String(v === 'history'));
    if (v === 'history') ensurePreviews();
    update();
    if (v === 'chat') { scrollNext = 'bottom'; drawLog(true); }
  }

  let histKey = null;
  let showArchived = false;
  function drawHistory() {
    const chats = liveChats();
    const archived = state.agent_chats.filter((c) => c.archived);
    const k = JSON.stringify([chats.map((c) => [c.id, c.title, c.updated_at, S.previews.get(c.id) || '', S.pending.has(c.id)]), archived.map((c) => [c.id, c.title]), S.current, showArchived]);
    if (k === histKey) return;
    histKey = k;
    const row = (c) => {
      const cur = c.id === S.current;
      const working = S.pending.has(c.id);
      const acts = el('span', { class: 'cx-item-acts' },
        el('button', { type: 'button', class: 'cx-icon-btn', dataset: { act: 'chat-rename' }, 'aria-label': `Rename “${c.title || 'New conversation'}”`, title: 'Rename', onClick: () => renameChat(c) }, icon('edit', 14)),
        c.archived
          ? el('button', { type: 'button', class: 'cx-icon-btn', dataset: { act: 'chat-restore' }, 'aria-label': 'Restore', title: 'Restore', onClick: () => archiveChat(c, false) }, icon('refresh', 14))
          : el('button', { type: 'button', class: 'cx-icon-btn', dataset: { act: 'chat-archive' }, 'aria-label': `Archive “${c.title || 'New conversation'}”`, title: 'Archive', onClick: () => archiveChat(c, true) }, icon('archive', 14)),
        el('button', { type: 'button', class: 'cx-icon-btn', dataset: { act: 'chat-delete' }, 'aria-label': `Delete “${c.title || 'New conversation'}”`, title: 'Delete', onClick: () => deleteChat(c) }, icon('trash', 14)));
      return el('li', { class: `cx-item${cur ? ' is-current' : ''}`, dataset: { chat: c.id } },
        el('button', { type: 'button', class: 'cx-item-open', 'aria-current': cur ? 'true' : null, onClick: () => { openChat(c.id); setView('chat'); focus(); } },
          el('span', { class: 'cx-item-top' },
            el('span', { class: 'cx-item-title' }, c.title || 'New conversation'),
            el('span', { class: 'cx-item-when' }, working ? 'working…' : timeAgo(c.updated_at || c.created_at))),
          S.previews.get(c.id) ? el('span', { class: 'cx-item-first' }, S.previews.get(c.id)) : null),
        acts);
    };
    fill(list,
      S.current === null ? el('li', { class: 'cx-item is-current is-new' }, el('span', { class: 'cx-item-open' }, el('span', { class: 'cx-item-top' }, el('span', { class: 'cx-item-title' }, 'New conversation'), el('span', { class: 'cx-item-when' }, S.pending.has('new') ? 'working…' : 'now')))) : null,
      chats.map(row),
      !chats.length && S.current !== null ? el('li', { class: 'cx-side-empty' }, 'No conversations yet. Your first message starts one, and it is kept here.') : null);
    if (!archived.length) { clear(archivedBox); return; }
    const tog = el('button', { type: 'button', class: 'link-btn cx-archived-toggle', 'aria-expanded': String(showArchived), dataset: { act: 'chat-archived' }, onClick: () => { showArchived = !showArchived; drawHistory(); } },
      `Archived (${archived.length})`, icon('chevron', 12));
    fill(archivedBox, tog, showArchived ? el('ul', { class: 'cx-list is-archived', 'aria-label': 'Archived conversations' }, archived.map(row)) : null);
  }

  function drawHead() {
    const c = S.current ? chatById(S.current) : null;
    const t = S.current ? (c?.title || 'Conversation') : 'New conversation';
    convTitle.textContent = t;
    if (dock) return;
    fill(convActs, c ? [
      el('button', { type: 'button', class: 'link-btn', dataset: { act: 'conv-rename' }, onClick: () => renameChat(c) }, 'Rename'),
      el('button', { type: 'button', class: 'link-btn', dataset: { act: 'conv-archive' }, onClick: () => archiveChat(c, !c.archived) }, c.archived ? 'Restore' : 'Archive'),
      el('button', { type: 'button', class: 'link-btn is-danger', dataset: { act: 'conv-delete' }, onClick: () => deleteChat(c) }, 'Delete')
    ] : null);
  }

  function emptyConv() {
    const ex = dock ? CHAT_EXAMPLES.slice(0, 4) : CHAT_EXAMPLES;
    return el('li', { class: 'cx-empty', dataset: { chatEmpty: '' } },
      el('p', { class: 'cx-empty-h' }, 'Ask it, or tell it what to do.'),
      el('p', { class: 'cx-empty-p' }, 'It reads every part of the hub and makes the changes you ask for. Each change is listed under its reply with an Undo. It never sends anything to anyone.'),
      el('ul', { class: 'cx-examples', 'aria-label': 'Examples' }, ex.map((t) => el('li', {},
        el('button', { type: 'button', class: 'cx-example', dataset: { example: '' }, onClick: () => { box.value = t; S.drafts.set(keyOf(), t); grow(); drawCount(); paintSend(); box.focus(); box.setSelectionRange(t.length, t.length); } },
          el('span', {}, t), icon('arrow', 13))))));
  }

  let logKey = null;
  let lastCount = 0;
  function drawLog(force = false) {
    const k = keyOf();
    const entry = S.current ? S.msgs.get(S.current) : null;
    const msgs = entry?.list || [];
    const pend = S.pending.get(k);
    const changeStamp = msgs.flatMap((m) => changesOf(m).map((c) => `${c.id}:${c.undone_at || ''}:${S.undoing.has(c.id)}:${S.undoErr.get(c.id) || ''}`)).join(',');
    const lk = JSON.stringify([k, entry?.status, msgs.map((m) => m.id), Boolean(pend), changeStamp]);
    if (!force && lk === logKey) return;
    logKey = lk;
    const atBottom = dock ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40 : true;
    const prevTop = scroller.scrollTop;
    const items = [];
    if (S.current && !msgs.length && entry?.status !== 'error' && !pend) items.push(el('li', { class: 'cx-loading', dataset: { chatLoading: '' } }, el('span', { class: 'cx-pulse', 'aria-hidden': 'true' }), 'Opening the conversation…'));
    else if (S.current && !msgs.length && entry?.status === 'error') {
      const again = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => { S.msgs.delete(S.current); ensureMsgs(S.current); } }, icon('refresh', 14), 'Try again');
      items.push(el('li', { class: 'cx-error', role: 'alert' }, icon('alert', 15), el('div', { class: 'cx-error-body' }, el('p', {}, entry.message), el('div', { class: 'cx-error-acts' }, again))));
    } else if (!msgs.length && !pend) items.push(emptyConv());
    let day = '';
    for (const m of msgs) {
      const d = m.at ? dayKey(m.at) : day;
      if (d && d !== day) { if (msgs.length > 1 || day) items.push(el('li', { class: 'cx-day', 'aria-hidden': 'true' }, el('span', {}, dayLabel(m.at)))); day = d; }
      items.push(m.role === 'user' ? youMsg(m) : agentMsg(m));
    }
    if (pend) {
      items.push(youMsg({ id: 'pending', text: pend.text, at: pend.at }, { pending: true }));
      items.push(el('li', { class: 'cx-working', dataset: { working: '' } },
        el('span', { class: 'cx-pulse', 'aria-hidden': 'true' }),
        el('span', { class: 'cx-working-text' }, phrase(0)),
        el('span', { class: 'cx-working-time tnum' })));
    }
    fill(log, items);
    // Keep the reader where they were unless something new arrived.
    const grew = msgs.length > lastCount || Boolean(pend);
    if (msgs.length > lastCount && lastCount && !pend) live.textContent = 'Reply received.';
    lastCount = msgs.length;
    if (dock) {
      if (scrollNext === 'bottom' || (grew && atBottom)) scroller.scrollTop = scroller.scrollHeight;
      else scroller.scrollTop = prevTop;
    } else if ((scrollNext === 'bottom' || grew) && log.lastElementChild && node.isConnected && msgs.length + (pend ? 1 : 0) > 1) {
      const last = log.lastElementChild;
      requestAnimationFrame(() => last.scrollIntoView({ block: 'end', behavior: scrollNext === 'bottom' && !grew ? 'auto' : 'smooth' }));
    }
    scrollNext = null;
    tickWorking();
  }

  function tickWorking() {
    const pend = S.pending.get(keyOf());
    if (!pend) { if (timer) { clearInterval(timer); timer = 0; } return; }
    const paint = () => {
      const p = S.pending.get(keyOf());
      const w = log.querySelector('.cx-working');
      if (!p || !w) return;
      const s = Math.max(0, Math.round((Date.now() - Date.parse(p.at)) / 1000));
      w.querySelector('.cx-working-text').textContent = phrase(s);
      w.querySelector('.cx-working-time').textContent = s >= 3 ? `${s} s` : '';
    };
    paint();
    if (!timer) timer = setInterval(() => { if (!node.isConnected && !dock) { clearInterval(timer); timer = 0; return; } paint(); }, 1000);
  }

  let noticeKey = null;
  function drawNotice() {
    const k = keyOf();
    const err = S.errors.get(k);
    const info = agentsInfo();
    const off = !info.ready('chat') ? (!info.reachable ? 'unreachable' : !info.connected ? 'not-connected' : !info.master ? 'master-off' : 'chat-off') : '';
    const nk = JSON.stringify([k, err?.error, err?.message, off]);
    if (nk === noticeKey) return;
    noticeKey = nk;
    if (off) {
      const text = { unreachable: 'The assistant cannot be reached right now. Your conversations are still here.', 'not-connected': 'The assistant is not connected yet. It needs the Anthropic API key in Supabase.', 'master-off': 'All the agents are switched off.', 'chat-off': 'The assistant is switched off.' }[off];
      const on = off === 'chat-off' || off === 'master-off'
        ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { act: 'chat-on' } }, 'Turn it on') : null;
      on?.addEventListener('click', () => busy(on, async () => {
        try { await saveSettings(off === 'master-off' ? { agents_enabled: true, agent_chat: true } : { agent_chat: true }); toast('The assistant is on'); agentStatus(); } catch (e) { toast(e.message, 'bad'); }
      }));
      fill(notice, el('div', { class: 'cx-error is-off', dataset: { chatOff: off } }, icon(off === 'unreachable' ? 'alert' : 'lock', 15),
        el('div', { class: 'cx-error-body' }, el('p', {}, text), on || off === 'not-connected' ? el('div', { class: 'cx-error-acts' }, on, off === 'not-connected' ? el('a', { class: 'link-btn', href: '#settings' }, 'Open Settings') : null) : null)));
      return;
    }
    if (!err) { clear(notice); return; }
    const retry = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { act: 'chat-retry' } }, icon('refresh', 14), 'Try again');
    retry.addEventListener('click', () => {
      const t = box.value.trim() || err.text;
      if (!t) return;
      box.value = ''; grow(); drawCount();
      scrollNext = 'bottom';
      send(t);
    });
    const dismiss = el('button', { type: 'button', class: 'cx-icon-btn', 'aria-label': 'Dismiss', onClick: () => { S.errors.delete(k); noticeKey = null; drawNotice(); } }, icon('x', 14));
    fill(notice, el('div', { class: 'cx-error', role: 'alert', dataset: { chatError: err.error } }, icon('alert', 15),
      el('div', { class: 'cx-error-body' },
        el('p', {}, el('strong', {}, 'Not sent. '), err.message, ' Your message is still in the box below.'),
        el('div', { class: 'cx-error-acts' }, retry, err.href ? el('a', { class: 'link-btn', href: err.href }, err.link) : null)),
      dismiss));
  }

  function update() {
    if (!active()) return;
    ensureCurrent();
    const k = keyOf();
    if (k !== boundKey) {
      boundKey = k;
      box.value = S.drafts.get(k) || '';
      grow(); drawCount();
      scrollNext = 'bottom';
      if (!dock && node.isConnected && S.current && /^#agents(\/(chat(\/[\w-]+)?)?)?$/.test(location.hash)) history.replaceState(null, '', `#agents/chat/${S.current}`);
    } else if ((document.activeElement !== box || !box.value) && box.value !== (S.drafts.get(k) || '')) {
      // Another surface typed here, or a failed send put the text back.
      box.value = S.drafts.get(k) || ''; grow(); drawCount();
    }
    if (S.current) ensureMsgs(S.current);
    if (view === 'history' || !dock) ensurePreviews();
    drawHead();
    drawHistory();
    drawLog();
    drawNotice();
    paintSend();
    mem?.update();
    recent?.update();
    onUpdate?.();
  }

  function focus() {
    if (view !== 'chat' && dock) return;
    setTimeout(() => { box.focus({ preventScroll: true }); const n = box.value.length; box.setSelectionRange(n, n); }, 20);
  }

  /** The dropdown opening: an empty new conversation gives way to the newest one. */
  function onOpen() {
    if (S.current === null && !(S.drafts.get('new') || '').trim() && !S.pending.has('new') && !S.errors.has('new')) { S.current = undefined; S.chosen = false; }
    view = 'chat';
    node.dataset.view = 'chat';
    scrollNext = 'bottom';
    histKey = null; logKey = null;
    update();
  }

  let seen = false;
  subs.add(() => {
    if (node.isConnected) seen = true;
    if (!dock && seen && !node.isConnected) { if (timer) clearInterval(timer); return false; }
    update();
    return true;
  });
  grow();
  update();
  return {
    node, update, focus, onOpen, setView,
    get view() { return view; },
    title: () => (S.current ? chatById(S.current)?.title || 'Conversation' : 'New conversation'),
    newChat: () => { newChat(); setView('chat'); focus(); },
    showMemory: () => { setView('history'); mem?.node.scrollIntoView({ block: 'start' }); }
  };
}
