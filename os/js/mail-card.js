// Email draft cards in the assistant's conversation (command bar and Agents page). A draft the
// assistant wrote shows To / Cc / Subject and the text, with Send (the only way an email leaves
// the hub, pressed by the person), Edit in Gmail and Discard. The card's state comes from the
// person's own mail_drafts rows, so it is right after a reload. Text nodes only, never HTML.
import { el, icon, timeOnly } from './ui.js?v=20261119a';
import { state } from './api.js?v=20261119a';
import {
  cancelProposal, confirmProposal, draftState, discardDraft, gmailDraftLink, loadMailDrafts, loadProposals, mailConnected, mailStamp, onMailChange,
  proposalState, refreshMailStatus, sendDraft
} from './mail-api.js?v=20261119a';

export { mailConnected, mailStamp, onMailChange };

/** The example ask added to an empty conversation when the person's email is connected. */
export const MAIL_EXAMPLE = 'Any replies in my email today that need an answer?';
const COLLAPSE_LINES = 10;
const arr = (v) => (Array.isArray(v) ? v : []);
const expanded = new Set();
// Motion: a draft that turns into Sent while it is on screen gets a short, satisfying
// change (the tick draws, the card settles). Timed from when it was seen, so a redraw
// mid-way carries on (os-mail.css).
const lastStatus = new Map();   // draft id → the status it was last drawn with
const sentAt = new Map();       // draft id → when it was seen turning into Sent
function stateChange(id, status) {
  const prev = lastStatus.get(id);
  lastStatus.set(id, status);
  if (status === 'sent' && prev && prev !== 'sent' && !sentAt.has(id)) sentAt.set(id, Date.now());
  const age = sentAt.has(id) ? Date.now() - sentAt.get(id) : Infinity;
  return age < 1400 ? age : null;
}
function tickIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '14', height: '14', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'cx-mail-tick' })) svg.setAttribute(k, v);
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M5 12.5l4.5 4.5L19 7.5');
  p.setAttribute('pathLength', '1');
  svg.append(p);
  return svg;
}

let booted = false;
/** Ask once (after sign-in) for the connection and the person's drafts. */
export function mailBoot() {
  if (booted || !state.me) return;
  booted = true;
  refreshMailStatus();
  loadMailDrafts();
  loadProposals();
}

/** The email drafts one reply carries (the last version of each draft in that reply). */
export function draftsOf(m) {
  const by = new Map();
  for (const s of arr(m?.steps)) {
    const e = s && s.ok !== false && s.email;
    if (e && typeof e === 'object' && typeof e.draft_id === 'string') by.set(e.draft_id, e);
  }
  return [...by.values()];
}

/** Is there a newer version of this draft further down the conversation? */
function supersededIn(m, id, all) {
  const at = Date.parse(m?.at || '') || 0;
  return all.some((x) => x !== m && x.role === 'assistant' && (Date.parse(x.at || '') || 0) > at && draftsOf(x).some((d) => d.draft_id === id));
}

const listText = (a) => arr(a).filter((x) => typeof x === 'string').join(', ');

/** One email draft card. `stale` when the same draft was changed in a later reply. */
export function emailCard(e, { stale = false } = {}) {
  const { row, busy, error } = draftState(e.draft_id);
  const status = stale ? 'stale' : row?.status || 'draft';
  const to = row?.to_addrs?.length ? row.to_addrs : arr(e.to);
  const cc = row?.cc_addrs?.length ? row.cc_addrs : arr(e.cc);
  const subject = (row?.subject || e.subject || '').trim() || '(no subject)';
  const body = String(e.body || '');
  const lines = body.split('\n');
  const long = lines.length > COLLAPSE_LINES || body.length > 900;
  const open = expanded.has(e.draft_id);
  const shown = long && !open ? `${lines.slice(0, COLLAPSE_LINES).join('\n').slice(0, 900).trimEnd()}…` : body;

  const justSent = stateChange(e.draft_id, busy ? 'sending' : status);
  const head = el('p', { class: 'cx-mail-head' }, icon('mail', 14),
    el('span', { class: 'cx-mail-kind' }, e.is_reply ? 'Reply draft' : 'Email draft'),
    el('span', { class: 'cx-mail-state', dataset: { mailState: status } },
      status === 'sent' ? tickIcon() : null,
      status === 'sent' ? `Sent ${row?.sent_at ? timeOnly(row.sent_at) : ''}`.trim()
        : status === 'discarded' ? 'Discarded'
          : status === 'sending' || busy ? 'Sending…'
            : status === 'stale' ? 'Changed further down'
              : 'Not sent'));
  const meta = el('dl', { class: 'cx-mail-meta' },
    el('dt', {}, 'To'), el('dd', {}, listText(to) || 'nobody yet'),
    cc.length ? [el('dt', {}, 'Cc'), el('dd', {}, listText(cc))] : null,
    el('dt', {}, 'Subject'), el('dd', {}, subject));
  const text = el('div', { class: 'cx-mail-body', dataset: { mailBody: '' } }, shown);
  const more = long ? el('button', { type: 'button', class: 'link-btn cx-mail-more', dataset: { act: 'mail-more' }, 'aria-expanded': String(open), onClick: () => {
    if (expanded.has(e.draft_id)) expanded.delete(e.draft_id); else expanded.add(e.draft_id);
    card.replaceWith(emailCard(e, { stale }));
  } }, open ? 'Show less' : 'Show all') : null;

  let acts = null;
  if (status === 'draft' && !busy) {
    const first = to[0] || '';
    const label = first ? `Send to ${first}${to.length + cc.length > 1 ? ` +${to.length + cc.length - 1}` : ''}` : 'Send';
    acts = el('div', { class: 'cx-mail-acts' },
      el('button', { type: 'button', class: 'btn btn-primary btn-sm cx-mail-send', dataset: { act: 'mail-send' }, title: label, disabled: !first || null, onClick: () => sendDraft(e.draft_id) }, icon('arrow', 13), el('span', { class: 'cx-mail-send-to' }, label)),
      el('a', { class: 'btn btn-ghost btn-sm', href: gmailDraftLink(row, e.gmail_url), target: '_blank', rel: 'noopener noreferrer', dataset: { act: 'mail-edit' } }, 'Edit in Gmail'),
      el('button', { type: 'button', class: 'link-btn cx-mail-discard', dataset: { act: 'mail-discard' }, onClick: () => discardDraft(e.draft_id) }, 'Discard'));
  }
  const card = el('div', { class: `cx-mail is-${status}${busy ? ' is-busy' : ''}${justSent !== null ? ' is-just-sent' : ''}`, dataset: { mailDraft: e.draft_id, state: status } },
    head, meta, text, more, acts,
    error && status === 'draft' ? el('p', { class: 'cx-mail-err', role: 'alert' }, error) : null);
  if (justSent !== null) card.style.setProperty('--sent-delay', `${-justSent}ms`);
  return card;
}

