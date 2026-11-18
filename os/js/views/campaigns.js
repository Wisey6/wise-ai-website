// Campaigns: send a reviewed batch of first texts, work the follow-ups that are due,
// edit the cold sequence, and see how each campaign is doing.
// Lead fields are untrusted: they only ever reach the page as text nodes or input values.
import {
  el, icon, go, badge, toast, modal, confirmDialog, field, input, select, textarea,
  emptyState, timeAgo, prettyPhone, copyText, busy, plural, money, num
} from '../ui.js?v=20261118e';
import {
  sb, state, saveTemplate, deleteTemplate, saveCampaign, sendSms, refreshSmsStatus,
  renderTemplate, leadName, saveLead, logEvent
} from '../api.js?v=20261118e';

/** append / replaceChildren that skip null and false children (native ones would print "null"). */
const keep = (c) => c.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false);
const add = (n, ...c) => { n.append(...keep(c)); return n; };
const put = (n, ...c) => { n.replaceChildren(...keep(c)); return n; };

/* ======================================================= shared helpers */

export const AU_MOBILE = /^\+614\d{8}$/;

const GSM_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXT = '^{}\\[~]|€\f';
const GSM_SET = new Set([...GSM_BASIC]);
const EXT_SET = new Set([...GSM_EXT]);

/**
 * SMS length maths. GSM-7 texts fit 160 characters in one segment (153 each when
 * split); anything outside GSM-7 (curly quotes, emoji) switches the whole text to
 * UCS-2: 70 per segment, 67 when split.
 */
export function smsSegments(text) {
  const s = String(text ?? '');
  const odd = [];
  let units = 0;
  for (const ch of s) {
    if (GSM_SET.has(ch)) units += 1;
    else if (EXT_SET.has(ch)) units += 2;
    else if (!odd.includes(ch)) odd.push(ch);
  }
  if (odd.length) {
    const len = s.length; // UTF-16 code units, as carriers count UCS-2
    const segments = len === 0 ? 0 : len <= 70 ? 1 : Math.ceil(len / 67);
    const per = segments > 1 ? 67 : 70;
    return { encoding: 'UCS-2', chars: len, segments, perSegment: per,
      remaining: segments ? segments * per - len : 70, unicode: odd };
  }
  const segments = units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153);
  const per = segments > 1 ? 153 : 160;
  return { encoding: 'GSM-7', chars: units, segments, perSegment: per,
    remaining: segments ? segments * per - units : 160, unicode: [] };
}

/** Small live counter element; call .update(text). */
export function segmentCounter() {
  const node = el('span', { class: 'camp-seg', 'aria-live': 'polite' });
  node.update = (text) => {
    const r = smsSegments(text);
    node.className = `camp-seg${r.segments > 2 ? ' is-bad' : r.segments > 1 || r.encoding === 'UCS-2' ? ' is-warn' : ''}`;
    let t = `${r.chars} chars · ${r.segments || 0} SMS`;
    if (r.encoding === 'UCS-2') t += ` · special characters (${r.unicode.slice(0, 4).join(' ')}) cut each SMS to 70`;
    node.textContent = t;
    node.title = r.encoding === 'UCS-2'
      ? 'Swap curly quotes, dashes and emoji for plain ones to get 160 characters per SMS.'
      : `${r.remaining} characters left in this SMS`;
  };
  return node;
}

/**
 * What the lead will actually receive. Same rules as sms-send: a lead who has
 * never replied gets the sender name (if missing) and the opt-out (if no STOP).
 */
export function finalBody(rendered, settings = {}, hasReplied = false) {
  // Same clean-up as the server's renderTemplate, so what is copied is what is recorded.
  let out = String(rendered ?? '').replace(/[ \t]{2,}/g, ' ').replace(/ +([,.?!])/g, '$1').replace(/[ \t]+\n/g, '\n').trim();
  if (hasReplied) return out;
  const sender = (settings.sender_name || '').trim();
  if (sender && !out.toLowerCase().includes(sender.toLowerCase())) out += ` - ${sender}`;
  if (!hasOptOut(out)) out += ` ${(settings.optout_text || '').trim() || 'Reply STOP to opt out'}`;
  return out;
}

/**
 * Does the text already carry an opt-out? Mirrors sms-send: an upper-case STOP word, or
 * "reply/text/txt/send/sms stop" in any case. (A plain case-insensitive "stop" would let
 * "stop losing jobs" skip the opt-out.)
 */
export function hasOptOut(text) {
  return /\bSTOP\b/.test(text) || /\b(reply|text|txt|send|sms)\s+stop\b/i.test(text);
}

export function suppressedSet() {
  return new Set((state.suppressions || []).map((s) => s.phone));
}

/** Why a lead cannot get a cold first text right now, or null if it can. */
export function coldBlocker(lead, { suppressed = suppressedSet(), requireHook = !!state.settings?.require_hook } = {}) {
  if (!lead || lead.archived) return 'archived';
  if (lead.status === 'dnc') return 'dnc';
  if (!['new', 'queued'].includes(lead.status)) return 'status';
  if (!lead.phone) return 'no_phone';
  if (suppressed.has(lead.phone)) return 'suppressed';
  if (!AU_MOBILE.test(lead.phone)) return 'not_au_mobile';
  if (['import', 'manual'].includes(lead.source) && !lead.last_reply_at && !(lead.number_source_url || '').trim()) return 'no_number_source';
  if (requireHook && !(lead.hook || '').trim()) return 'no_hook';
  return null;
}

export const ERRORS = {
  dnc: 'Marked do not contact',
  suppressed: 'Opted out',
  not_au_mobile: 'Not an Australian mobile',
  no_phone: 'No phone number',
  no_number_source: 'Number source missing',
  no_hook: 'Needs a personal line',
  outside_window: 'Outside the sending window',
  daily_cap: 'Daily cap reached',
  sms_not_configured: 'SMS sending is not set up yet',
  archived: 'Archived',
  status: 'Already contacted',
  unavailable: 'Could not reach the send service'
};
export const errText = (code) => ERRORS[code] || String(code || 'Failed').replace(/_/g, ' ');

