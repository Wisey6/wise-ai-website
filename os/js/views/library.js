// Library: the reference shelf. Playbooks, standards, knowledge, research, brand
// notes, templates and case studies: what Tyler consults rather than ships.
// Bodies are plain text with a small, safe formatter (built with el(), never innerHTML).
import {
  el, icon, toast, confirmDialog, field, input, select, emptyState, copyText, busy, timeAgo, plural, go
} from '../ui.js?v=20261118c';
import { state, saveRow, deleteRow, rowById } from '../api.js?v=20261118c';

export const KINDS = [
  { id: 'playbook', label: 'Playbook' },
  { id: 'standard', label: 'Standard' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'research', label: 'Research' },
  { id: 'brand', label: 'Brand' },
  { id: 'template', label: 'Template' },
  { id: 'case_study', label: 'Case study' },
  { id: 'other', label: 'Other' }
];
const KIND = Object.fromEntries(KINDS.map((k) => [k.id, k.label]));

/* ============================================================ pure helpers */

/** http(s) URLs only; anything else is refused (null). Bare domains get https://. */
export function safeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^https?:\/\/[^\s<>"']+$/i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(\/[^\s<>"']*)?$/i.test(s)) return `https://${s}`;
  return null;
}

/** "a, b,  c" → ['a','b','c'] (trimmed, de-duplicated, lower-cased). */
export function parseTags(raw) {
  const out = [];
  for (const t of String(raw || '').split(',')) {
    const v = t.trim().toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Plain text → blocks. Blank line = new paragraph; "# " and "## " = headings;
 * "- " or "* " = list item; "1. " = numbered item. Lines inside a paragraph keep
 * their line breaks.
 * → [{type:'h1'|'h2'|'p', text} | {type:'ul'|'ol', items:[text]}]
 */
export function parseBlocks(text) {
  const blocks = [];
  let para = null;
  let list = null;
  const endPara = () => { if (para) { blocks.push({ type: 'p', text: para.join('\n') }); para = null; } };
  const endList = () => { if (list) { blocks.push(list); list = null; } };
  for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if (!line.trim()) { endPara(); endList(); continue; }
    if ((m = /^##\s+(.*)$/.exec(line))) { endPara(); endList(); blocks.push({ type: 'h2', text: m[1].trim() }); continue; }
    if ((m = /^#\s+(.*)$/.exec(line))) { endPara(); endList(); blocks.push({ type: 'h1', text: m[1].trim() }); continue; }
    if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) {
      endPara();
      if (!list || list.type !== 'ul') { endList(); list = { type: 'ul', items: [] }; }
      list.items.push(m[1].trim());
      continue;
    }
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      endPara();
      if (!list || list.type !== 'ol') { endList(); list = { type: 'ol', items: [] }; }
      list.items.push(m[1].trim());
      continue;
    }
    if (list && /^\s{2,}\S/.test(raw)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
    endList();
    (para ||= []).push(line.trim());
  }
  endPara(); endList();
  return blocks;
}

/** "**bold** rest" → [{bold:true,text:'bold'},{text:' rest'}]. Unclosed ** stays literal. */
export function parseInline(text) {
  const out = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m;
  const s = String(text || '');
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    out.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}

function inline(text) {
  const kids = [];
  parseInline(text).forEach((p) => {
    const parts = p.text.split('\n');
    const nodes = [];
    parts.forEach((t, i) => { if (i) nodes.push(el('br')); if (t) nodes.push(t); });
    kids.push(p.bold ? el('strong', {}, nodes) : nodes);
  });
  return kids;
}

/** Render a body to DOM nodes (text nodes only; no HTML from the data). */
export function formatBody(text) {
  return parseBlocks(text).map((b) => {
    if (b.type === 'h1') return el('h3', { class: 'lib-h' }, inline(b.text));
    if (b.type === 'h2') return el('h4', { class: 'lib-h4' }, inline(b.text));
    if (b.type === 'ul') return el('ul', { class: 'lib-ul' }, b.items.map((t) => el('li', {}, inline(t))));
    if (b.type === 'ol') return el('ol', { class: 'lib-ol' }, b.items.map((t) => el('li', {}, inline(t))));
    return el('p', {}, inline(b.text));
  });
}

/* ------------------------------------------------------------ case studies */
export const CASE_FIELDS = ['Client', 'The problem', 'What we built', 'The result in numbers'];
export const CASE_TEMPLATE = `${CASE_FIELDS.map((f) => `${f}: `).join('\n')}\n\n## What happened\n`;

/** Split a case study body into its structured header and the rest. */
export function parseCaseStudy(body) {
  const lines = String(body || '').replace(/\r\n?/g, '\n').split('\n');
  const fields = [];
  let i = 0;
  const re = new RegExp(`^(${CASE_FIELDS.map((f) => f.replace(/ /g, '\\s+')).join('|')})\\s*:\\s*(.*)$`, 'i');
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const m = re.exec(line.trim());
    if (!m) break;
    const label = CASE_FIELDS.find((f) => f.toLowerCase() === m[1].replace(/\s+/g, ' ').toLowerCase()) || m[1];
    fields.push({ label, value: m[2].trim() });
  }
  return { fields, rest: lines.slice(i).join('\n').trim() };
}

/* ------------------------------------------------------------ starters */
export const STARTERS = [
  {
    title: 'Discovery call questions', kind: 'playbook', tags: ['sales', 'calls'], pinned: true,
    body: `Use this on every first call. The aim is to find one problem worth solving, put a dollar figure on it, and agree a next step before you hang up.

# Before the call
- Read the lead's notes, website and Google reviews.
- Write down one specific thing you noticed about the business.
- Have the ROI calculator open.

# Open
1. Thanks for making the time. I've got about 20 minutes blocked out, does that still suit?
2. Tell me a bit about the business. How long have you been going, and who's on the team?

# Find the problem
- Walk me through what happens when a new enquiry comes in.
- What happens to calls you can't answer while you're on a job?
- Which part of the week do you most wish someone else would handle?
- What have you already tried to fix it?

# Put a number on it
- Roughly how many enquiries a week do you think slip through?
- What's an average job worth to you?
- How many hours a week go on admin, quoting and chasing?
- What would you do with those hours back?

# Close the call
- **Repeat their problem back in their words**, with the number attached.
- Say what you would build and roughly what it costs.
- Agree the next step and a date: a proposal by Friday, or a second call with whoever makes the decision.
- Log the call and set the next step in the pipeline before you do anything else.`
  },
  {
    title: 'Proposal checklist', kind: 'standard', tags: ['sales', 'proposals'],
    body: `Run through this before any proposal goes out. A proposal should read like it was written for one business, because it was.

# The problem
- Uses the client's own words from the discovery call.
- States what the problem is costing them now, in dollars or hours a month.

# The solution
- Says what you will build in plain English, not tool names.
- Lists what is in scope and what is not.
- Says what they need to provide: logins, content, a contact person.

# The numbers
- **Return before price**: what they get back each month sits above what it costs.
- One-off and monthly fees are listed separately, with GST shown if you are registered.
- Payment terms, and the date the proposal is valid until.

# Before you send
1. Check names, the business name and spelling.
2. Read it out loud once.
3. Send it with a short personal message, not as a bare attachment.
4. Set a follow-up in the pipeline for three to five business days out.`
  },
  {
    title: 'Client onboarding checklist', kind: 'standard', tags: ['delivery', 'onboarding'],
    body: `The first two weeks set the tone. Aim for the client to feel looked after and to see something working early.

# Day one
- Send a welcome email: what happens next, who to contact, and when they'll hear from you.
- Send the first invoice or deposit request.
- Create the client and the project in the hub, with the start date and monthly value.

# Access and setup
- Collect logins through a password manager share, never by text or email.
- Confirm the phone numbers, email addresses and calendars the build touches.
- Note who signs off on changes.

# Kick-off call
1. Re-confirm the problem and the number you're measuring.
2. Record the starting figures (missed calls, hours on admin, response time) so the first ROI report has a baseline.
3. Agree the first milestone and its date.

# First fortnight
- Ship one small, visible win in the first week.
- Check in after the first week with what's done and what's next.
- Book the first monthly review in the calendar.`
  },
  {
    title: 'Monthly ROI report checklist', kind: 'standard', tags: ['delivery', 'roi'],
    body: `Every active client gets a short report each month. It is the reason they keep paying, so make the value easy to see.

# Gather
- Pull this month's figures for the same measures recorded at kick-off.
- Count the hours saved and agree the hourly value with the client.
- Note any new revenue you can fairly put down to the work.

# Write
- **Lead with the result**: what they got back this month, in dollars and hours.
- Compare it with what they paid for the month.
- Keep it to one page. Plain language, no jargon.
- Mention anything that didn't go to plan, and what you did about it.

# Next steps
1. One or two improvements for next month.
2. Anything you need from them.
3. Send it, then mark it sent in ROI reports.`
  },
  {
    title: 'Offboarding and handover', kind: 'playbook', tags: ['delivery', 'offboarding'],
    body: `When a client finishes, leave them in a good position. They may come back, and they will talk about how it ended.

# Before the last day
- Confirm the end date and the final invoice in writing.
- List every system, automation and account you set up for them.

# Handover
1. Write a short handover note: what runs, where it lives, and how to switch it off.
2. Transfer or confirm ownership of accounts, numbers and domains in their name.
3. Remove your own access, or agree in writing what you keep and why.
4. Cancel any costs you were carrying for them, and update Costs in the hub.

# Close out
- Send a final ROI summary covering the whole engagement.
- Ask for a testimonial or a Google review if it went well.
- Mark the client as past and archive the project.
- If the result was strong, write it up as a case study here in the Library.`
  }
];

/** Insert the starter entries (titlePrefix is for tests). Returns the saved rows. */
export async function addStarters(titlePrefix = '') {
  const out = [];
  for (const s of STARTERS) out.push(await saveRow('library', { ...s, title: `${titlePrefix}${s.title}` }));
  return out;
}

/** Search and filter. Pinned first, then most recently updated. */
export function filterEntries(list, { q = '', kind = '', archived = false } = {}) {
  const needle = q.trim().toLowerCase();
  return list
    .filter((e) => Boolean(e.archived) === Boolean(archived))
    .filter((e) => !kind || e.kind === kind)
    .filter((e) => !needle || [e.title, e.body, (e.tags || []).join(' ')].join(' ').toLowerCase().includes(needle))
    .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)));
}

