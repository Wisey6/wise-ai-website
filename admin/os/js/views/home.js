// Today: what happened, what is coming up, and what to do next.
import { el, icon, statusBadge, timeAgo, timeOnly, dayLabel, dayKey, money, num, plural, prettyPhone } from '../ui.js';
import { isAuMobile, leadName, leadById, isSuppressed, formatValue } from '../api.js';

const DAY = 86400000;
const seenEvents = new Set();
let firstPaint = true;

const isActive = (l) => !l.archived;
const isFresh = (l) => l.status === 'new' || l.status === 'queued';

function greeting() {
  const h = Number(new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', hour: 'numeric', hour12: false }));
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function lastInbound(state, leadId) {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m.lead_id === leadId && m.direction === 'in') return m;
  }
  return null;
}

/** Eligible for a cold first text right now (mirrors the sms-send checks we can see). */
export function eligibleForFirstText(l, settings) {
  return isActive(l) && isFresh(l) && isAuMobile(l.phone) && !isSuppressed(l.phone)
    && (l.source === 'import' || l.source === 'manual' ? Boolean(l.number_source_url) : true)
    && (!settings?.require_hook || Boolean((l.hook || '').trim()));
}

/* ------------------------------------------------------------- Do next */
function computeDoNext(state) {
  const items = [];
  const now = Date.now();
  const leads = state.leads.filter(isActive);
  const s = state.settings || {};
  const today = dayKey();

  // 1. Replies waiting: the money is in the conversations.
  const unread = leads.filter((l) => l.unread).sort((a, b) => String(b.last_reply_at).localeCompare(String(a.last_reply_at)));
  unread.slice(0, 3).forEach((l) => {
    const m = lastInbound(state, l.id);
    items.push({
      key: `reply-${l.id}`, icon: 'message', tone: 'rose',
      title: `Reply to ${leadName(l)}`,
      sub: m ? `“${m.body.slice(0, 120)}” · ${timeAgo(m.created_at)}` : `Replied ${timeAgo(l.last_reply_at)}`,
      href: `#inbox/${l.id}`, cta: 'Reply'
    });
  });
  if (unread.length > 3) {
    items.push({ key: 'reply-more', icon: 'inbox', tone: 'rose', title: `${unread.length - 3} more replies waiting`, sub: 'Oldest first is fine; fast is better', href: '#inbox', cta: 'Open inbox' });
  }

  // 2. Calls today.
  state.bookings
    .filter((b) => b.status === 'booked' && b.starts_at && dayKey(b.starts_at) === today && Date.parse(b.ends_at || b.starts_at) > now - 30 * 60000)
    .forEach((b) => {
      const lead = b.lead_id ? leadById(b.lead_id) : null;
      const who = lead ? leadName(lead) : (b.attendee_name || 'a booking');
      items.push({
        key: `call-${b.id}`, icon: 'phone', tone: 'teal',
        title: `Call with ${who} at ${timeOnly(b.starts_at)}`,
        sub: lead?.hook ? `Your note: ${lead.hook}` : (b.title || 'Prep: read the thread and their numbers first'),
        href: lead ? `#leads/${lead.id}` : '#bookings', cta: 'Prep',
        extra: b.meeting_url && /^https?:\/\//i.test(b.meeting_url) ? { href: b.meeting_url, label: 'Join', icon: 'external', external: true } : null
      });
    });

  // 3. New website leads not yet contacted: speed to lead.
  leads
    .filter((l) => l.source === 'website' && !l.last_contacted_at && ['new', 'interested', 'queued'].includes(l.status) && now - Date.parse(l.created_at) < 14 * DAY)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 3)
    .forEach((l) => {
      items.push({
        key: `web-${l.id}`, icon: 'globe', tone: 'blue',
        title: `Call ${leadName(l)} back`,
        sub: `Website enquiry ${timeAgo(l.created_at)}${l.phone ? ` · ${prettyPhone(l.phone)}` : ''}`,
        href: `#leads/${l.id}`, cta: 'Open',
        extra: l.phone ? { href: `tel:${l.phone}`, label: 'Call', icon: 'phone' } : null
      });
    });

  // 4. Calls that happened but have no outcome yet.
  state.bookings
    .filter((b) => b.status === 'booked' && b.lead_id && Date.parse(b.ends_at || b.starts_at) < now && now - Date.parse(b.starts_at) < 10 * DAY)
    .forEach((b) => {
      const lead = leadById(b.lead_id);
      if (!lead || lead.status !== 'booked') return;
      items.push({
        key: `outcome-${b.id}`, icon: 'check', tone: 'violet',
        title: `How did the call with ${leadName(lead)} go?`,
        sub: `${dayLabel(b.starts_at)} ${timeOnly(b.starts_at)} · mark it won, lost or follow up`,
        href: '#bookings', cta: 'Record'
      });
    });

  // 5. Interested but not booked: nudge.
  leads
    .filter((l) => l.status === 'interested' && !l.unread && l.last_reply_at && now - Date.parse(l.last_reply_at) > 2 * DAY)
    .slice(0, 3)
    .forEach((l) => {
      items.push({
        key: `nudge-${l.id}`, icon: 'calendar', tone: 'amber',
        title: `Nudge ${leadName(l)} to book a call`,
        sub: `Interested, last heard from ${timeAgo(l.last_reply_at)}${l.est_monthly_value ? ` · worth about ${formatValue(l.est_monthly_value)}/mo to them` : ''}`,
        href: `#inbox/${l.id}`, cta: 'Send link'
      });
    });

  // 6. Follow-ups due.
  const due = leads.filter((l) => l.next_followup_at && Date.parse(l.next_followup_at) <= now && !l.last_reply_at && !['dnc', 'lost', 'won', 'booked'].includes(l.status));
  if (due.length) {
    items.push({ key: 'followups', icon: 'clock', tone: 'amber', title: `Send ${plural(due.length, 'follow-up')} that ${due.length === 1 ? 'is' : 'are'} due`, sub: 'No reply yet to the last text', href: '#campaigns/followups', cta: 'Review' });
  }

  // 7. Ready for a first text.
  const ready = leads.filter((l) => eligibleForFirstText(l, s));
  if (ready.length) {
    const sms = state.sms;
    const left = sms ? Math.max(0, (sms.daily_cap || 0) - (sms.sent_today || 0)) : null;
    const sub = sms
      ? (sms.configured
        ? `${left} left in today's cap · window ${sms.window_open ? 'open now' : `opens ${s.send_start_hour ?? 9}:00`}`
        : 'Send from your phone in manual mode, or connect Twilio')
      : 'Each one carries a personal line';
    items.push({ key: 'send', icon: 'send', tone: 'up', title: `Send first texts: ${num(ready.length)} ready`, sub, href: '#campaigns/send', cta: 'Send batch' });
  }

  // 8. Leads waiting on a personal line (no generic blasts).
  if (s.require_hook !== false) {
    const noHook = leads.filter((l) => isFresh(l) && !(l.hook || '').trim() && isAuMobile(l.phone) && !isSuppressed(l.phone));
    if (noHook.length) {
      items.push({ key: 'hooks', icon: 'edit', tone: 'violet', title: `${plural(noHook.length, 'lead')} need${noHook.length === 1 ? 's' : ''} a personal line`, sub: 'One specific thing you noticed about each business', href: '#leads/needs-hook', cta: 'Write' });
    }
  }

  // 9. Missing number source (compliance evidence).
  const noSource = leads.filter((l) => isFresh(l) && (l.source === 'import' || l.source === 'manual') && !l.number_source_url && !l.last_reply_at);
  if (noSource.length) {
    items.push({ key: 'source', icon: 'link', tone: 'amber', title: `${plural(noSource.length, 'lead')} missing a number source`, sub: 'Note where each number is publicly listed before texting', href: '#leads/no-source', cta: 'Fix' });
  }

  // 10. Setup gaps.
  if (!state.leads.length) {
    items.push({ key: 'import', icon: 'upload', tone: 'blue', title: 'Import your first leads', sub: 'A CSV from a directory or spreadsheet; we keep AU mobiles and flag the rest', href: '#leads/import', cta: 'Import' });
    items.push({ key: 'add', icon: 'plus', tone: '', title: 'Or add one lead by hand', sub: 'Someone you already know could use a hand', href: '#leads/new', cta: 'Add' });
  }
  if (state.sms && state.sms.configured === false) {
    items.push({ key: 'twilio', icon: 'zap', tone: '', title: 'Connect Twilio to send from here', sub: 'Until then, texts go from your phone in manual mode', href: '#settings', cta: 'Set up' });
  }
  if (!s.booking_url) {
    items.push({ key: 'booking', icon: 'calendar', tone: '', title: 'Add your booking link', sub: 'Used by {booking_url} and the one-click "send booking link"', href: '#settings', cta: 'Add' });
  }
  return items;
}