function nextColdTemplate(afterStep) {
  return (state.templates || [])
    .filter((t) => t.active && t.step > afterStep && t.step < 90)
    .sort((a, b) => a.step - b.step)[0] || null;
}

/** Record a text the operator sent from their own phone, straight to the database. */
async function recordManual(lead, body, templateId) {
  const now = new Date();
  const { error } = await sb.from('messages').insert({
    lead_id: lead.id, direction: 'out', channel: 'sms', body, status: 'manual',
    template_id: templateId || null, sent_at: now.toISOString()
  });
  if (error) throw error;
  const patch = { last_contacted_at: now.toISOString() };
  if (['new', 'queued'].includes(lead.status)) patch.status = 'contacted';
  const tpl = (state.templates || []).find((t) => t.id === templateId);
  if (tpl && tpl.step < 90) {
    patch.sequence_step = tpl.step + 1;
    const next = nextColdTemplate(tpl.step);
    patch.next_followup_at = next ? new Date(now.getTime() + next.delay_days * 86400000).toISOString() : null;
  }
  await saveLead(lead.id, patch);
  try { await logEvent('sms_sent', lead.id, `Texted ${leadName(lead)} from phone`); } catch { /* event log is best effort */ }
}

/**
 * Send (or record as sent from the operator's phone) one message to one lead.
 * Resolves {ok, status?, error?, fatal?}. `fatal` means stop the whole batch.
 */
export async function deliver({ lead, body, templateId, mode = 'send' }) {
  let data = null;
  try {
    const payload = { lead_ids: [lead.id], body, mode };
    if (templateId) payload.template_id = templateId;
    data = await sendSms(payload);
    if (data && typeof data === 'object' && 'data' in data && 'status' in data && !data.results) data = data.data;
  } catch (err) {
    data = null;
  }
  const r = data?.results?.[0];
  if (r) return r.ok ? { ok: true, status: r.status || (mode === 'manual' ? 'manual' : 'sent') } : { ok: false, error: r.error };
  if (mode === 'manual') {
    // The send service is not reachable; record it directly so day one still works.
    try {
      await recordManual(lead, body, templateId);
      return { ok: true, status: 'manual' };
    } catch (err) {
      return { ok: false, error: err?.message || 'Could not record it' };
    }
  }
  const code = data?.error || 'unavailable';
  return { ok: false, error: code, fatal: ['sms_not_configured', 'outside_window', 'daily_cap', 'unavailable'].includes(code) || !data };
}

/** "9am–5pm Mon–Fri" */
export function windowLabel(s = {}) {
  const h = (n) => { const x = Number(n); if (x === 0 || x === 24) return '12am'; if (x === 12) return '12pm'; return x < 12 ? `${x}am` : `${x - 12}pm`; };
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const days = [...(s.send_days || [])].sort((a, b) => a - b);
  let d = days.map((x) => names[x - 1]).join(', ');
  const contiguous = days.length > 2 && days.every((x, i) => i === 0 || x === days[i - 1] + 1);
  if (contiguous) d = `${names[days[0] - 1]}–${names[days[days.length - 1] - 1]}`;
  return `${h(s.send_start_hour ?? 9)}–${h(s.send_end_hour ?? 17)} ${d}`;
}

/** Status strip: configured, sent today / cap, window. */
export function smsStrip() {
  const sms = state.sms;
  const s = state.settings || {};
  const wrap = el('div', { class: 'camp-strip row' });
  if (!sms) {
    wrap.append(badge('SMS service unavailable: send from your phone', 'warn'));
    return wrap;
  }
  wrap.append(
    sms.configured ? badge('SMS connected', 'ok') : badge('SMS not set up: send from your phone', 'warn'),
    badge(`${num(sms.sent_today || 0)} of ${num(sms.daily_cap ?? s.daily_cap ?? 0)} sent today`,
      (sms.sent_today || 0) >= (sms.daily_cap ?? s.daily_cap ?? 0) ? 'bad' : 'info'),
    sms.window_open ? badge('Sending window open', 'ok') : badge(`Window closed · ${windowLabel(s)}`, 'mute'));
  return wrap;
}

const SAMPLE = Object.freeze({
  id: 'sample', contact_name: 'Sam Nguyen', business: 'Northside Plumbing', suburb: 'Chermside',
  industry: 'plumbing', phone: '+61400000000', source: 'import', status: 'new',
  hook: 'Saw a few of your Google reviews mention it is hard to get through on the phone.',
  pain: 'missed calls while on the tools', est_monthly_value: 2400
});

/** Warnings about a message for one lead (personal, value-led, compliant). */
export function messageWarnings(templateBody, lead, finalText, { step = 0 } = {}) {
  const w = [];
  const tb = templateBody || '';
  if (step === 0 && /https?:\/\/|www\.|\{booking_url\}/i.test(finalText + tb)) w.push('No links in the first text. Send the booking link once they reply.');
  if (/!/.test(finalText)) w.push('Drop the exclamation marks.');
  if (/\{hook\}/.test(tb) && !(lead?.hook || '').trim()) w.push('No personal line for this lead, so {hook} is blank.');
  if (/\{value\}/.test(tb) && !(Number(lead?.est_monthly_value) > 0)) w.push('No $ estimate for this lead, so {value} is blank.');
  if (/\{pain\}/.test(tb) && !(lead?.pain || '').trim()) w.push('No pain noted for this lead, so {pain} is blank.');
  if (/\{[a-z_]+\}/i.test(finalText)) w.push('There is an unfilled {variable} in the text.');
  if (step === 0 && !/\{hook\}/.test(tb) && state.settings?.require_hook) w.push('This template has no {hook}, so it will read like every other cold text.');
  return w;
}

function warnList(list) {
  return list.length ? el('ul', { class: 'camp-warn' }, list.map((t) => el('li', {}, icon('alert', 13), el('span', {}, t)))) : null;
}

/* ============================================================ the view */

const TABS = [
  ['batch', 'Send batch', 'send'],
  ['followups', 'Follow-ups', 'clock'],
  ['sequence', 'Sequence', 'note'],
  ['campaigns', 'Campaigns', 'board']
];

let selectedCampaign = null;

