// Email draft cards in the assistant's conversation (command bar and Agents page). A draft the
// assistant wrote shows To / Cc / Subject and the text, with Send (the only way an email leaves
// the hub, pressed by the person), Edit in Gmail and Discard. The card's state comes from the
// person's own mail_drafts rows, so it is right after a reload. Text nodes only, never HTML.
import { el, icon, timeOnly } from './ui.js?v=20261118e';
import { state } from './api.js?v=20261118e';
import {
  draftState, discardDraft, gmailDraftLink, loadMailDrafts, mailConnected, mailStamp, onMailChange, refreshMailStatus, sendDraft
} from './mail-api.js?v=20261118e';

export { mailConnected, mailStamp, onMailChange };

/** The example ask added to an empty conversation when the person's email is connected. */
export const MAIL_EXAMPLE = 'Any replies in my email today that need an answer?';
const COLLAPSE_LINES = 10;
const arr = (v) => (Array.isArray(v) ? v : []);
const expanded = new Set();

let booted = false;
/** Ask once (after sign-in) for the connection and the person's drafts. */
export function mailBoot() {
  if (booted || !state.me) return;
  booted = true;
  refreshMailStatus();
  loadMailDrafts();
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

  const head = el('p', { class: 'cx-mail-head' }, icon('mail', 14),
    el('span', { class: 'cx-mail-kind' }, e.is_reply ? 'Reply draft' : 'Email draft'),
    el('span', { class: 'cx-mail-state', dataset: { mailState: status } },
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
  const card = el('div', { class: `cx-mail is-${status}${busy ? ' is-busy' : ''}`, dataset: { mailDraft: e.draft_id, state: status } },
    head, meta, text, more, acts,
    error && status === 'draft' ? el('p', { class: 'cx-mail-err', role: 'alert' }, error) : null);
  return card;
}

/** The cards for one reply (null when it has none). `all` is every loaded message, to spot newer versions. */
export function emailCards(m, all = []) {
  const list = draftsOf(m);
  if (!list.length) return null;
  mailBoot();
  return el('div', { class: 'cx-mails', dataset: { mails: '' } }, list.map((e) => emailCard(e, { stale: supersededIn(m, e.draft_id, all) })));
}