function doNextCard(state) {
  const items = computeDoNext(state);
  const list = el('ul', { class: 'do-list' }, items.slice(0, 9).map((it) => el('li', { class: 'do-item' },
    el('div', { class: 'row nowrap', style: 'gap:6px' },
      el('a', { class: 'do-link', href: it.href, style: 'flex:1;min-width:0', dataset: { key: it.key } },
        el('span', { class: `do-icon${it.tone ? ` t-${it.tone}` : ''}` }, icon(it.icon, 17)),
        el('span', { style: 'min-width:0' },
          el('span', { class: 'do-title', style: 'display:block' }, it.title),
          it.sub ? el('span', { class: 'do-sub', style: 'display:block' }, it.sub) : null),
        el('span', { class: 'do-meta' }, el('span', { class: 'do-cta' }, it.cta), el('span', { class: 'do-go' }, icon('chevron', 16)))),
      it.extra ? el('a', {
        class: 'btn btn-ghost btn-sm', href: it.extra.href, 'aria-label': `${it.extra.label}: ${it.title}`,
        target: it.extra.external ? '_blank' : null, rel: it.extra.external ? 'noopener noreferrer' : null
      }, icon(it.extra.icon, 14), it.extra.label) : null))));

  return el('section', { class: 'card', 'aria-labelledby': 'do-next-h' },
    el('div', { class: 'card-head' },
      el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, 'Do next'), el('h2', { class: 'h2', id: 'do-next-h' }, items.length ? `${plural(items.length, 'thing')} worth your time` : 'Nothing urgent')),
      items.length > 9 ? el('span', { class: 'muted small' }, `+${items.length - 9} more`) : null),
    items.length ? list : el('div', { class: 'all-clear' },
      el('span', { class: 'do-icon t-up' }, icon('check', 17)),
      el('span', {}, 'All caught up. A good time to write a few personal lines or review the playbook.')));
}