function campaignList() {
  return (state.campaigns || []).slice().sort((a, b) => (b.active - a.active) || String(a.created_at).localeCompare(String(b.created_at)));
}
function currentCampaign() {
  const list = campaignList();
  if (!list.find((c) => c.id === selectedCampaign)) selectedCampaign = list.find((c) => c.active)?.id || list[0]?.id || null;
  return list.find((c) => c.id === selectedCampaign) || null;
}
function templatesFor(campaignId, pred) {
  return (state.templates || [])
    .filter((t) => (t.campaign_id === null || t.campaign_id === campaignId) && pred(t))
    .sort((a, b) => a.step - b.step || String(a.created_at).localeCompare(String(b.created_at)));
}

export default function campaigns(ctx = {}) {
  const tab = TABS.some(([id]) => id === ctx.param) ? ctx.param : 'batch';
  const body = el('div', { class: 'camp-body' });
  const root = el('div', { class: 'page camp' },
    el('header', { class: 'camp-head' },
      el('div', {}, el('div', { class: 'eyebrow' }, 'Outreach'), el('h1', { class: 'h1' }, 'Campaigns')),
      el('p', { class: 'camp-lede' }, 'One personal text at a time, sent in batches you have read first.')),
    el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Campaign sections' },
      TABS.map(([id, label]) => el('button', {
        class: `tab${id === tab ? ' is-active' : ''}`, role: 'tab', type: 'button',
        'aria-selected': id === tab ? 'true' : 'false',
        onClick: () => go(`#campaigns/${id}`)
      }, el('span', {}, label)))),
    body);

  let view;
  if (tab === 'batch') view = batchTab();
  else if (tab === 'followups') view = followupsTab();
  else if (tab === 'sequence') view = sequenceTab();
  else view = campaignsTab();
  body.append(view);
  root.onState = () => { if (view.onState) view.onState(); };
  return root;
}

/* ------------------------------------------------------------ campaign picker */

function campaignPicker(onChange) {
  const list = campaignList();
  const sel = select('campaign', list.map((c) => ({ id: c.id, label: c.active ? c.name : `${c.name} (paused)` })), selectedCampaign);
  sel.addEventListener('change', () => { selectedCampaign = sel.value; onChange(); });
  return field('Campaign', sel);
}

/* -------------------------------------------------------------------- batch */

function batchTab() {
  const wrap = el('div', { class: 'stack' });
  const setup = el('section', { class: 'section camp-sec camp-setup' });
  const review = el('div', { class: 'camp-review-slot' });
  wrap.append(setup, review);
  let count = null;
  let templateId = null;
  let includeUnassigned = true;
  let reviewing = false;

  function pool() {
    const c = currentCampaign();
    return (state.leads || []).filter((l) => !l.archived && ['new', 'queued'].includes(l.status)
      && (l.campaign_id === c?.id || (includeUnassigned && !l.campaign_id)));
  }

  function renderSetup() {
    const c = currentCampaign();
    setup.replaceChildren();
    if (!c) {
      setup.append(emptyState({ icon: 'board', title: 'No campaign yet', text: 'Create a campaign first.',
        action: el('button', { class: 'btn btn-primary btn-sm', type: 'button', onClick: () => go('#campaigns/campaigns') }, 'Go to campaigns') }));
      return;
    }
    const firsts = templatesFor(c.id, (t) => t.step === 0 && t.active);
    if (!firsts.find((t) => t.id === templateId)) templateId = firsts[0]?.id || null;
    const sup = suppressedSet();
    const requireHook = !!state.settings?.require_hook;
    const all = pool();
    const reasons = {};
    const eligible = [];
    for (const l of all) {
      const r = coldBlocker(l, { suppressed: sup, requireHook });
      if (r) reasons[r] = (reasons[r] || 0) + 1; else eligible.push(l);
    }
    eligible.sort((a, b) => (Number(b.est_monthly_value) || 0) - (Number(a.est_monthly_value) || 0)
      || String(a.created_at).localeCompare(String(b.created_at)));
    const sms = state.sms;
    const capLeft = sms ? Math.max(0, (sms.daily_cap ?? 0) - (sms.sent_today ?? 0)) : (state.settings?.daily_cap ?? 0);
    const suggested = Math.min(eligible.length, sms?.configured ? capLeft : eligible.length, 10);
    if (count === null || count > eligible.length) count = suggested;

    const tplSel = select('template', firsts.map((t) => ({ id: t.id, label: t.name })), templateId);
    tplSel.addEventListener('change', () => { templateId = tplSel.value; });
    const countIn = input('count', { type: 'number', min: 1, max: Math.max(1, eligible.length), value: count, inputmode: 'numeric' });
    countIn.addEventListener('input', () => { count = Math.max(0, Math.min(eligible.length, Number(countIn.value) || 0)); });
    const unassigned = (state.leads || []).filter((l) => !l.archived && !l.campaign_id && ['new', 'queued'].includes(l.status)).length;
    const unassignedBox = el('label', { class: 'camp-check' },
      el('input', { type: 'checkbox', class: 'check', checked: includeUnassigned || null,
        onChange: (e) => { includeUnassigned = e.target.checked; count = null; renderSetup(); } }),
      el('span', {}, `Include leads with no campaign (${unassigned})`));

    const needHook = reasons.no_hook || 0;
    const other = Object.entries(reasons).filter(([k]) => k !== 'no_hook');

    add(setup,
      el('div', { class: 'section-head' },
        el('div', { class: 'stack' }, el('div', { class: 'eyebrow' }, 'First texts'), el('h2', { class: 'h2' }, 'Send a batch')),
        smsStrip()),
      el('div', { class: 'camp-setup-grid' },
        campaignPicker(() => { count = null; renderSetup(); }),
        firsts.length ? field('First text', tplSel) : field('First text', el('div', { class: 'muted' }, 'No active step 0 template')),
        field('How many', countIn, sms?.configured ? `${capLeft} left in today’s cap` : null)),
      unassigned ? unassignedBox : null,
      el('div', { class: 'camp-elig' },
        el('div', { class: 'camp-elig-main' },
          el('span', { class: 'camp-elig-num' }, num(eligible.length)),
          el('span', { class: 'camp-elig-label' }, eligible.length === 1 ? 'lead ready for a first text' : 'leads ready for a first text')),
        needHook ? el('button', { class: 'link-btn camp-hook-link', type: 'button', onClick: () => go('#leads/needs-hook') },
          el('span', { class: 'dot', 'aria-hidden': 'true' }), `${plural(needHook, 'lead')} waiting on a personal line. Write them`) : null,
        other.length ? el('p', { class: 'muted camp-elig-skip' },
          'Not eligible: ', other.map(([k, n]) => `${errText(k)}: ${n}`).join(' · ')) : null),
      el('div', { class: 'row camp-setup-go' },
        el('button', {
          class: 'btn btn-primary', type: 'button', disabled: !eligible.length || !templateId || null,
          onClick: () => {
            const n = Math.max(1, Math.min(eligible.length, Number(countIn.value) || count || 1));
            reviewing = true;
            const tpl = (state.templates || []).find((t) => t.id === templateId);
            review.replaceChildren(reviewFlow({
              leads: eligible.slice(0, n), template: tpl, campaign: c, kind: 'first',
              onClose: () => { reviewing = false; review.replaceChildren(); count = null; renderSetup(); }
            }));
            review.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
          }
        }, icon('edit', 16), 'Review messages'),
        !templateId ? el('span', { class: 'muted' }, 'Add a step 0 template under Sequence first.') : null)
    );
  }
  renderSetup();
  wrap.onState = () => {
    // Keep focus and typing in the review list; only refresh the setup card when idle.
    if (reviewing && review.firstChild?.onState) review.firstChild.onState();
    const a = document.activeElement;
    if (setup.contains(a) && a.matches('input, select, textarea')) return;
    renderSetup();
  };
  return wrap;
}

