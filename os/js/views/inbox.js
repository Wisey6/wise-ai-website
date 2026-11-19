// Inbox: every SMS conversation, unread first. Thread + reply box that survives live
// updates (drafts live outside the DOM, and node.onState never touches the textarea).
// Lead fields and inbound SMS are untrusted: text nodes and input values only.
import {
  el, icon, go, badge, statusBadge, toast, confirmDialog, emptyState, timeAgo, timeOnly,
  dayKey, dayLabel, prettyPhone, copyText, busy
} from '../ui.js?v=20261119b';
import {
  state, messagesFor, saveLead, suppress, renderTemplate, leadName, logEvent, ai
} from '../api.js?v=20261119b';
import { ownerPicker, ownerBadge, saveOwner, readScope, scopeToggle, inScope, meId } from '../owners.js?v=20261119b';
import { deliver, finalBody, segmentCounter, errText, AU_MOBILE, suppressedSet } from './campaigns.js?v=20261119b';

/** append / replaceChildren that skip null and false children (native ones would print "null"). */
const keep = (c) => c.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false);
const add = (n, ...c) => { n.append(...keep(c)); return n; };
const put = (n, ...c) => { n.replaceChildren(...keep(c)); return n; };

const fill2 = (n, ...c) => { n.replaceChildren(...c.filter(Boolean)); return n; };
const drafts = new Map();      // leadId → typed text (kept across re-renders and route changes)
const threads = new Map();     // leadId → message rows, oldest first
let filter = 'all';
let query = '';

const STATUS_ACTIONS = [
  ['interested', 'Interested'],
  ['booked', 'Booked'],
  ['lost', 'Lost'],
  ['dnc', 'Do not contact']
];

/* ------------------------------------------------------------ data */

function lastActivity(lead, last) {
  return Math.max(
    last ? Date.parse(last.created_at) : 0,
    lead.last_reply_at ? Date.parse(lead.last_reply_at) : 0,
    lead.last_contacted_at ? Date.parse(lead.last_contacted_at) : 0);
}

/** Conversations: leads with messages (or reply/contact history), unread first, then latest. */
export function conversations() {
  const lastBy = new Map();
  const inboundBy = new Set();
  for (const m of state.messages || []) {
    if (m.channel !== 'sms') continue;
    const prev = lastBy.get(m.lead_id);
    if (!prev || Date.parse(m.created_at) >= Date.parse(prev.created_at)) lastBy.set(m.lead_id, m);
    if (m.direction === 'in') inboundBy.add(m.lead_id);
  }
  for (const [id, rows] of threads) {
    const sms = rows.filter((m) => m.channel === 'sms');
    const last = sms[sms.length - 1];
    if (last) {
      const prev = lastBy.get(id);
      if (!prev || Date.parse(last.created_at) >= Date.parse(prev.created_at)) lastBy.set(id, last);
    }
    if (sms.some((m) => m.direction === 'in')) inboundBy.add(id);
  }
  const out = [];
  for (const lead of state.leads || []) {
    const last = lastBy.get(lead.id) || null;
    if (!last && !lead.unread && !lead.last_reply_at && !lead.last_contacted_at) continue;
    out.push({ lead, last, at: lastActivity(lead, last), waiting: last ? last.direction === 'in' : !!lead.unread,
      replied: inboundBy.has(lead.id) || !!lead.last_reply_at });
  }
  out.sort((a, b) => (b.lead.unread - a.lead.unread) || (b.at - a.at));
  return out;
}

function mergeThread(leadId) {
  const cur = threads.get(leadId);
  if (!cur) return;
  const byId = new Map(cur.map((m) => [m.id, m]));
  let changed = false;
  for (const m of state.messages || []) {
    if (m.lead_id !== leadId) continue;
    const prev = byId.get(m.id);
    if (!prev || prev.status !== m.status || prev.error !== m.error) { byId.set(m.id, { ...prev, ...m }); changed = true; }
  }
  if (changed) threads.set(leadId, [...byId.values()].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)));
  return changed;
}

/* ------------------------------------------------------------ view */