/* ------------------------------------------------------------- funnel */
function funnel(state) {
  const now = Date.now();
  const wk = (iso) => iso && now - Date.parse(iso) < 7 * DAY;
  const leads = state.leads.filter(isActive);
  const contacted = leads.filter((l) => l.last_contacted_at || !['new', 'queued'].includes(l.status));
  const replied = leads.filter((l) => l.last_reply_at);
  const interested = leads.filter((l) => ['interested', 'booked', 'won'].includes(l.status));
  const bookings = state.bookings.filter((b) => b.status !== 'cancelled');
  const won = leads.filter((l) => l.status === 'won');
  const contactedWk = leads.filter((l) => wk(l.last_contacted_at)).length;
  const repliedWk = leads.filter((l) => wk(l.last_reply_at)).length;
  const rate = contacted.length ? Math.round((replied.length / contacted.length) * 100) : null;
  const rateWk = contactedWk ? Math.round((repliedWk / contactedWk) * 100) : null;
  const total = Math.max(1, leads.length);
  const wonValue = won.reduce((sum, l) => sum + (Number(l.est_monthly_value) || 0), 0);

  const steps = [
    { label: 'Leads', value: num(leads.length), sub: `+${leads.filter((l) => wk(l.created_at)).length} this week`, share: leads.length / total, href: '#leads' },
    { label: 'Contacted', value: num(contacted.length), sub: `${contactedWk} this week`, share: contacted.length / total, href: '#leads' },
    { label: 'Reply rate', value: rate === null ? '–' : `${rate}%`, sub: rateWk === null ? `${replied.length} replied` : `${rateWk}% this week`, share: replied.length / total, href: '#inbox' },
    { label: 'Interested', value: num(interested.length), sub: `${interested.filter((l) => wk(l.updated_at)).length} moved this week`, share: interested.length / total, href: '#leads' },
    { label: 'Booked', value: num(bookings.length), sub: `${bookings.filter((b) => wk(b.created_at)).length} this week`, share: bookings.length / total, href: '#bookings' },
    { label: 'Won', value: num(won.length), sub: wonValue ? `${money(wonValue)}/mo value` : `${won.filter((l) => wk(l.updated_at)).length} this week`, share: won.length / total, href: '#leads' }
  ];
  return el('section', { class: 'funnel', 'aria-label': 'Funnel: all time, with this week' },
    steps.map((s) => el('a', { class: 'funnel-step', href: s.href },
      el('span', { class: 'kpi-label' }, s.label),
      el('span', { class: 'kpi-value' }, s.value),
      el('span', { class: 'kpi-sub' }, s.sub),
      el('span', { class: 'funnel-bar', 'aria-hidden': 'true' }, el('span', { style: `width:${Math.max(2, Math.round(s.share * 100))}%` })))));
}