/* --------------------------------------------------------------- review flow */

/**
 * Per-lead review of rendered messages, each editable, then send them all or step
 * through them one by one from the operator's phone.
 */
function reviewFlow({ leads, template, campaign, kind, onClose }) {
  const settings = state.settings || {};
  const items = leads.map((lead) => {
    const rendered = finalBody(renderTemplate(template?.body || '', lead, settings), settings, !!lead.last_reply_at);
    return { lead, original: rendered, text: rendered, include: true, result: null };
  });
  const root = el('section', { class: 'section camp-sec camp-review' });
  const list = el('ol', { class: 'camp-msgs' });
  const foot = el('div', { class: 'camp-review-foot' });
  let mode = 'review';

  function itemNode(it) {
    const l = it.lead;
    const ta = el('textarea', { class: 'input camp-msg-text', rows: 5, 'aria-label': `Message to ${leadName(l)}` });
    ta.value = it.text;
    const counter = segmentCounter();
    counter.update(it.text);
    const warnSlot = el('div');
    const setWarn = () => warnSlot.replaceChildren(warnList(messageWarnings(template?.body, l, it.text, { step: template?.step ?? 0 })) || '');
    setWarn();
    ta.addEventListener('input', () => { it.text = ta.value; counter.update(ta.value); setWarn(); updateFoot(); });
    const inc = el('input', { type: 'checkbox', class: 'check', checked: it.include || null, 'aria-label': `Include ${leadName(l)}` });
    inc.addEventListener('change', () => { it.include = inc.checked; node.classList.toggle('is-off', !inc.checked); updateFoot(); });
    const resultSlot = el('span', { class: 'camp-msg-result' });
    it.setResult = (r) => {
      it.result = r;
      resultSlot.replaceChildren(r.ok ? badge(r.status === 'manual' ? 'Sent from phone' : 'Sent', 'ok') : badge(errText(r.error), 'bad'));
      if (r.ok) { ta.readOnly = true; inc.disabled = true; }
    };
    const meta = [l.suburb, l.industry].filter(Boolean).join(' · ');
    const node = el('li', { class: 'camp-msg' }, el('div', { class: 'camp-msg-body' },
      el('div', { class: 'camp-msg-head' },
        el('label', { class: 'camp-msg-who' }, inc,
          el('span', {}, el('strong', {}, leadName(l)),
            el('span', { class: 'camp-msg-meta' }, [meta, prettyPhone(l.phone)].filter(Boolean).join(' · ')))),
        Number(l.est_monthly_value) > 0 ? el('span', { class: 'camp-msg-value' }, `${money(l.est_monthly_value)}/mo`) : null,
        resultSlot),
      (l.hook || l.pain) ? el('dl', { class: 'camp-msg-ctx' },
        l.hook ? el('div', {}, el('dt', { class: 'camp-msg-k' }, 'Your line'), el('dd', {}, l.hook)) : null,
        l.pain ? el('div', {}, el('dt', { class: 'camp-msg-k' }, 'Pain'), el('dd', {}, l.pain)) : null) : null,
      ta,
      el('div', { class: 'camp-msg-foot' }, counter,
        el('button', { class: 'link-btn camp-reset', type: 'button', onClick: () => { ta.value = it.original; ta.dispatchEvent(new Event('input')); } }, 'Reset to template')),
      warnSlot));
    return node;
  }

  const chosen = () => items.filter((it) => it.include && !it.result?.ok);

  function updateFoot() {
    if (mode !== 'review') return;
    const n = chosen().length;
    const sms = state.sms;
    const canSend = sms?.configured && sms.window_open;
    const sendBtn = el('button', { class: `btn ${canSend ? 'btn-primary' : 'btn-ghost'}`, type: 'button', disabled: !n || !canSend || null,
      onClick: (e) => busy(e.currentTarget, sendAll) }, icon('send', 16), `Send ${n} now`);
    const phoneBtn = el('button', { class: `btn ${canSend ? 'btn-ghost' : 'btn-primary'}`, type: 'button', disabled: !n || null,
      onClick: () => startManual() }, icon('phone', 16), `Send ${n} from my phone`);
    put(foot,
      el('div', { class: 'muted camp-review-note' },
        !sms || !sms.configured ? 'SMS sending is not connected, so send these from your phone. Each one is recorded when you tap Sent.'
            : !sms.window_open ? `Outside the sending window (${windowLabel(state.settings)}). You can still send from your phone if it suits.`
              : 'Each message goes exactly as written above.'),
      el('div', { class: 'row' },
        el('button', { class: 'btn btn-ghost', type: 'button', onClick: onClose }, 'Close'),
        el('span', { class: 'spacer' }), phoneBtn, sendBtn));
  }

  async function afterSent(it) {
    if (campaign && !it.lead.campaign_id) {
      try { await saveLead(it.lead.id, { campaign_id: campaign.id }); } catch { /* not critical */ }
    }
  }

  async function sendAll() {
    const todo = chosen();
    let sent = 0;
    let failed = 0;
    for (const it of todo) {
      const r = await deliver({ lead: it.lead, body: it.text.trim(), templateId: template?.id, mode: 'send' });
      it.setResult(r);
      if (r.ok) { sent++; await afterSent(it); } else failed++;
      if (r.fatal) { toast(`${errText(r.error)}. Stopped after ${sent} sent.`, 'bad'); break; }
    }
    refreshSmsStatus().catch(() => {});
    if (sent) toast(`${plural(sent, 'text')} sent${failed ? `, ${failed} not sent` : ''}`, failed ? 'warn' : 'ok');
    else if (failed) toast(`Nothing sent: ${failed} failed`, 'bad');
    updateFoot();
  }

  function startManual() {
    mode = 'manual';
    const queue = chosen();
    let i = 0;
    let sent = 0;
    list.hidden = true;
    const stage = el('div', { class: 'camp-step' });
    foot.replaceChildren(stage);

    const show = () => {
      if (i >= queue.length) {
        stage.replaceChildren(el('div', { class: 'camp-step-done' },
          el('div', { class: 'camp-step-icon' }, icon('check', 28)),
          el('h3', { class: 'h2' }, sent ? `${plural(sent, 'text')} recorded` : 'Nothing recorded'),
          el('p', { class: 'muted' }, 'Replies land in the Inbox. Follow-ups are scheduled from today.'),
          el('div', { class: 'row' },
            el('button', { class: 'btn btn-ghost', type: 'button', onClick: () => go('#inbox') }, 'Open inbox'),
            el('button', { class: 'btn btn-primary', type: 'button', onClick: onClose }, 'Done'))));
        return;
      }
      const it = queue[i];
      const l = it.lead;
      const ta = el('textarea', { class: 'input camp-msg-text', rows: 6, 'aria-label': `Message to ${leadName(l)}` });
      ta.value = it.text;
      const counter = segmentCounter();
      counter.update(it.text);
      ta.addEventListener('input', () => { it.text = ta.value; counter.update(ta.value); smsLink.href = smsHref(); });
      const smsHref = () => `sms:${l.phone}?&body=${encodeURIComponent(it.text.trim())}`;
      const smsLink = el('a', { class: 'btn btn-ghost', href: smsHref() }, icon('message', 16), 'Open in Messages');
      const markBtn = el('button', { class: 'btn btn-primary', type: 'button' }, icon('check', 16), 'Sent, next');
      markBtn.addEventListener('click', () => busy(markBtn, async () => {
        const r = await deliver({ lead: l, body: it.text.trim(), templateId: template?.id, mode: 'manual' });
        it.setResult(r);
        if (!r.ok) { toast(`Not recorded: ${errText(r.error)}`, 'bad'); return; }
        sent++;
        await afterSent(it);
        toast(`Recorded text to ${leadName(l)}`);
        i++; show();
      }));
      put(stage,
        el('div', { class: 'camp-step-head' },
          el('span', { class: 'eyebrow' }, `${i + 1} of ${queue.length}`),
          el('div', { class: 'camp-step-bar', 'aria-hidden': 'true' },
            el('span', { style: { width: `${(i / queue.length) * 100}%` } }))),
        el('div', { class: 'camp-step-who' },
          el('strong', {}, leadName(l)),
          el('a', { class: 'camp-step-phone', href: `tel:${l.phone}` }, icon('phone', 14), prettyPhone(l.phone))),
        l.hook ? el('p', { class: 'muted camp-step-hook' }, l.hook) : null,
        ta,
        el('div', { class: 'camp-msg-foot' }, counter),
        el('ol', { class: 'camp-step-how muted' },
          el('li', {}, 'Copy the message, or open it in Messages on your phone.'),
          el('li', {}, 'Send it to the number above.'),
          el('li', {}, 'Tap “Sent, next” so it is recorded and the follow-up is scheduled.')),
        el('div', { class: 'row camp-step-actions' },
          el('button', { class: 'btn btn-ghost', type: 'button', onClick: () => copyText(it.text.trim(), 'Message copied') }, icon('copy', 16), 'Copy'),
          smsLink,
          el('span', { class: 'spacer' }),
          el('button', { class: 'btn btn-ghost', type: 'button', onClick: () => { i++; show(); } }, 'Skip'),
          markBtn));
      ta.focus({ preventScroll: true });
    };
    show();
  }

  list.append(...items.map(itemNode));
  add(root,
    el('div', { class: 'section-head' },
      el('div', { class: 'stack' },
        el('div', { class: 'eyebrow' }, kind === 'first' ? `Review · ${template?.name || ''}` : `Review follow-ups · ${template?.name || ''}`),
        el('h2', { class: 'h2' }, `Read ${items.length === 1 ? 'this message' : `these ${items.length} messages`} before they go`)),
      el('p', { class: 'muted camp-review-tip' }, 'Read each one as the owner would. Make it about their business.')),
    list, foot);
  updateFoot();
  root.onState = () => updateFoot();
  return root;
}