/* ================================================================== view */
const ui = { q: '', kind: '', archived: false, editing: null };
let flushPending = null; // a pending autosave from an editor that is being replaced

const clientName = (id) => state.clients.find((c) => c.id === id)?.name || '';

export default function library(ctx) {
  if (flushPending) { const f = flushPending; flushPending = null; f(); }
  const param = ctx.param || '';
  const isNew = param === 'new';
  const entryId = !isNew && param ? param : null;
  if (isNew) ui.editing = 'new';
  else if (ui.editing !== entryId) ui.editing = null;

  const root = el('div', { class: `page lib${param ? ' has-doc' : ''}` });

  /* ---------------------------------------------------------- side */
  const search = el('input', {
    class: 'input lib-search', type: 'search', placeholder: 'Search titles, text and tags', 'aria-label': 'Search the library',
    value: ui.q, onInput: () => { ui.q = search.value; drawList(); }
  });
  const chips = el('div', { class: 'lib-kinds', role: 'group', 'aria-label': 'Filter by kind' });
  const list = el('ul', { class: 'lib-list', 'aria-label': 'Library entries' });
  const count = el('p', { class: 'lib-count small muted', 'aria-live': 'polite' });

  function drawChips() {
    const live = state.library.filter((e) => Boolean(e.archived) === ui.archived);
    const n = (k) => live.filter((e) => e.kind === k).length;
    chips.replaceChildren(
      el('button', { type: 'button', class: `chip${!ui.kind ? ' is-active' : ''}`, 'aria-pressed': String(!ui.kind), onClick: () => { ui.kind = ''; drawSide(); } }, 'All'),
      ...KINDS.filter((k) => n(k.id) || ui.kind === k.id).map((k) => el('button', {
        type: 'button', class: `chip${ui.kind === k.id ? ' is-active' : ''}`, 'aria-pressed': String(ui.kind === k.id),
        onClick: () => { ui.kind = ui.kind === k.id ? '' : k.id; drawSide(); }
      }, k.label, el('span', { class: 'count' }, ` ${n(k.id)}`))),
      el('button', {
        type: 'button', class: `chip lib-arch-toggle${ui.archived ? ' is-active' : ''}`, 'aria-pressed': String(ui.archived),
        onClick: () => { ui.archived = !ui.archived; ui.kind = ''; drawSide(); }
      }, icon('archive', 13), ui.archived ? 'Showing archived' : 'Archived'));
  }

  function drawList() {
    const rows = filterEntries(state.library, ui);
    count.textContent = state.library.length
      ? `${plural(rows.length, ui.archived ? 'archived entry' : 'entry', ui.archived ? 'archived entries' : 'entries')}${ui.q ? ` matching “${ui.q.trim()}”` : ''}`
      : '';
    if (!rows.length) {
      list.replaceChildren(el('li', { class: 'lib-list-none small muted' },
        state.library.length ? (ui.archived ? 'Nothing archived.' : 'Nothing matches. Try another word or clear the filter.') : 'No entries yet.'));
      return;
    }
    list.replaceChildren(...rows.map((e) => el('li', {},
      el('a', { class: `lib-item${e.id === entryId ? ' is-active' : ''}`, href: `#library/${e.id}`, 'aria-current': e.id === entryId ? 'page' : null, dataset: { id: e.id } },
        el('span', { class: 'lib-item-top' },
          el('span', { class: 'lib-item-title' }, e.title || 'Untitled'),
          e.pinned ? el('span', { class: 'lib-pin', title: 'Pinned' }, pinIcon(13), el('span', { class: 'sr-only' }, ' (pinned)')) : null),
        el('span', { class: 'lib-item-meta' },
          el('span', {}, KIND[e.kind] || 'Other'),
          (e.tags || []).length ? el('span', { class: 'truncate' }, (e.tags || []).slice(0, 3).join(', ')) : null,
          el('span', { class: 'lib-item-when' }, timeAgo(e.updated_at || e.created_at)))))));
  }
  const drawSide = () => { drawChips(); drawList(); };

  const side = el('aside', { class: 'lib-side', 'aria-label': 'Library list' },
    el('label', { class: 'lib-search-wrap' }, icon('search', 15), search),
    chips, count, list);

  /* ---------------------------------------------------------- main */
  const main = el('section', { class: 'lib-main', 'aria-live': 'polite' });

  function drawMain() {
    if (isNew) { main.replaceChildren(editor(null)); return; }
    if (!entryId) { main.replaceChildren(welcome()); return; }
    const e = rowById('library', entryId);
    if (!e) {
      main.replaceChildren(el('div', { class: 'lib-doc' }, backLink(),
        emptyState({ icon: 'book', title: 'That entry is not here', text: 'It may have been deleted. Pick another from the list.' })));
      return;
    }
    main.replaceChildren(ui.editing === entryId ? editor(e) : doc(e));
  }

  function welcome() {
    if (!state.library.length) {
      const startBtn = el('button', { type: 'button', class: 'btn btn-primary', dataset: { act: 'starters' } }, icon('plus', 15), 'Add starter entries');
      startBtn.addEventListener('click', () => busy(startBtn, async () => {
        try { const rows = await addStarters(); toast(`Added ${plural(rows.length, 'entry', 'entries')}`); go(`#library/${rows[0].id}`); } catch (er) { toast(er.message, 'bad'); }
      }));
      return el('div', { class: 'lib-welcome' },
        emptyState({
          icon: 'book', title: 'Your reference shelf',
          text: 'Checklists, scripts, standards, research and case studies: the things you look up rather than send. Start with five written for this business, or add your own.',
          action: el('div', { class: 'row' }, startBtn, el('a', { class: 'btn btn-ghost', href: '#library/new' }, 'Write one'))
        }),
        el('ul', { class: 'lib-starter-list small muted' }, STARTERS.map((s) => el('li', {}, s.title))));
    }
    const pinned = filterEntries(state.library, {}).filter((e) => e.pinned).slice(0, 4);
    return el('div', { class: 'lib-welcome' },
      emptyState({ icon: 'book', title: 'Pick an entry', text: pinned.length ? 'Or open one you pinned.' : 'Search on the left, or write something new.' }),
      pinned.length ? el('ul', { class: 'lib-quick' }, pinned.map((e) => el('li', {}, el('a', { href: `#library/${e.id}` }, pinIcon(13), e.title)))) : null);
  }

  /* ----------------------------------------------------- read mode */
  function doc(e) {
    const link = safeUrl(e.url);
    const cname = e.client_id ? clientName(e.client_id) : '';
    const cs = e.kind === 'case_study' ? parseCaseStudy(e.body) : null;
    const body = cs ? cs.rest : e.body;
    const hasBody = String(body || '').trim();
    const pinBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-pressed': String(!!e.pinned), dataset: { act: 'pin' } }, pinIcon(14), e.pinned ? 'Unpin' : 'Pin');
    pinBtn.addEventListener('click', () => busy(pinBtn, () => patch(e.id, { pinned: !e.pinned }, e.pinned ? 'Unpinned' : 'Pinned')));
    const archBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { act: 'archive' } }, icon('archive', 14), e.archived ? 'Restore' : 'Archive');
    archBtn.addEventListener('click', () => busy(archBtn, () => patch(e.id, { archived: !e.archived }, e.archived ? 'Restored' : 'Archived. Find it under Archived.')));
    const delBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm is-danger', dataset: { act: 'delete' } }, icon('trash', 14), 'Delete');
    delBtn.addEventListener('click', async () => {
      const ok = await confirmDialog('Delete this entry?', `“${e.title}” will be deleted for good. Archiving keeps it out of the way without losing it.`);
      if (!ok) return;
      try { await deleteRow('library', e.id); toast('Entry deleted'); go('#library'); } catch (er) { toast(er.message, 'bad'); }
    });

    return el('article', { class: 'lib-doc', 'aria-labelledby': 'lib-doc-h' },
      backLink(),
      el('header', { class: 'lib-doc-head' },
        el('p', { class: 'eyebrow' }, [KIND[e.kind] || 'Other', e.archived ? 'Archived' : null, `Updated ${timeAgo(e.updated_at || e.created_at)}`].filter(Boolean).join(' · ')),
        el('h1', { class: 'h1 lib-title', id: 'lib-doc-h' }, e.title),
        (e.tags || []).length || cname || link ? el('div', { class: 'lib-meta' },
          cname ? el('a', { class: 'lib-meta-link', href: `#clients/${e.client_id}` }, icon('user', 13), cname) : null,
          link ? el('a', { class: 'lib-meta-link', href: link, target: '_blank', rel: 'noopener noreferrer' }, icon('external', 13), hostOf(link), el('span', { class: 'sr-only' }, ' (opens in a new tab)')) : null,
          (e.tags || []).map((t) => el('button', { type: 'button', class: 'lib-tag', title: `Search for ${t}`, onClick: () => { ui.q = t; search.value = t; drawList(); } }, `#${t}`))) : null,
        el('div', { class: 'lib-actions' },
          el('button', { type: 'button', class: 'btn btn-primary btn-sm', dataset: { act: 'edit' }, onClick: () => { ui.editing = e.id; drawMain(); } }, icon('edit', 14), 'Edit'),
          el('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { act: 'copy' }, disabled: !String(e.body || '').trim() || null, onClick: () => copyText(e.body || '', 'Text copied') }, icon('copy', 14), 'Copy text'),
          pinBtn, el('span', { class: 'spacer' }), archBtn, delBtn)),
      cs && cs.fields.some((f) => f.value) ? el('dl', { class: 'lib-case' },
        cs.fields.map((f) => el('div', { class: `lib-case-row${/result/i.test(f.label) ? ' is-result' : ''}` },
          el('dt', {}, f.label), el('dd', {}, f.value || el('span', { class: 'faint' }, 'Not filled in yet'))))) : null,
      hasBody ? el('div', { class: 'lib-body' }, formatBody(body))
        : el('p', { class: 'muted lib-nobody' }, 'Nothing written yet. ', el('button', { type: 'button', class: 'link-btn', onClick: () => { ui.editing = e.id; drawMain(); } }, 'Start writing')));
  }

  /* ----------------------------------------------------- edit mode */
  function editor(e) {
    let id = e?.id || null;
    const f = {
      title: input('title', { value: e?.title || '', required: true, maxlength: 200, placeholder: 'e.g. Discovery call questions', 'aria-label': 'Title' }),
      kind: select('kind', KINDS, e?.kind || 'knowledge'),
      tags: input('tags', { value: (e?.tags || []).join(', '), placeholder: 'sales, calls' }),
      url: input('url', { type: 'url', value: e?.url || '', placeholder: 'https://…', inputmode: 'url' }),
      client_id: select('client_id', [{ id: '', label: 'No client' }, ...state.clients.filter((c) => !c.archived || c.id === e?.client_id)
        .sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ id: c.id, label: c.name }))], e?.client_id || ''),
      body: el('textarea', { class: 'input lib-textarea', name: 'body', rows: 18, spellcheck: 'true', 'aria-label': 'Body', placeholder: 'Write in plain text.\n\n# A heading\n- a point\n1. a step\n**bold** for emphasis' }),
      pinned: el('input', { type: 'checkbox', class: 'check', name: 'pinned', checked: e?.pinned || null })
    };
    f.title.classList.add('lib-title-input');
    f.body.value = e?.body || '';
    const urlHint = el('span', { class: 'field-hint' }, 'Opens in a new tab. http and https links only.');
    const status = el('span', { class: 'lib-save', role: 'status', dataset: { state: id ? 'saved' : 'new' } }, id ? 'Saved' : 'Not saved yet');
    const setStatus = (s, text) => { status.dataset.state = s; status.textContent = text; };

    let timer = null;
    let saving = false;
    let again = false;
    const read = () => {
      const urlRaw = f.url.value.trim();
      const url = safeUrl(urlRaw);
      return {
        title: f.title.value.trim(), kind: f.kind.value, tags: parseTags(f.tags.value),
        url: urlRaw ? url : null, urlBad: Boolean(urlRaw && !url),
        client_id: f.client_id.value || null, body: f.body.value, pinned: f.pinned.checked
      };
    };
    async function flush() {
      clearTimeout(timer); timer = null;
      if (flushPending === flush) flushPending = null;
      if (saving) { again = true; return; }
      const v = read();
      urlHint.textContent = v.urlBad ? 'That link was not saved: it must start with http:// or https://' : 'Opens in a new tab. http and https links only.';
      urlHint.classList.toggle('is-bad', v.urlBad);
      if (!v.title) { setStatus('warn', 'Needs a title to save'); return; }
      const { urlBad, ...row } = v;
      if (urlBad) delete row.url;
      saving = true;
      setStatus('saving', 'Saving…');
      try {
        const saved = await saveRow('library', id ? { id, ...row } : row);
        if (!id) {
          id = saved.id;
          ui.editing = id;
          history.replaceState(null, '', `#library/${id}`);
        }
        setStatus(urlBad ? 'warn' : 'saved', urlBad ? 'Saved, except the link' : 'Saved');
      } catch (er) {
        setStatus('bad', 'Not saved');
        toast(`Could not save: ${er.message}`, 'bad');
      }
      saving = false;
      if (again) { again = false; flush(); }
    }
    const schedule = () => {
      setStatus('dirty', 'Saving soon…');
      clearTimeout(timer);
      timer = setTimeout(flush, 700);
      flushPending = flush;
    };
    f.kind.addEventListener('change', () => {
      if (f.kind.value === 'case_study' && !f.body.value.trim()) f.body.value = CASE_TEMPLATE;
    });
    const form = el('form', { class: 'lib-edit', novalidate: true, onSubmit: (ev) => ev.preventDefault() },
      el('div', { class: 'lib-edit-bar' },
        el('p', { class: 'eyebrow' }, id ? 'Editing' : 'New entry'), status, el('span', { class: 'spacer' }),
        el('button', {
          type: 'button', class: 'btn btn-primary btn-sm', dataset: { act: 'done' },
          onClick: async () => {
            await flush();
            if (!id) { if (!f.title.value.trim()) { f.title.focus(); toast('Give it a title first', 'warn'); } return; }
            ui.editing = null;
            if (location.hash !== `#library/${id}`) go(`#library/${id}`); else drawMain();
          }
        }, icon('check', 14), 'Done')),
      field('Title', f.title),
      el('div', { class: 'form-grid lib-edit-grid' },
        field('Kind', f.kind),
        field('Client', f.client_id, 'Optional. Useful for case studies and client notes.'),
        field('Tags', f.tags, 'Comma separated'),
        el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Link'), f.url, urlHint)),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Body'), f.body,
        el('span', { class: 'field-hint' }, 'Blank line for a new paragraph · # heading · ## smaller heading · - point · 1. step · **bold**')),
      el('label', { class: 'set-toggle lib-pin-toggle' }, f.pinned, el('span', {}, el('strong', {}, 'Pin to the top'), el('span', { class: 'set-toggle-hint' }, 'Pinned entries sit first in the list and on the library home.'))));
    form.addEventListener('input', schedule);
    form.addEventListener('change', schedule);
    setTimeout(() => (id ? f.body : f.title).focus({ preventScroll: true }), 30);
    return el('div', { class: 'lib-doc' }, backLink(), form);
  }

  function backLink() {
    return el('a', { class: 'lib-back', href: '#library' }, icon('chevron-left', 15), 'All entries');
  }

  async function patch(id, p, msg) {
    try { await saveRow('library', { id, ...p }); toast(msg); } catch (er) { toast(er.message, 'bad'); }
  }

  const newBtn = el('a', { class: 'btn btn-primary', href: '#library/new', dataset: { act: 'new' } }, icon('plus', 15), 'New entry');
  root.append(
    el('header', { class: 'page-head lib-head' },
      el('div', { class: 'stack' },
        el('p', { class: 'eyebrow' }, 'Know'),
        el('h1', { class: 'h1' }, 'Library'),
        el('p', { class: 'muted lib-lede' }, 'The reference shelf: playbooks, standards, research, brand notes, templates and case studies.')),
      newBtn),
    el('div', { class: 'lib-wrap' }, side, main));

  drawSide();
  drawMain();
  root.onState = () => {
    drawSide();
    // Never redraw an open editor: what is being typed stays put.
    if (ui.editing && (ui.editing === 'new' || ui.editing === entryId || isNew)) return;
    drawMain();
  };
  return root;
}

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'Link'; }
}

function pinIcon(size) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M9 4h6l-1 6 3 3H7l3-3zM12 13v7');
  svg.append(p);
  return svg;
}