/* -------------------------------------------------------------- spark */
const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  kids.forEach((k) => n.append(k));
  return n;
}

function sparkCard(state) {
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(dayKey(new Date(Date.now() - i * DAY)));
  const idx = Object.fromEntries(days.map((d, i) => [d, i]));
  const series = { sent: Array(14).fill(0), replies: Array(14).fill(0), bookings: Array(14).fill(0) };
  for (const m of state.messages) {
    if (m.channel !== 'sms') continue;
    const i = idx[dayKey(m.created_at)];
    if (i === undefined) continue;
    if (m.direction === 'out' && m.status !== 'failed') series.sent[i]++;
    if (m.direction === 'in') series.replies[i]++;
  }
  for (const b of state.bookings) {
    const i = idx[dayKey(b.created_at)];
    if (i !== undefined && b.status !== 'cancelled') series.bookings[i]++;
  }
  const W = 560; const H = 150; const P = { l: 26, r: 8, t: 10, b: 22 };
  const max = Math.max(4, ...series.sent, ...series.replies, ...series.bookings);
  const x = (i) => P.l + (i * (W - P.l - P.r)) / 13;
  const y = (v) => H - P.b - (v / max) * (H - P.t - P.b);
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'spark', role: 'img', 'aria-label': `Last 14 days: ${series.sent.reduce((a, b) => a + b, 0)} texts sent, ${series.replies.reduce((a, b) => a + b, 0)} replies, ${series.bookings.reduce((a, b) => a + b, 0)} bookings` });
  for (const f of [0, 0.5, 1]) {
    const v = Math.round(max * f);
    chart.append(svg('line', { x1: P.l, x2: W - P.r, y1: y(v), y2: y(v), class: 'grid-line' }));
    const t = svg('text', { x: P.l - 6, y: y(v) + 3, 'text-anchor': 'end', class: 'axis' }); t.textContent = String(v); chart.append(t);
  }
  [0, 7, 13].forEach((i) => {
    const t = svg('text', { x: x(i), y: H - 5, 'text-anchor': i === 0 ? 'start' : i === 13 ? 'end' : 'middle', class: 'axis' });
    t.textContent = i === 13 ? 'Today' : new Date(`${days[i]}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
    chart.append(t);
  });
  const colours = { sent: 'var(--ink)', replies: 'var(--blue)', bookings: 'var(--teal)' };
  // Area under "sent" for weight, then the lines.
  const pts = (arr) => arr.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  chart.append(svg('polygon', { points: `${x(0)},${y(0)} ${pts(series.sent)} ${x(13)},${y(0)}`, fill: 'rgba(10,14,17,.05)' }));
  for (const k of ['sent', 'replies', 'bookings']) {
    chart.append(svg('polyline', { points: pts(series[k]), fill: 'none', stroke: colours[k], 'stroke-width': k === 'sent' ? 2 : 1.75, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    const last = series[k][13];
    chart.append(svg('circle', { cx: x(13), cy: y(last), r: 3, fill: colours[k] }));
  }
  const sum = (a) => a.reduce((p, c) => p + c, 0);
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, 'Last 14 days'), el('h2', { class: 'h2' }, 'Texts, replies and bookings')),
      el('div', { class: 'legend' },
        el('span', {}, el('i', { style: 'background:var(--ink)' }), `Sent ${sum(series.sent)}`),
        el('span', {}, el('i', { style: 'background:var(--blue)' }), `Replies ${sum(series.replies)}`),
        el('span', {}, el('i', { style: 'background:var(--teal)' }), `Bookings ${sum(series.bookings)}`))),
    chart);
}

/* ------------------------------------------------------------ calls */
function callsCard(state) {
  const now = Date.now();
  const upcoming = state.bookings.filter((b) => b.status === 'booked' && b.starts_at && Date.parse(b.ends_at || b.starts_at) > now).slice(0, 4);
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, 'Upcoming calls'), el('h2', { class: 'h2' }, upcoming.length ? plural(upcoming.length, 'call') : 'No calls booked')),
      el('a', { class: 'btn btn-ghost btn-sm', href: '#bookings' }, 'All bookings')),
    upcoming.length
      ? el('ul', { class: 'call-list' }, upcoming.map((b) => {
        const lead = b.lead_id ? leadById(b.lead_id) : null;
        return el('li', { class: 'call-item' },
          el('div', { class: 'call-when' }, el('b', {}, timeOnly(b.starts_at).replace(/\s?[ap]m/i, '')), el('span', {}, /pm/i.test(timeOnly(b.starts_at)) ? 'pm' : 'am')),
          el('div', { style: 'min-width:0' },
            el('a', { href: lead ? `#leads/${lead.id}` : '#bookings', class: 'do-title truncate', style: 'display:block;color:var(--ink)' }, lead ? leadName(lead) : (b.attendee_name || 'Booking')),
            el('span', { class: 'do-sub', style: 'display:block' }, `${dayLabel(b.starts_at)} · ${b.title || 'Discovery call'}`)),
          b.meeting_url && /^https?:\/\//i.test(b.meeting_url)
            ? el('a', { class: 'icon-btn', href: b.meeting_url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Join call' }, icon('external', 16))
            : null);
      }))
      : el('p', { class: 'muted small' }, state.settings?.booking_url ? 'When someone books through your link it lands here, and on Today.' : 'Add your booking link in Settings so people can book a call.'));
}