/* ------------------------------------------------------------ calendar */

const VERB = { create: 'Add and invite', update: 'Send update', remove: 'Cancel and notify' };
const DONE = { create: 'Added and invited', update: 'Update sent', remove: 'Cancelled, guests told' };
/** The calendar changes waiting for the person in one reply (guests are emailed only when they press the button). */
export function proposalsOf(m) {
  const by = new Map();
  for (const s of arr(m?.steps)) { const p = s && s.ok !== false && s.proposal; if (p && typeof p.proposal_id === 'string') by.set(p.proposal_id, p); }
  return [...by.values()];
}
/** One calendar proposal card: what, when, who, and the one button that does it. */
export function proposalCard(p) {
  const { row, busy, error } = proposalState(p.proposal_id);
  const expired = !row && p.expires_at && Date.parse(p.expires_at) < Date.now();
  const status = row?.status || (expired ? 'expired' : p.status || 'pending');
  const action = ['create', 'update', 'remove'].includes(p.action) ? p.action : 'create';
  const guests = arr(row?.guests ?? p.guests).filter((g) => typeof g === 'string');
  const stateText = status === 'done' ? DONE[action] : status === 'cancelled' ? 'Not done' : status === 'expired' ? 'Expired' : busy || status === 'working' ? 'Working…' : 'Waiting for you';
  return el('div', { class: `cx-mail cx-cal is-${status}`, dataset: { calProposal: p.proposal_id, state: status } },
    el('p', { class: 'cx-mail-head' }, icon('calendar', 14), el('span', { class: 'cx-mail-kind' }, action === 'remove' ? 'Cancel an event' : action === 'update' ? 'Change an event' : 'New event'),
      el('span', { class: 'cx-mail-state' }, stateText)),
    el('dl', { class: 'cx-mail-meta' },
      el('dt', {}, 'What'), el('dd', {}, String(row?.title || p.title || '(no title)')),
      el('dt', {}, 'When'), el('dd', {}, String(row?.when_text || p.when || '')),
      p.location ? [el('dt', {}, 'Where'), el('dd', {}, String(p.location))] : null,
      el('dt', {}, 'Guests'), el('dd', {}, guests.join(', ') || 'none')),
    status === 'pending' && !busy ? el('div', { class: 'cx-mail-acts' },
      el('button', { type: 'button', class: 'btn btn-primary btn-sm', dataset: { act: 'cal-confirm' }, onClick: () => confirmProposal(p.proposal_id) }, VERB[action]),
      el('span', { class: 'small muted' }, 'Google emails the guests.'),
      el('button', { type: 'button', class: 'link-btn cx-mail-discard', dataset: { act: 'cal-cancel' }, onClick: () => cancelProposal(p.proposal_id) }, 'Not now')) : null,
    error && status === 'pending' ? el('p', { class: 'cx-mail-err', role: 'alert' }, error) : null);
}
/** Event tiles for what the assistant looked at in the calendar (title, day and time, guests). */
export function eventTiles(m) {
  const evs = arr(m?.steps).filter((s) => s && s.tool === 'find_events' && Array.isArray(s.events)).flatMap((s) => s.events).slice(0, 6);
  if (!evs.length) return null;
  return el('ul', { class: 'cx-events', dataset: { events: '' } }, evs.map((e) => el('li', { class: 'cx-event', dataset: { event: String(e.id || '') } },
    icon('calendar', 13),
    el('span', { class: 'cx-event-main' }, el('span', { class: 'cx-event-title' }, String(e.title || '(no title)')),
      el('span', { class: 'cx-event-when' }, [String(e.when || ''), e.location ? String(e.location) : null].filter(Boolean).join(' · '))),
    arr(e.guests).length ? el('span', { class: 'cx-event-guests' }, arr(e.guests).slice(0, 3).join(', ') + (arr(e.guests).length > 3 ? ` +${arr(e.guests).length - 3}` : '')) : null)));
}

/** The email and calendar cards for one reply (null when it has none). `all` is every loaded message, to spot newer draft versions. */
export function emailCards(m, all = []) {
  const list = draftsOf(m);
  const props = proposalsOf(m);
  const tiles = eventTiles(m);
  if (!list.length && !props.length && !tiles) return null;
  mailBoot();
  return el('div', { class: 'cx-mails', dataset: { mails: '' } }, tiles,
    list.map((e) => emailCard(e, { stale: supersededIn(m, e.draft_id, all) })),
    props.map((p) => proposalCard(p)));
}