/* ---------------------------------------------------------------- follow-ups */

export function followupsDue(now = Date.now()) {
  const sup = suppressedSet();
  return (state.leads || []).filter((l) => !l.archived && l.status === 'contacted' && !l.last_reply_at
    && l.next_followup_at && Date.parse(l.next_followup_at) <= now && l.phone && !sup.has(l.phone));
}

function followupsTab() {
  const wrap = el('div', { class: 'stack' });
  const slot = el('div', { class: 'stack' });
  const reviewSlot = el('div');
  let reviewing = false;

  function render() {
    const due = followupsDue();
    slot.replaceChildren();
    slot.append(el('section', { class: 'section camp-sec' },
      el('div', { class: 'section-head' },
        el('div', { class: 'stack' }, el('div', { class: 'eyebrow' }, 'Due now'), el('h2', { class: 'h2' }, 'Follow-ups')),
        smsStrip()),
      el('p', { class: 'camp-intro' }, 'Leads who had a text, have not replied, and whose next step is due. Each follow-up should add something new, not just “bumping this”.')));
    if (!due.length) {
      slot.append(emptyState({ icon: 'check', title: 'Nothing due', text: 'Follow-ups appear here on the day they are due.' }));
      return;
    }
    const groups = new Map();
    for (const l of due) {
      const k = l.sequence_step || 0;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(l);
    }
    for (const [step, leads] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
      const tpl = (state.templates || []).filter((t) => t.active && t.step === step)
        .sort((a, b) => (a.campaign_id ? 0 : 1) - (b.campaign_id ? 0 : 1))[0];
      leads.sort((a, b) => Date.parse(a.next_followup_at) - Date.parse(b.next_followup_at));
      const skip = async (ls, btn) => {
        if (ls.length > 1 && !(await confirmDialog('Skip these follow-ups?', `${plural(ls.length, 'lead')} will get no more automatic follow-ups. They stay in your leads.`, { confirmLabel: 'Skip', danger: false }))) return;
        await busy(btn, async () => {
          try {
            for (const l of ls) await saveLead(l.id, { next_followup_at: null });
            toast(`Skipped ${plural(ls.length, 'follow-up')}`);
          } catch (err) { toast(`Could not skip: ${err?.message || err}`, 'bad'); }
        });
      };
      slot.append(el('section', { class: 'section camp-sec camp-fu' },
        el('div', { class: 'section-head' },
          el('div', { class: 'stack' },
            el('div', { class: 'eyebrow' }, `Step ${step}`),
            el('h3', { class: 'h2' }, tpl ? tpl.name : 'No template for this step')),
          el('span', { class: 'camp-fu-count' }, `${leads.length} due`)),
        tpl ? el('p', { class: 'camp-fu-body' }, tpl.body) : el('p', { class: 'muted' }, `There is no active template with step ${step}. Add one under Sequence, or skip these.`),
        el('ul', { class: 'camp-fu-list' }, leads.map((l) => el('li', {},
          el('a', { href: `#leads/${l.id}` }, leadName(l)),
          el('span', { class: 'camp-fu-due' }, `due ${timeAgo(l.next_followup_at)}`),
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': `Skip follow-up for ${leadName(l)}`, onClick: (e) => skip([l], e.currentTarget) }, 'Skip')))),
        el('div', { class: 'row camp-fu-go' },
          tpl ? el('button', { class: 'btn btn-primary', type: 'button', onClick: () => {
            reviewing = true;
            reviewSlot.replaceChildren(reviewFlow({ leads, template: tpl, campaign: null, kind: 'followup',
              onClose: () => { reviewing = false; reviewSlot.replaceChildren(); render(); } }));
            reviewSlot.scrollIntoView({ block: 'start' });
          } }, icon('edit', 16), `Review & send ${leads.length}`) : null,
          el('button', { class: 'btn btn-ghost', type: 'button', onClick: (e) => skip(leads, e.currentTarget) }, 'Skip all'))));
    }
  }
  render();
  wrap.append(slot, reviewSlot);
  wrap.onState = () => {
    if (reviewing) { reviewSlot.firstChild?.onState?.(); return; }
    render();
  };
  return wrap;
}

/* ------------------------------------------------------------------ sequence */

const VARS = ['first_name', 'business', 'hook', 'pain', 'value', 'suburb', 'industry', 'sender', 'booking_url'];

function sequenceTab() {
  const wrap = el('div', { class: 'stack' });
  function render() {
    const c = currentCampaign();
    wrap.replaceChildren();
    const sender = state.settings?.sender_name || '';
    const cold = templatesFor(c?.id, (t) => t.step < 90);
    const quick = templatesFor(c?.id, (t) => t.step >= 90);
    add(wrap,
      el('section', { class: 'section camp-sec' },
        el('div', { class: 'section-head' },
          el('div', { class: 'stack' }, el('div', { class: 'eyebrow' }, 'Cold sequence'), el('h2', { class: 'h2' }, 'Templates')),
          el('button', { class: 'btn btn-primary btn-sm', type: 'button', onClick: () => addTemplate(false) }, icon('plus', 15), 'Add step')),
        el('div', { class: 'camp-seq-intro' },
          c ? el('div', { class: 'camp-seq-pick' }, campaignPicker(render)) : null,
          el('p', { class: 'camp-intro' },
            'Step 0 is the first text; each later step goes the set number of days after the one before, only if they have not replied. ',
            `Cold texts get “ - ${sender || 'sender name'}” added if the sender name is missing, and the opt-out if there is no STOP. The preview shows exactly what goes.`)),
        !sender ? el('p', { class: 'camp-warn-line' }, el('span', { class: 'dot', 'aria-hidden': 'true' }), 'No sender name is set. Add it in Settings so every text says who it is from.') : null),
      ...cold.map((t) => templateCard(t, render)),
      cold.length ? null : emptyState({ icon: 'note', title: 'No sequence yet', text: 'Add a step 0 first text.' }),
      el('section', { class: 'section camp-sec camp-seq-quick' },
        el('div', { class: 'section-head' },
          el('div', { class: 'stack' }, el('div', { class: 'eyebrow' }, 'Inbox'), el('h2', { class: 'h2' }, 'Quick replies')),
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => addTemplate(true) }, icon('plus', 15), 'Add quick reply')),
        el('p', { class: 'camp-intro' }, 'One-tap replies in the Inbox for people who have already replied. Steps 90 and up.')),
      ...quick.map((t) => templateCard(t, render)));
  }

  async function addTemplate(isQuick) {
    const c = currentCampaign();
    const steps = (state.templates || []).filter((t) => (isQuick ? t.step >= 90 : t.step < 90)).map((t) => t.step);
    const nextStep = isQuick ? Math.max(89, ...steps) + 1 : (steps.length ? Math.max(...steps) + 1 : 0);
    const res = await modal({
      title: isQuick ? 'New quick reply' : 'New sequence step',
      body: [
        field('Name', input('name', { required: true, value: isQuick ? 'Reply: ' : `Follow-up ${nextStep}` })),
        el('div', { class: 'grid cols-2' },
          field('Step', input('step', { type: 'number', min: isQuick ? 90 : 0, value: nextStep, required: true })),
          isQuick ? input('delay_days', { type: 'hidden', value: 0 }) : field('Days after previous', input('delay_days', { type: 'number', min: 0, value: 3 }))),
        c ? field('Applies to', select('scope', [{ id: 'all', label: 'All campaigns' }, { id: c.id, label: `Only ${c.name}` }], 'all')) : null,
        field('Message', textarea('body', '', 'Hi {first_name}, …'), 'Variables: {first_name} {business} {hook} {pain} {value} {suburb} {industry} {sender} {booking_url}')
      ],
      confirmLabel: 'Add'
    });
    if (!res) return;
    try {
      await saveTemplate({
        name: String(res.name).trim(), step: Number(res.step) || 0, delay_days: Number(res.delay_days) || 0,
        body: String(res.body || '').trim() || 'Hi {first_name}, ', active: true,
        campaign_id: res.scope && res.scope !== 'all' ? res.scope : null
      });
      toast('Template added');
      render();
    } catch (err) { toast(`Could not add: ${err?.message || err}`, 'bad'); }
  }

  render();
  wrap.onState = () => {
    // Re-render only when nothing is being edited.
    if (wrap.querySelector('.camp-tpl.is-dirty') || wrap.contains(document.activeElement)) return;
    render();
  };
  return wrap;
}

function templateCard(t, rerender) {
  const settings = state.settings || {};
  const c = currentCampaign();
  const isQuick = t.step >= 90;
  const samples = [SAMPLE, ...(state.leads || []).filter((l) => !l.archived && (l.hook || '').trim()).slice(0, 20)];
  let sample = SAMPLE;

  const name = input('name', { value: t.name, 'aria-label': 'Template name' });
  const step = input('step', { type: 'number', min: 0, value: t.step });
  const delay = input('delay_days', { type: 'number', min: 0, value: t.delay_days });
  const active = el('input', { type: 'checkbox', class: 'check', checked: t.active || null });
  const body = el('textarea', { class: 'input camp-tpl-body', rows: 4, 'aria-label': `${t.name} message` });
  body.value = t.body;
  const preview = el('div', { class: 'camp-bubble' });
  const counter = segmentCounter();
  const warnSlot = el('div');
  const sampleSel = select('sample', samples.map((l, i) => ({ id: String(i), label: i === 0 ? 'Sample: Northside Plumbing' : leadName(l) })), '0');
  sampleSel.addEventListener('change', () => { sample = samples[Number(sampleSel.value)] || SAMPLE; update(); });

  const card = el('section', { class: `card camp-tpl${t.active ? '' : ' is-paused'}` });
  const saveBtn = el('button', { class: 'btn btn-primary btn-sm', type: 'button', disabled: true }, 'Save');

  function update() {
    const text = finalBody(renderTemplate(body.value, sample, settings), settings, isQuick);
    preview.textContent = text;
    counter.update(text);
    const w = messageWarnings(body.value, sample, text, { step: Number(step.value) });
    if (!isQuick && settings.sender_name && !body.value.includes('{sender}') && !body.value.toLowerCase().includes(String(settings.sender_name).toLowerCase())) {
      w.push(`Sender name not in the text, so “ - ${settings.sender_name}” is added at the end.`);
    }
    warnSlot.replaceChildren(warnList(w) || '');
  }
  function dirty() {
    const d = name.value !== t.name || Number(step.value) !== t.step || Number(delay.value) !== t.delay_days
      || active.checked !== !!t.active || body.value !== t.body;
    card.classList.toggle('is-dirty', d);
    saveBtn.disabled = !d;
  }
  for (const n of [name, step, delay, body]) n.addEventListener('input', () => { update(); dirty(); });
  active.addEventListener('change', dirty);

  const insertVar = (v) => {
    const s = body.selectionStart ?? body.value.length;
    const e = body.selectionEnd ?? s;
    body.setRangeText(`{${v}}`, s, e, 'end');
    body.focus();
    body.dispatchEvent(new Event('input'));
  };

  saveBtn.addEventListener('click', () => busy(saveBtn, async () => {
    if (!body.value.trim()) { toast('The message cannot be empty', 'bad'); return; }
    try {
      await saveTemplate({ ...t, name: name.value.trim() || t.name, step: Number(step.value) || 0,
        delay_days: Number(delay.value) || 0, active: active.checked, body: body.value.trim() });
      toast('Template saved');
      card.classList.remove('is-dirty');
      rerender();
    } catch (err) { toast(`Could not save: ${err?.message || err}`, 'bad'); }
  }));
  const delBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': `Delete ${t.name}` }, icon('trash', 15));
  delBtn.addEventListener('click', async () => {
    if (!(await confirmDialog('Delete template?', `“${t.name}” will be removed. Messages already sent keep their text.`))) return;
    await busy(delBtn, async () => {
      try { await deleteTemplate(t.id); toast('Template deleted'); rerender(); } catch (err) { toast(`Could not delete: ${err?.message || err}`, 'bad'); }
    });
  });

  add(card,
    el('div', { class: 'camp-tpl-head' },
      el('span', { class: `camp-tpl-step${isQuick ? ' is-quick' : ''}` }, isQuick ? 'Reply' : String(t.step).padStart(2, '0')),
      name,
      el('span', { class: 'camp-tpl-scope' }, t.campaign_id ? (c && t.campaign_id === c.id ? 'This campaign' : 'One campaign') : 'All campaigns'),
      el('span', { class: 'spacer' }),
      el('label', { class: 'camp-check' }, active, el('span', {}, 'Active'))),
    el('div', { class: 'camp-tpl-grid' },
      el('div', { class: 'stack camp-tpl-edit' },
        isQuick ? null : el('div', { class: 'row' },
          field('Step', step),
          t.step === 0 ? null : field('Days after previous', delay)),
        body,
        el('div', { class: 'camp-vars', role: 'group', 'aria-label': 'Insert a variable' },
          VARS.map((v) => el('button', { class: 'camp-var', type: 'button', onClick: () => insertVar(v) }, `{${v}}`)))),
      el('div', { class: 'stack camp-tpl-preview' },
        el('div', { class: 'row camp-tpl-prevhead' }, el('span', { class: 'eyebrow' }, 'Preview'), sampleSel),
        preview,
        counter,
        warnSlot)),
    el('div', { class: 'row camp-tpl-actions' }, delBtn, el('span', { class: 'spacer' }), saveBtn));
  update();
  return card;
}

/* ----------------------------------------------------------------- campaigns */

let statsCache = null;

async function loadStats() {
  const { data, error } = await sb.from('messages')
    .select('lead_id,direction,channel,status')
    .eq('channel', 'sms')
    .limit(10000);
  if (error) throw error;
  statsCache = data || [];
  return statsCache;
}

export function campaignStats(campaignId, leads, messages, bookings) {
  const ls = leads.filter((l) => (campaignId === null ? !l.campaign_id : l.campaign_id === campaignId));
  const ids = new Set(ls.map((l) => l.id));
  const msgs = messages.filter((m) => ids.has(m.lead_id));
  const out = msgs.filter((m) => m.direction === 'out');
  const texted = new Set(out.filter((m) => m.status !== 'failed').map((m) => m.lead_id));
  const replied = new Set(msgs.filter((m) => m.direction === 'in').map((m) => m.lead_id));
  for (const l of ls) if (l.last_reply_at) replied.add(l.id);
  const booked = new Set(ls.filter((l) => ['booked', 'won'].includes(l.status)).map((l) => l.id));
  for (const b of bookings) if (b.lead_id && ids.has(b.lead_id) && b.status !== 'cancelled') booked.add(b.lead_id);
  return {
    leads: ls.length,
    sent: out.filter((m) => ['sent', 'delivered', 'manual', 'queued'].includes(m.status)).length,
    delivered: out.filter((m) => m.status === 'delivered').length,
    manual: out.filter((m) => m.status === 'manual').length,
    failed: out.filter((m) => m.status === 'failed').length,
    texted: texted.size,
    replies: replied.size,
    replyRate: texted.size ? replied.size / texted.size : null,
    interested: ls.filter((l) => ['interested', 'booked', 'won'].includes(l.status)).length,
    booked: booked.size,
    won: ls.filter((l) => l.status === 'won').length
  };
}

function campaignsTab() {
  const wrap = el('div', { class: 'stack' });
  function render() {
    wrap.replaceChildren(
      el('div', { class: 'section-head camp-cards-head' },
        el('div', { class: 'stack' }, el('div', { class: 'eyebrow' }, 'Results'), el('h2', { class: 'h2' }, 'Campaign stats'),
          el('p', { class: 'muted' }, 'Group leads by niche or area so you can compare what works.')),
        el('button', { class: 'btn btn-primary btn-sm', type: 'button', onClick: () => edit(null) }, icon('plus', 15), 'New campaign')));
    const list = campaignList();
    if (!list.length) {
      wrap.append(emptyState({ icon: 'board', title: 'No campaigns', text: 'Create one for your first niche.' }));
      return;
    }
    const msgs = statsCache || [];
    const rows = list.map((c) => ({ c, s: campaignStats(c.id, state.leads || [], msgs, state.bookings || []) }));
    const un = campaignStats(null, state.leads || [], msgs, state.bookings || []);
    if (un.leads) rows.push({ c: { id: null, name: 'No campaign', active: true, description: 'Leads not assigned to a campaign.' }, s: un });
    wrap.append(el('div', { class: 'camp-cards' }, rows.map(({ c, s }) => el('section', { class: `camp-card${c.active ? '' : ' is-paused'}` },
      el('div', { class: 'camp-card-head' },
        el('div', { class: 'stack tight' },
          el('h2', { class: 'h2' }, c.name),
          c.description ? el('p', { class: 'muted camp-desc' }, c.description) : null),
        c.id ? el('div', { class: 'row' },
          c.active ? badge('Active', 'ok') : badge('Paused', 'mute'),
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': `Edit ${c.name}`, onClick: () => edit(c) }, icon('edit', 15))) : null),
      el('dl', { class: 'camp-stats' },
        stat('Leads', num(s.leads)),
        stat('Texts sent', num(s.sent), s.manual ? `${num(s.manual)} from phone` : null),
        stat('Delivered', num(s.delivered), s.failed ? `${num(s.failed)} failed` : null),
        stat('Replied', num(s.replies), s.texted ? `of ${num(s.texted)} texted` : null),
        stat('Reply rate', s.replyRate === null ? '—' : `${Math.round(s.replyRate * 1000) / 10}%`),
        stat('Interested', num(s.interested)),
        stat('Booked', num(s.booked)),
        stat('Won', num(s.won)))))));
    if (!statsCache) wrap.append(el('p', { class: 'muted' }, 'Loading message counts…'));
  }
  const stat = (k, v, sub) => el('div', { class: 'camp-stat' }, el('dt', {}, k), el('dd', {}, v), sub ? el('span', { class: 'muted camp-stat-sub' }, sub) : null);

  async function edit(c) {
    const res = await modal({
      title: c ? 'Edit campaign' : 'New campaign',
      body: [
        field('Name', input('name', { required: true, value: c?.name || '', placeholder: 'e.g. Northside plumbers' })),
        field('Description', textarea('description', c?.description || '', 'Who, where, and the one problem you solve for them')),
        el('label', { class: 'camp-check' }, el('input', { type: 'checkbox', class: 'check', name: 'active', value: '1', checked: c ? c.active || null : true }), el('span', {}, 'Active'))
      ],
      confirmLabel: c ? 'Save' : 'Create'
    });
    if (!res) return;
    try {
      const row = { name: String(res.name).trim(), description: String(res.description || '').trim() || null, active: res.active === '1' };
      if (c) row.id = c.id;
      const saved = await saveCampaign(row);
      if (!c && saved?.id) selectedCampaign = saved.id;
      toast(c ? 'Campaign saved' : 'Campaign created');
      render();
    } catch (err) { toast(`Could not save: ${err?.message || err}`, 'bad'); }
  }

  render();
  loadStats().then(render).catch(() => { statsCache = []; render(); toast('Could not load message counts', 'bad'); });
  wrap.onState = () => { if (!wrap.contains(document.activeElement) || document.activeElement === document.body) render(); };
  return wrap;
}