/* ------------------------------------------------------------ feed */
const EVENT_TONE = { sms_reply: 'var(--blue)', sms_sent: 'var(--ink)', booking: 'var(--teal)', booking_cancelled: 'var(--amber)', website_lead: 'var(--violet)', opt_out: 'var(--rose)', dnc: 'var(--rose)', import: 'var(--up)' };

function feedCard(state) {
  const events = state.events.slice(0, 12);
  const list = el('ul', { class: 'feed' }, events.map((e) => {
    const isNew = !firstPaint && !seenEvents.has(e.id);
    seenEvents.add(e.id);
    const lead = e.lead_id ? leadById(e.lead_id) : null;
    return el('li', { class: isNew ? 'is-new' : '' },
      el('span', { class: 'dot', style: `background:${EVENT_TONE[e.kind] || 'var(--faint)'}` }),
      lead ? el('a', { href: `#leads/${lead.id}`, class: 'truncate', style: 'display:block' }, e.summary) : el('span', { class: 'truncate' }, e.summary),
      el('span', { class: 'when' }, timeAgo(e.at)));
  }));
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, 'Live activity'), el('h2', { class: 'h2' }, 'What just happened'))),
    events.length ? list : el('p', { class: 'muted small' }, 'Texts, replies, bookings and website enquiries appear here the moment they happen.'));
}