export default function inbox(ctx = {}) {
  const leadId = ctx.param || null;
  const root = el('div', { class: `page inbox${leadId ? ' has-thread' : ''}` });

  /* ---------- list pane */
  const search = el('input', { class: 'input inbox-search', type: 'search', placeholder: 'Search conversations', 'aria-label': 'Search conversations', value: query });
  search.addEventListener('input', () => { query = search.value; renderList(); });
  let scope = meId() ? readScope('inbox') : 'all';
  const filterBtns = [['all', 'All'], ['unread', 'Unread'], ['waiting', 'Waiting on you']].map(([id, label]) =>
    el('button', { class: `tab${filter === id ? ' is-active' : ''}`, type: 'button', 'aria-pressed': filter === id ? 'true' : 'false', dataset: { f: id },
      onClick: () => { filter = id; filterBtns.forEach((b) => { const on = b.dataset.f === id; b.classList.toggle('is-active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }); renderList(); } }, label, el('span', { class: 'count inbox-fcount' })));
  const scopeBox = el('div', { class: 'inbox-scope' });
  const paintScope = () => fill2(scopeBox, meId() ? scopeToggle('inbox', scope, (v) => { scope = v; renderList(); }, { label: 'Whose conversations' }) : null);
  const listEl = el('ul', { class: 'inbox-list', 'aria-label': 'Conversations' });
  const listPane = el('aside', { class: 'inbox-side' },
    el('div', { class: 'inbox-side-head' },
      el('div', { class: 'row' }, el('h1', { class: 'h2 inbox-title' }, 'Inbox'), el('span', { class: 'spacer' }), el('span', { class: 'inbox-unread-total' })),
      el('label', { class: 'inbox-search-wrap' }, icon('search', 15), search),
      scopeBox,
      el('div', { class: 'tabs inbox-filters' }, filterBtns)),
    listEl);

  function renderList() {
    if (!scopeBox.firstChild && meId()) { scope = readScope('inbox'); paintScope(); }
    // Yours and unowned conversations by default; "Everyone" shows all of them.
    const all = conversations().filter((c) => inScope(scope, c.lead));
    const unreadTotal = all.filter((c) => c.lead.unread).length;
    const counts = { all: all.length, unread: unreadTotal, waiting: all.filter((c) => c.waiting).length };
    filterBtns.forEach((b) => { const n = counts[b.dataset.f]; const c = b.querySelector('.inbox-fcount'); c.textContent = n ? String(n) : ''; c.hidden = !n; });
    const tot = listPane.querySelector('.inbox-unread-total');
    tot.textContent = unreadTotal ? `${unreadTotal} unread` : '';
    const q = query.trim().toLowerCase();
    const rows = all.filter((c) => (filter === 'unread' ? c.lead.unread : filter === 'waiting' ? c.waiting : true))
      .filter((c) => !q || [leadName(c.lead), c.lead.contact_name, c.lead.phone, prettyPhone(c.lead.phone), c.lead.suburb, c.last?.body]
        .some((v) => String(v || '').toLowerCase().includes(q)));
    listEl.replaceChildren();
    if (!rows.length) {
      listEl.append(el('li', { class: 'inbox-list-empty' }, emptyState({
        icon: 'inbox',
        title: all.length ? 'Nothing matches' : 'No conversations yet',
        text: all.length ? 'Try another filter or search.' : 'Texts you send and every reply land here.'
      })));
      return;
    }
    for (const c of rows) {
      const l = c.lead;
      const preview = c.last ? `${c.last.direction === 'out' ? 'You: ' : ''}${c.last.body}` : 'No messages in the last 30 days';
      listEl.append(el('li', {},
        el('a', {
          class: `inbox-item${l.unread ? ' is-unread' : ''}${l.id === leadId ? ' is-active' : ''}`,
          href: `#inbox/${l.id}`, 'aria-current': l.id === leadId ? 'true' : null
        },
          el('span', { class: 'inbox-avatar', 'aria-hidden': 'true' }, initials(l)),
          el('span', { class: 'inbox-item-main' },
            el('span', { class: 'inbox-item-top' },
              el('span', { class: 'inbox-item-name' }, leadName(l)),
              el('span', { class: 'inbox-item-time' }, c.at ? timeAgo(new Date(c.at).toISOString()) : '')),
            el('span', { class: 'inbox-item-body' },
              el('span', { class: 'inbox-item-preview' },
                drafts.get(l.id)?.trim() ? el('span', { class: 'inbox-draft-tag' }, 'Draft · ') : null, preview),
              l.unread ? el('span', { class: 'inbox-dot', role: 'img', 'aria-label': 'Unread' }) : null),
            el('span', { class: 'inbox-item-meta' }, statusBadge(l.status), l.owner_id ? ownerBadge(l.owner_id, { size: 'sm' }) : null)))));
    }
  }

  /* ---------- thread pane */
  const threadPane = el('section', { class: 'inbox-thread', 'aria-label': 'Conversation' });
  let lead = leadId ? (state.leads || []).find((l) => l.id === leadId) : null;
  const head = el('header', { class: 'inbox-thread-head' });
  const msgsEl = el('div', { class: 'inbox-msgs', role: 'log', 'aria-live': 'polite', 'aria-label': 'Messages' });
  let composer = null;
  let holdUnread = false;   // set when the operator marks a thread unread on purpose

  function hasReplied() {
    return !!lead?.last_reply_at || (threads.get(leadId) || []).some((m) => m.direction === 'in' && m.channel === 'sms');
  }
  function blocked() {
    if (!lead) return 'Lead not found';
    if (lead.status === 'dnc') return 'This lead is marked do not contact.';
    if (!lead.phone) return 'This lead has no phone number.';
    if (suppressedSet().has(lead.phone)) return 'This number has opted out.';
    if (!AU_MOBILE.test(lead.phone)) return 'Only Australian mobiles can be texted from here.';
    return null;
  }

  let ownerNode = null;
  function threadOwner() {
    if (!ownerNode) ownerNode = ownerPicker({ value: lead.owner_id || null, label: 'Conversation owner', onChange: (oid) => saveOwner('leads', lead.id, oid) });
    else ownerNode.setValue(lead.owner_id || null);
    ownerNode.classList.add('inbox-owner');
    return ownerNode;
  }

  function renderHead() {
    lead = (state.leads || []).find((l) => l.id === leadId) || lead;
    if (!lead) { head.replaceChildren(); return; }
    const meta = [lead.contact_name && lead.contact_name !== leadName(lead) ? lead.contact_name : null, lead.suburb, lead.industry].filter(Boolean).join(' · ');
    const statusBtns = STATUS_ACTIONS.map(([id, label]) => {
      const on = lead.status === id;
      const b = el('button', { class: `inbox-status${on ? ' is-active' : ''}${id === 'dnc' ? ' inbox-dnc' : ''}`, type: 'button', 'aria-pressed': on ? 'true' : 'false' }, label);
      b.addEventListener('click', () => setStatus(id, b));
      return b;
    });
    put(head,
      el('div', { class: 'inbox-thread-top' },
        el('a', { class: 'btn btn-ghost btn-sm inbox-back', href: '#inbox', 'aria-label': 'Back to conversations' }, icon('chevron-left', 16)),
        el('span', { class: 'inbox-avatar is-lg', 'aria-hidden': 'true' }, initials(lead)),
        el('div', { class: 'inbox-thread-who' },
          el('h2', { class: 'h2 inbox-thread-name' }, leadName(lead)),
          el('div', { class: 'inbox-thread-meta muted' },
            lead.phone ? el('a', { href: `tel:${lead.phone}` }, prettyPhone(lead.phone)) : 'No phone',
            meta ? ` · ${meta}` : '')),
        el('span', { class: 'spacer' }),
        threadOwner(),
        el('a', { class: 'btn btn-ghost btn-sm', href: `#leads/${lead.id}`, title: 'Open the lead' }, icon('user', 15), el('span', { class: 'inbox-hide-sm' }, 'Lead')),
        el('button', { class: 'icon-btn inbox-unread-btn', type: 'button', title: lead.unread ? 'Mark read' : 'Mark unread',
          'aria-label': lead.unread ? 'Mark read' : 'Mark unread', onClick: (e) => toggleUnread(e.currentTarget) },
        icon(lead.unread ? 'check' : 'mail', 15))),
      el('div', { class: 'inbox-thread-bar' },
        el('span', { class: 'inbox-thread-status' }, statusBadge(lead.status)),
        el('div', { class: 'inbox-thread-actions', role: 'group', 'aria-label': 'Set status' }, statusBtns)),
      (lead.hook || lead.pain || Number(lead.est_monthly_value) > 0) ? el('div', { class: 'inbox-ctx' },
        lead.hook ? el('span', {}, el('b', {}, 'Your line'), lead.hook) : null,
        lead.pain ? el('span', {}, el('b', {}, 'Pain'), lead.pain) : null,
        Number(lead.est_monthly_value) > 0 ? el('span', { class: 'tnum' }, el('b', {}, 'Worth'), `$${Math.round(lead.est_monthly_value).toLocaleString('en-AU')}/mo`) : null) : null);
  }

  async function setStatus(id, btn) {
    if (!lead || lead.status === id) return;
    if (id === 'dnc') {
      const ok = await confirmDialog('Do not contact?', `${leadName(lead)} will get no more texts and the number goes on the suppression list. This cannot be undone from here.`, { confirmLabel: 'Do not contact' });
      if (!ok) return;
    }
    await busy(btn, async () => {
      try {
        const patch = { status: id };
        if (['dnc', 'lost', 'booked'].includes(id)) patch.next_followup_at = null;
        if (id === 'dnc' && lead.phone) await suppress(lead.phone, 'manual');
        await saveLead(lead.id, patch);
        logEvent('status', lead.id, `${leadName(lead)} → ${id}`).catch(() => {});
        toast(`Marked ${STATUS_ACTIONS.find((s) => s[0] === id)[1].toLowerCase()}`);
      } catch (err) { toast(`Could not update: ${err.message}`, 'bad'); }
    });
  }

  async function toggleUnread(btn) {
    if (!lead.unread) holdUnread = true;
    await busy(btn, async () => {
      try {
        await saveLead(lead.id, { unread: !lead.unread });
        toast(lead.unread ? 'Marked unread' : 'Marked read');
        if (lead.unread) go('#inbox');
      } catch (err) { toast(`Could not update: ${err.message}`, 'bad'); }
    });
  }

  function renderMsgs() {
    const rows = threads.get(leadId);
    const nearBottom = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 80;
    msgsEl.replaceChildren();
    if (!rows) { msgsEl.append(el('div', { class: 'inbox-loading muted' }, 'Loading conversation…')); return; }
    if (!rows.length) { msgsEl.append(el('div', { class: 'inbox-none muted' }, 'No messages yet. Write the first one below.')); return; }
    let day = '';
    for (const m of rows) {
      const k = dayKey(m.created_at);
      if (k !== day) { day = k; msgsEl.append(el('div', { class: 'inbox-day' }, el('span', {}, dayLabel(m.created_at)))); }
      if (m.channel === 'call' || m.channel === 'note' || m.channel === 'email') {
        msgsEl.append(el('div', { class: 'inbox-sys' },
          el('span', { class: 'inbox-sys-kind' }, icon(m.channel === 'call' ? 'phone' : m.channel === 'email' ? 'mail' : 'note', 13),
            `${m.channel === 'call' ? 'Call' : m.channel === 'email' ? 'Email' : 'Note'} · ${timeOnly(m.created_at)}`),
          el('span', { class: 'inbox-sys-body' }, m.body)));
        continue;
      }
      const out = m.direction === 'out';
      msgsEl.append(el('div', { class: `inbox-msg ${out ? 'is-out' : 'is-in'}${m.status === 'failed' ? ' is-failed' : ''}` },
        el('div', { class: 'inbox-bubble' }, m.body),
        el('div', { class: 'inbox-msg-meta' },
          el('time', { datetime: m.created_at, title: new Date(m.created_at).toLocaleString('en-AU') }, timeOnly(m.created_at)),
          out ? el('span', { class: `inbox-state is-${m.status}` }, deliveryLabel(m)) : null)));
    }
    if (nearBottom || !msgsEl.dataset.scrolled) {
      requestAnimationFrame(() => { msgsEl.scrollTop = msgsEl.scrollHeight; });
      msgsEl.dataset.scrolled = '1';
    }
  }

  async function loadThread(force = false) {
    if (!leadId) return;
    if (threads.has(leadId) && !force) { mergeThread(leadId); renderMsgs(); }
    try {
      const rows = await messagesFor(leadId);
      threads.set(leadId, rows);
      mergeThread(leadId);
      renderMsgs();
      renderList();
      composer?.refresh();
    } catch (err) {
      if (!threads.has(leadId)) msgsEl.replaceChildren(el('div', { class: 'inbox-none muted' }, `Could not load messages: ${err.message}`));
    }
  }

  /* ---------- composer (built once; never rebuilt by live updates) */
  function buildComposer() {
    const ta = el('textarea', { class: 'input inbox-input', rows: 3, placeholder: 'Write a reply…', 'aria-label': 'Reply' });
    ta.value = drafts.get(leadId) || '';
    const counter = segmentCounter();
    const preview = el('div', { class: 'inbox-preview', hidden: true });
    const notice = el('div', { class: 'callout is-bad inbox-blocked', hidden: true });
    const quick = el('div', { class: 'inbox-quick', role: 'group', 'aria-label': 'Quick replies' });
    const aiBox = el('div', { class: 'inbox-ai', hidden: true, role: 'group', 'aria-label': 'Suggested replies' });
    let aiFor = null;   // id of the inbound message the suggestions answer
    const latestSms = () => { const rows = (threads.get(leadId) || []).filter((m) => m.channel === 'sms'); return rows[rows.length - 1] || null; };
    const aiBtn = el('button', { class: 'chip inbox-chip inbox-ai-btn', type: 'button', title: 'Draft reply options with AI. Nothing is sent.' }, icon('spark', 14), 'Suggest replies');
    aiBtn.addEventListener('click', () => busy(aiBtn, suggestReplies));
    async function suggestReplies() {
      const last = latestSms();
      const thread = (threads.get(leadId) || []).filter((m) => m.channel === 'sms').slice(-12)
        .map((m) => ({ from: m.direction === 'in' ? 'them' : 'us', text: m.body }));
      const res = await ai('reply', {
        lead: { business: lead?.business || null, contact_name: lead?.contact_name || null, status: lead?.status || null },
        thread, booking_url: state.settings?.booking_url || null
      });
      if (!res.ok) { toast(res.message, 'bad'); return; }
      const options = (res.result?.options || []).map((o) => String(o || '').trim()).filter(Boolean);
      if (!options.length) { toast('No suggestions came back. Try again.', 'warn'); return; }
      aiFor = last?.id || null;
      put(aiBox,
        el('div', { class: 'inbox-ai-head' }, el('span', { class: 'eyebrow' }, 'Suggested replies · pick one to edit'),
          el('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Dismiss suggestions', onClick: () => clearAi() }, icon('x', 14))),
        options.map((text) => el('button', { class: 'inbox-ai-opt', type: 'button', onClick: () => useSuggestion(text) }, text)));
      aiBox.hidden = false;
    }
    async function useSuggestion(text) {
      const cur = ta.value.trim();
      if (cur && cur !== text) {
        const ok = await confirmDialog('Replace what is there?', 'Your reply box already has text. Replace it with this suggestion?', { confirmLabel: 'Replace', danger: false });
        if (!ok) return;
      }
      ta.value = text;
      ta.dispatchEvent(new Event('input'));
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
    function clearAi() { aiFor = null; aiBox.hidden = true; aiBox.replaceChildren(); }
    function syncAi() {
      // Suggestions answer one message: they go when a newer message arrives.
      if (aiFor && latestSms()?.id !== aiFor) clearAi();
    }
    const actions = el('div', { class: 'inbox-send-row' });

    const finalText = () => finalBody(renderTemplate(ta.value, lead || {}, state.settings || {}), state.settings || {}, hasReplied());

    function onInput() {
      drafts.set(leadId, ta.value);
      const f = finalText();
      counter.update(f);
      const show = ta.value.trim() && f !== ta.value.trim();
      preview.hidden = !show;
      if (show) preview.replaceChildren(el('span', { class: 'eyebrow' }, 'Will send'), el('div', {}, f));
      autosize();
      paintActions();
    }
    function autosize() { ta.style.height = 'auto'; ta.style.height = `${Math.min(220, ta.scrollHeight + 2)}px`; }
    ta.addEventListener('input', onInput);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); actions.querySelector('.inbox-primary')?.click(); }
    });

    function insert(text) {
      const cur = ta.value.trim();
      ta.value = cur ? `${cur}\n${text}` : text;
      ta.dispatchEvent(new Event('input'));
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }

    function paintQuick() {
      const tpls = (state.templates || []).filter((t) => t.active && t.step >= 90);
      quick.replaceChildren(
        el('button', { class: 'chip inbox-chip is-key', type: 'button', onClick: (e) => sendBookingLink(e.currentTarget) }, icon('calendar', 14), 'Send booking link'),
        ...tpls.map((t) => el('button', { class: 'chip inbox-chip', type: 'button', title: t.body,
          onClick: () => insert(renderTemplate(t.body, lead || {}, state.settings || {})) }, t.name.replace(/^Reply:\s*/i, ''))),
        state.ai?.configured && state.ai.enabled && latestSms()?.direction === 'in' ? aiBtn : null);
      syncAi();
    }

    function paintActions() {
      const reason = blocked();
      notice.hidden = !reason;
      notice.replaceChildren(reason ? el('span', {}, icon('ban', 14), ` ${reason}`) : '');
      ta.disabled = !!reason;
      quick.querySelectorAll('button:not([aria-busy])').forEach((b) => { b.disabled = !!reason; });
      const empty = !ta.value.trim();
      const live = !!state.sms?.configured;
      const sendBtn = el('button', { class: `btn ${live ? 'btn-primary inbox-primary' : 'btn-ghost'}`, type: 'button', disabled: !live || empty || !!reason || null,
        title: live ? 'Send by SMS (Ctrl+Enter)' : 'SMS sending is not set up yet' }, icon('send', 15), 'Send');
      sendBtn.addEventListener('click', () => busy(sendBtn, () => send('send')));
      const manualBtn = el('button', { class: `btn ${live ? 'btn-ghost' : 'btn-primary inbox-primary'}`, type: 'button', disabled: empty || !!reason || null,
        title: 'Copy the text, then send it from your phone. It is recorded as sent.' }, icon('copy', 15), live ? 'Sent from my phone' : 'Copy & mark sent');
      manualBtn.addEventListener('click', () => busy(manualBtn, () => send('manual')));
      put(actions,counter, el('span', { class: 'spacer' }),
        live ? null : el('span', { class: 'muted inbox-mode-note' }, 'SMS not connected'),
        live ? manualBtn : null, live ? sendBtn : manualBtn);
    }

    async function send(mode, override) {
      const text = override || finalText();
      if (!text.trim()) return false;
      if (mode === 'manual') {
        const copied = await copyText(text, false);
        const r = await deliver({ lead, body: text, mode: 'manual' });
        if (!r.ok) { toast(`Not recorded: ${errText(r.error)}`, 'bad'); return false; }
        toast(copied ? 'Copied and recorded. Paste it into Messages on your phone.' : 'Recorded. Copy the text by hand to send it.', copied ? 'ok' : 'warn');
      } else {
        const r = await deliver({ lead, body: text, mode: 'send' });
        if (!r.ok) { toast(`Not sent: ${errText(r.error)}`, 'bad'); return false; }
        toast('Sent');
      }
      if (!override) { ta.value = ''; drafts.delete(leadId); onInput(); }
      if (lead.unread) saveLead(lead.id, { unread: false }).catch(() => {});
      loadThread(true);
      return true;
    }

    async function sendBookingLink(btn) {
      const url = state.settings?.booking_url;
      if (!url) { toast('Add your booking link in Settings first', 'warn'); go('#settings'); return; }
      const tpl = (state.templates || []).find((t) => t.active && t.step >= 90 && t.body.includes('{booking_url}'));
      const body = renderTemplate(tpl ? tpl.body : 'Easiest is a quick 15 minute call. Pick a time that suits here: {booking_url}', lead || {}, state.settings || {});
      const text = finalBody(body, state.settings || {}, hasReplied());
      await busy(btn, async () => {
        const ok = await send(state.sms?.configured ? 'send' : 'manual', text);
        if (ok && ['new', 'queued', 'contacted', 'replied'].includes(lead.status)) {
          try { await saveLead(lead.id, { status: 'interested', next_followup_at: null }); } catch { /* status is a nicety */ }
        }
      });
    }

    /* A reply drafted by one of the hub's agents, handed over through sessionStorage. Never sent automatically. */
    const agentNote = el('p', { class: 'inbox-agent-note', hidden: true }, icon('spark', 13), 'Draft from your agent. Read it before you send.');
    let agentDraft = null;
    try {
      agentDraft = sessionStorage.getItem(`wiseos.draft.${leadId}`);
      if (agentDraft !== null) sessionStorage.removeItem(`wiseos.draft.${leadId}`);
    } catch { agentDraft = null; }
    if (agentDraft && agentDraft.trim()) {
      if (!ta.value.trim()) {
        ta.value = agentDraft;
        drafts.set(leadId, agentDraft);
        agentNote.hidden = false;
      } else {
        put(aiBox,
          el('div', { class: 'inbox-ai-head' }, el('span', { class: 'eyebrow' }, 'Draft from your agent · pick to use'),
            el('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Dismiss the agent draft', onClick: () => clearAi() }, icon('x', 14))),
          el('button', { class: 'inbox-ai-opt is-agent', type: 'button', onClick: async () => { await useSuggestion(agentDraft); if (ta.value === agentDraft) agentNote.hidden = false; } }, agentDraft));
        aiBox.hidden = false;
      }
    }

    const node = el('div', { class: 'inbox-composer' }, agentNote, notice, quick, aiBox, preview, ta, actions);
    node.refresh = () => { paintQuick(); paintActions(); };
    paintQuick();
    onInput();
    return node;
  }

  if (leadId && lead) {
    composer = buildComposer();
    threadPane.append(head, msgsEl, composer);
    renderHead();
    if (!threads.has(leadId)) renderMsgs();
    loadThread();
    if (lead.unread) saveLead(lead.id, { unread: false }).catch(() => {});
  } else if (leadId) {
    threadPane.append(el('div', { class: 'inbox-placeholder' }, emptyState({ icon: 'inbox', title: 'Conversation not found', text: 'The lead may have been deleted.',
      action: el('a', { class: 'btn btn-ghost btn-sm', href: '#inbox' }, 'Back to inbox') })));
  } else {
    threadPane.append(el('div', { class: 'inbox-placeholder' }, emptyState({ icon: 'message', title: 'Pick a conversation', text: 'Replies waiting on you are at the top.' })));
  }

  root.append(listPane, threadPane);
  renderList();

  // Live updates: patch the list, header and messages. The composer textarea is never replaced.
  root.onState = () => {
    renderList();
    if (!leadId) return;
    if (!lead) {
      // The lead may have arrived after first render.
      if ((state.leads || []).some((l) => l.id === leadId)) go(`#inbox/${leadId}`);
      return;
    }
    const before = lead;
    renderHead();
    if (mergeThread(leadId)) renderMsgs();
    if (lead.unread && !holdUnread && before && document.visibilityState === 'visible' && root.isConnected) {
      // A new reply arrived while this thread is open: it has been seen.
      saveLead(lead.id, { unread: false }).catch(() => {});
    }
    composer?.refresh();
  };
  return root;
}

function initials(lead) {
  const n = leadName(lead).replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!n.length) return '#';
  return ((n[0][0] || '') + (n[1]?.[0] || '')).toUpperCase();
}

function deliveryLabel(m) {
  switch (m.status) {
    case 'queued': return 'Sending';
    case 'sent': return 'Sent';
    case 'delivered': return 'Delivered';
    case 'manual': return 'Sent from phone';
    case 'failed': return `Failed${m.error ? ` (${m.error})` : ''}`;
    default: return m.status;
  }
}