/* ------------------------------------------------------------ hero */
function smsStrip(state) {
  const s = state.sms;
  if (!s) {
    return el('div', { class: 'sms-strip' }, el('span', { class: 'item' }, el('span', { class: `dot${state.smsChecked ? ' warn' : ''}` }),
      state.smsChecked ? 'SMS status unavailable right now' : 'Checking SMS…'));
  }
  return el('div', { class: 'sms-strip', 'aria-label': 'SMS status' },
    el('span', { class: 'item' }, el('span', { class: `dot ${s.configured ? 'ok' : 'warn'}` }), s.configured ? 'SMS connected' : el('a', { href: '#settings' }, 'SMS not connected')),
    el('span', { class: 'item' }, el('span', { class: `dot ${s.sent_today >= s.daily_cap ? 'bad' : 'ok'}` }), `${num(s.sent_today)} / ${num(s.daily_cap)} sent today`),
    el('span', { class: 'item' }, el('span', { class: `dot ${s.window_open ? 'ok' : 'warn'}` }), s.window_open ? 'Sending window open' : 'Sending window closed'));
}

function hero(state) {
  const unread = state.leads.filter((l) => l.unread && !l.archived).length;
  const today = dayKey();
  const callsToday = state.bookings.filter((b) => b.status === 'booked' && b.starts_at && dayKey(b.starts_at) === today).length;
  const bits = [];
  if (unread) bits.push(`${plural(unread, 'reply', 'replies')} waiting`);
  if (callsToday) bits.push(`${plural(callsToday, 'call')} today`);
  const lede = state.leads.length
    ? (bits.length ? `${bits.join(' and ')}.` : 'Quiet so far. A good day to write personal lines and send a careful batch.')
    : 'An empty pipeline is a clean slate. Start by importing a list or adding someone you already know.';
  const date = new Date().toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane', weekday: 'long', day: 'numeric', month: 'long' });
  return el('section', { class: 'home-hero' },
    el('div', {},
      el('p', { class: 'eyebrow' }, date),
      el('h1', { class: 'h1' }, `${greeting()}, Tyler`),
      el('p', { class: 'lede' }, lede),
      el('div', { style: 'margin-top:14px' }, smsStrip(state))),
    el('div', { class: 'row' },
      el('a', { class: 'btn btn-ghost', href: '#leads/import' }, icon('upload', 16), 'Import'),
      el('a', { class: 'btn btn-primary', href: '#leads/new' }, icon('plus', 16), 'Add lead')));
}

/* ------------------------------------------------------------ pipeline */
function pipelineCard(state) {
  const leads = state.leads.filter(isActive);
  const hot = leads.filter((l) => ['replied', 'interested', 'booked'].includes(l.status))
    .sort((a, b) => (Number(b.est_monthly_value) || 0) - (Number(a.est_monthly_value) || 0) || String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, 5);
  if (!hot.length) return null;
  const total = hot.reduce((s, l) => s + (Number(l.est_monthly_value) || 0), 0);
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, 'Warm conversations'), el('h2', { class: 'h2' }, total ? `${money(total)}/mo on the table` : 'People who replied')),
      el('a', { class: 'btn btn-ghost btn-sm', href: '#leads' }, 'Pipeline')),
    el('ul', { class: 'call-list' }, hot.map((l) => el('li', {},
      el('a', { class: 'do-link', href: `#leads/${l.id}`, style: 'margin:0;grid-template-columns:minmax(0,1fr) auto auto' },
        el('span', { style: 'min-width:0' }, el('span', { class: 'do-title truncate', style: 'display:block' }, leadName(l)), el('span', { class: 'do-sub', style: 'display:block' }, l.pain || l.hook || l.suburb || '')),
        l.est_monthly_value ? el('span', { class: 'small', style: 'font-weight:600;color:var(--teal-t)' }, `${formatValue(l.est_monthly_value)}/mo`) : el('span'),
        statusBadge(l.status))))));
}

export default function home(ctx) {
  const { state } = ctx;
  const node = el('div', { class: 'page' },
    hero(state),
    funnel(state),
    el('div', { class: 'home-cols' },
      el('div', { class: 'stack loose' }, doNextCard(state), sparkCard(state)),
      el('div', { class: 'stack loose' }, callsCard(state), pipelineCard(state), feedCard(state))));
  firstPaint = false;
  return node;
}
