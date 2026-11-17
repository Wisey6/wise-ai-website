// Today: what happened, what is coming up, and what to do next.
import { el, icon, statusBadge, timeAgo, timeOnly, dayLabel, dayKey, money, num, plural, prettyPhone } from '../ui.js?v=20261118c';
import { isAuMobile, leadName, leadById, isSuppressed, formatValue } from '../api.js?v=20261118c';

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

/* Rendering follows the approved layout: A's greeting strip, D's compact KPI
   strip, A's numbered Do next, A's calls and warm conversations, D's 14-day
   chart and live feed. Computations above are unchanged. */

function doNextCard(state) {
  const items = computeDoNext(state);
  const shown = items.slice(0, 9);
  const unread = state.leads.filter((l) => l.unread && !l.archived).length;
  const list = el('ol', { class: 'do-list' }, shown.map((it, i) => el('li', { class: `do-item${i === 0 ? ' is-first' : ''}`, dataset: { key: it.key } },
    el('span', { class: 'do-n', 'aria-hidden': 'true' }, String(i + 1).padStart(2, '0')),
    el('span', { class: 'do-text' },
      el('span', { class: 'do-title' }, it.title),
      it.sub ? el('span', { class: 'do-sub' }, it.sub) : null),
    el('span', { class: 'do-acts' },
      it.extra ? el('a', {
        class: 'act act-extra', href: it.extra.href, 'aria-label': `${it.extra.label}: ${it.title}`,
        target: it.extra.external ? '_blank' : null, rel: it.extra.external ? 'noopener noreferrer' : null
      }, icon(it.extra.icon, 14), it.extra.label) : null,
      el('a', { class: `act do-link${i === 0 ? ' is-primary' : ''}`, href: it.href, 'aria-label': `${it.cta}: ${it.title}`, dataset: { key: it.key } }, it.cta)))));

  return el('section', { class: 'card today-card do-card', 'aria-labelledby': 'do-next-h' },
    el('div', { class: 'card-head' },
      el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, 'Do next'),
        el('h2', { class: 'h2', id: 'do-next-h' }, items.length ? `${plural(items.length, 'thing')} worth your time, in order` : 'Nothing urgent')),
      items.length > 9 ? el('span', { class: 'muted small' }, `+${items.length - 9} more`)
        : unread ? el('a', { class: 'card-link', href: '#inbox' }, 'Open inbox', icon('arrow', 14)) : null),
    items.length ? list : el('div', { class: 'all-clear' },
      el('span', { class: 'all-clear-mark', 'aria-hidden': 'true' }, icon('check', 18)),
      el('span', {}, 'All caught up. A good time to write a few personal lines or review the playbook.')));
}

/* ----------------------------------------------------------- KPI strip */
function kpiStrip(state) {
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
  const wonValue = won.reduce((sum, l) => sum + (Number(l.est_monthly_value) || 0), 0);
  const newWk = leads.filter((l) => wk(l.created_at)).length;

  const steps = [
    { label: 'Leads', value: num(leads.length), sub: `+${newWk} this week`, up: newWk > 0, href: '#leads' },
    { label: 'Contacted', value: num(contacted.length), sub: `${contactedWk} this week`, href: '#leads' },
    { label: 'Reply rate', value: rate === null ? '–' : `${rate}%`, sub: rateWk === null ? `${replied.length} replied` : `${rateWk}% this week`, href: '#inbox' },
    { label: 'Interested', value: num(interested.length), sub: `${interested.filter((l) => wk(l.updated_at)).length} moved this week`, href: '#leads' },
    { label: 'Booked', value: num(bookings.length), sub: `${bookings.filter((b) => wk(b.created_at)).length} this week`, href: '#bookings' },
    { label: 'Won', value: num(won.length), sub: wonValue ? `${money(wonValue)}/mo` : `${won.filter((l) => wk(l.updated_at)).length} this week`, href: '#leads' }
  ];
  return el('section', { class: 'kpi-strip funnel', 'aria-label': 'Funnel: all time, with this week' },
    steps.map((s) => el('a', { class: 'kpi-cell funnel-step', href: s.href },
      el('span', { class: 'kpi-label' }, s.label),
      el('span', { class: 'kpi-line' },
        el('span', { class: 'kpi-value' }, s.value),
        el('span', { class: `kpi-sub${s.up ? ' is-up' : ''}` }, s.sub)))));
}

/* -------------------------------------------------------------- chart */
const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  kids.forEach((k) => n.append(k));
  return n;
}
const shortDate = (key) => new Date(`${key}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });

function chartCard(state) {
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
  const sum = (a) => a.reduce((p, c) => p + c, 0);
  const W = 336; const top = 12; const base = 98; const h = base - top;
  const peak = Math.max(4, ...series.sent, ...series.replies);
  const max = peak <= 10 ? Math.ceil(peak / 2) * 2 : Math.ceil(peak / 10) * 10;
  const slot = W / 14;
  const yv = (v) => base - (v / max) * h;
  let busiest = 0;
  series.sent.forEach((v, i) => { if (v > series.sent[busiest]) busiest = i; });
  const chart = svg('svg', { viewBox: `0 0 ${W} ${base + 2}`, class: 'bars', 'aria-hidden': 'true', preserveAspectRatio: 'none' });
  [0.5, 1].forEach((f) => chart.append(svg('line', { x1: 0, x2: W, y1: yv(max * f), y2: yv(max * f), class: 'grid-line' })));
  for (let i = 0; i < 14; i++) {
    const x = i * slot + 3.5; const bw = slot - 7;
    const v = series.sent[i]; const r = series.replies[i];
    const th = v ? Math.max((v / max) * h, 2) : 0;
    if (v) chart.append(svg('rect', { x, y: base - th, width: bw, height: th, rx: 2.5, class: i === 13 ? 'b-sent is-today' : 'b-sent' }));
    else chart.append(svg('rect', { x, y: base - 1.5, width: bw, height: 1.5, rx: 0.75, class: 'b-zero' }));
    if (r) { const rh = Math.max((r / max) * h, 2); chart.append(svg('rect', { x: x + 3, y: base - rh, width: Math.max(bw - 6, 2), height: rh, rx: 2, class: 'b-reply' })); }
    if (series.bookings[i]) chart.append(svg('circle', { cx: x + bw / 2, cy: Math.max(5, base - Math.max(th, r ? (r / max) * h : 0) - 8), r: 3.5, class: 'b-book' }));
  }
  chart.append(svg('line', { x1: 0, x2: W, y1: base, y2: base, class: 'axis-line' }));
  const label = `Last 14 days: ${sum(series.sent)} texts sent, ${sum(series.replies)} replies, ${sum(series.bookings)} bookings.`
    + (series.sent[busiest] ? ` Busiest day ${shortDate(days[busiest])} with ${series.sent[busiest]} texts.` : '');
  const lg = (cls, text, value) => el('div', { class: 'lg' }, el('span', { class: 'lg-k' }, el('i', { class: cls }), text), el('span', { class: 'lg-v' }, num(value)));
  return el('section', { class: 'card today-card chart-card', 'aria-labelledby': 'chart-h' },
    el('div', { class: 'card-head' },
      el('div', { class: 'stack' }, el('p', { class: 'eyebrow', id: 'chart-h' }, 'Last 14 days')),
      el('span', { class: 'muted small' }, `${shortDate(days[0])} to ${shortDate(days[13])}`)),
    el('div', { class: 'legend' },
      lg('k-sent', 'Texts sent', sum(series.sent)),
      lg('k-reply', 'Replies', sum(series.replies)),
      lg('k-book', 'Bookings', sum(series.bookings))),
    el('div', { class: 'chart', role: 'img', 'aria-label': label }, chart),
    el('div', { class: 'chart-axis', 'aria-hidden': 'true' },
      el('span', {}, shortDate(days[0])), el('span', {}, shortDate(days[7])), el('span', { class: 'is-today' }, 'Today')));
}

/* ------------------------------------------------------------ calls */
function callsCard(state) {
  const now = Date.now();
  const upcoming = state.bookings.filter((b) => b.status === 'booked' && b.starts_at && Date.parse(b.ends_at || b.starts_at) > now).slice(0, 4);
  const counts = { Today: 0, Tomorrow: 0, later: 0 };
  for (const b of state.bookings.filter((x) => x.status === 'booked' && x.starts_at && Date.parse(x.ends_at || x.starts_at) > now)) {
    const d = dayLabel(b.starts_at);
    if (d === 'Today' || d === 'Tomorrow') counts[d]++; else counts.later++;
  }
  const parts = [];
  if (counts.Today) parts.push(`${counts.Today} today`);
  if (counts.Tomorrow) parts.push(`${counts.Tomorrow} tomorrow`);
  if (counts.later) parts.push(`${counts.later} later`);
  const title = parts.length ? (parts.length === 1 && counts.later ? plural(counts.later, 'call') : parts.join(', ')) : 'No calls booked';
  return el('section', { class: 'card today-card', 'aria-labelledby': 'calls-h' },
    el('div', { class: 'card-head' },
      el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, 'Upcoming calls'), el('h2', { class: 'h2', id: 'calls-h' }, title)),
      el('a', { class: 'card-link', href: '#bookings' }, 'All bookings', icon('arrow', 14))),
    upcoming.length
      ? el('ul', { class: 'calls call-list' }, upcoming.map((b, i) => {
        const lead = b.lead_id ? leadById(b.lead_id) : null;
        const who = lead ? leadName(lead) : (b.attendee_name || 'Booking');
        const t = timeOnly(b.starts_at);
        const day = dayLabel(b.starts_at);
        const join = b.meeting_url && /^https?:\/\//i.test(b.meeting_url);
        return el('li', { class: `call call-item${i === 0 ? ' is-next' : ''}${day !== 'Today' && i > 0 ? ' is-later' : ''}` },
          el('div', { class: 'call-when' }, el('b', {}, t.replace(/\s?[ap]m/i, '')), el('span', {}, /pm/i.test(t) ? 'pm' : 'am')),
          el('div', { class: 'call-body' },
            el('a', { href: lead ? `#leads/${lead.id}` : '#bookings', class: 'call-nm' }, who),
            el('span', { class: 'call-mt' }, `${day} · ${b.title || 'Discovery call'}${i === 0 ? ' · next up' : ''}`)),
          join
            ? el('a', { class: 'mini-btn', href: b.meeting_url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Join call with ${who}` }, icon('video', 15))
            : el('a', { class: 'mini-btn', href: '#bookings', 'aria-label': `Booking with ${who}` }, icon('calendar', 15)));
      }))
      : el('p', { class: 'muted small card-note' }, state.settings?.booking_url ? 'When someone books through your link it lands here, and on Today.' : 'Add your booking link in Settings so people can book a call.'));
}

/* ------------------------------------------------------------ feed */
const FEED = {
  sms_reply: { label: 'Reply received', icon: 'message', tone: 'blue' },
  sms_sent: { label: 'Text sent', icon: 'send', tone: '' },
  booking: { label: 'Booking made', icon: 'calendar', tone: 'teal' },
  booking_cancelled: { label: 'Booking cancelled', icon: 'calendar', tone: 'amber' },
  website_lead: { label: 'Website lead', icon: 'globe', tone: 'violet' },
  opt_out: { label: 'Opt-out honoured', icon: 'ban', tone: 'rose' },
  dnc: { label: 'Do not contact', icon: 'ban', tone: 'rose' },
  import: { label: 'Leads imported', icon: 'upload', tone: 'up' }
};

function feedCard(state) {
  const events = state.events.slice(0, 7);
  const live = state.connection === 'live';
  const list = el('ul', { class: 'feed' }, events.map((e) => {
    const isNew = !firstPaint && !seenEvents.has(e.id);
    seenEvents.add(e.id);
    const lead = e.lead_id ? leadById(e.lead_id) : null;
    const k = FEED[e.kind] || { label: String(e.kind || 'Update').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), icon: 'spark', tone: '' };
    const body = [
      el('span', { class: `fi${k.tone ? ` t-${k.tone}` : ''}`, 'aria-hidden': 'true' }, icon(k.icon, 14)),
      el('span', { class: 'feed-txt' },
        el('span', { class: 'ft' }, el('b', {}, k.label), lead ? ` · ${leadName(lead)}` : ''),
        e.summary ? el('span', { class: 'fd' }, e.summary) : null),
      el('time', { class: 'when', datetime: e.at || '' }, timeAgo(e.at))
    ];
    return el('li', { class: isNew ? 'is-new' : '' },
      lead ? el('a', { class: 'feed-row', href: `#leads/${lead.id}` }, body) : el('div', { class: 'feed-row' }, body));
  }));
  return el('section', { class: 'card today-card', 'aria-labelledby': 'feed-h' },
    el('div', { class: 'card-head' },
      el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, 'Activity'), el('h2', { class: 'h2', id: 'feed-h' }, 'Live feed')),
      el('span', { class: `livetag${live ? '' : ' is-off'}` }, el('span', { class: 'dot' }), live ? 'Live' : state.connection === 'offline' ? 'Offline' : 'Connecting')),
    events.length ? list : el('p', { class: 'muted small card-note' }, 'Texts, replies, bookings and website enquiries appear here the moment they happen.'));
}

/* ------------------------------------------------------------ hero */
const hourLabel = (n) => {
  const h = Number(n);
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:00 ${h >= 12 ? 'pm' : 'am'}`;
};

function smsStrip(state) {
  const s = state.sms;
  if (!s) {
    return el('div', { class: 'sms-strip' }, el('span', { class: 'item lbl' }, el('span', { class: `dot${state.smsChecked ? ' warn' : ''}` }),
      state.smsChecked ? 'SMS status unavailable right now' : 'Checking SMS…'));
  }
  const set = state.settings || {};
  const cap = Number(s.daily_cap) || 0;
  const sent = Number(s.sent_today) || 0;
  const pct = cap ? Math.min(100, Math.round((sent / cap) * 100)) : 0;
  return el('div', { class: 'sms-strip', 'aria-label': 'SMS status' },
    el('span', { class: 'item lbl' }, el('span', { class: `dot ${s.configured ? 'ok' : 'warn'}` }), s.configured ? 'SMS connected' : el('a', { href: '#settings' }, 'SMS not connected')),
    el('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
    el('span', { class: 'item mono' }, `${num(sent)} of ${num(cap)} sent today`),
    el('span', { class: `meter${sent >= cap ? ' is-full' : ''}`, role: 'img', 'aria-label': `${num(sent)} of ${num(cap)} daily texts sent` }, el('i', { style: `width:${pct}%` })),
    el('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
    el('span', { class: 'item' }, el('span', { class: `dot ${s.window_open ? 'ok' : 'warn'}` }),
      s.window_open ? `Window open until ${hourLabel(set.send_end_hour ?? 17)}` : `Window closed · opens ${hourLabel(set.send_start_hour ?? 9)}`));
}

function hero(state) {
  const unread = state.leads.filter((l) => l.unread && !l.archived).length;
  const today = dayKey();
  const callsToday = state.bookings.filter((b) => b.status === 'booked' && b.starts_at && dayKey(b.starts_at) === today).length;
  const bits = [];
  if (unread) bits.push(`${plural(unread, 'reply', 'replies')} waiting`);
  if (callsToday) bits.push(`${plural(callsToday, 'call')} today`);
  const lede = !state.leads.length
    ? ['An empty pipeline is a clean slate. Start by importing a list or adding someone you already know.']
    : bits.length
      ? [el('b', {}, `${bits[0]}${bits.length > 1 ? ',' : '.'}`), bits.length > 1 ? ` ${bits[1]}.` : '']
      : ['Quiet so far. A good day to write personal lines and send a careful batch.'];
  const date = new Date().toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane', weekday: 'long', day: 'numeric', month: 'long' });
  return el('section', { class: 'home-hero', 'aria-labelledby': 'greet-h' },
    el('div', { class: 'hero-top' },
      el('div', { class: 'hero-copy' },
        el('p', { class: 'eyebrow' }, date),
        el('h1', { class: 'h1', id: 'greet-h' }, `${greeting()}, Tyler`),
        el('p', { class: 'lede' }, lede)),
      el('div', { class: 'hero-actions' },
        el('a', { class: 'btn btn-ghost', href: '#leads/import' }, icon('upload', 16), 'Import'),
        el('a', { class: 'btn btn-primary', href: '#leads/new' }, icon('plus', 16), 'Add lead'))),
    smsStrip(state));
}

/* ------------------------------------------------------------ warm */
const WARM_TONE = { replied: 'var(--amber)', interested: 'var(--violet)', booked: 'var(--teal)' };

function pipelineCard(state) {
  const leads = state.leads.filter(isActive);
  const hot = leads.filter((l) => ['replied', 'interested', 'booked'].includes(l.status))
    .sort((a, b) => (Number(b.est_monthly_value) || 0) - (Number(a.est_monthly_value) || 0) || String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, 5);
  if (!hot.length) return null;
  const total = hot.reduce((s, l) => s + (Number(l.est_monthly_value) || 0), 0);
  const bar = total
    ? el('div', { class: 'pipe', role: 'img', 'aria-label': `Share of ${money(total)} a month by conversation: ${hot.filter((l) => Number(l.est_monthly_value)).map((l) => `${leadName(l)} ${money(l.est_monthly_value)}`).join(', ')}` },
      hot.filter((l) => Number(l.est_monthly_value) > 0).map((l) => el('i', { style: `flex:${Number(l.est_monthly_value)};background:${WARM_TONE[l.status] || 'var(--ink)'}` })))
    : null;
  return el('section', { class: 'card today-card', 'aria-labelledby': 'warm-h' },
    el('div', { class: 'card-head' },
      el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, 'Warm conversations'),
        el('h2', { class: 'h2', id: 'warm-h' }, total ? [el('span', { class: 'tot' }, `${money(total)}/mo`), ' on the table'] : 'People who replied')),
      el('a', { class: 'card-link', href: '#leads' }, 'Pipeline', icon('arrow', 14))),
    bar,
    el('ul', { class: 'warm' }, hot.map((l) => el('li', {},
      el('a', { class: 'warm-nm', href: `#leads/${l.id}` }, leadName(l)),
      l.est_monthly_value ? el('span', { class: 'warm-val' }, formatValue(l.est_monthly_value), el('small', {}, '/mo')) : el('span', { class: 'warm-val faint' }, '–'),
      statusBadge(l.status)))));
}

export default function home(ctx) {
  const { state } = ctx;
  const node = el('div', { class: 'page today' },
    hero(state),
    kpiStrip(state),
    el('div', { class: 'today-grid' },
      el('div', { class: 'today-col c1' }, doNextCard(state)),
      el('div', { class: 'today-col c2' }, callsCard(state), pipelineCard(state)),
      el('div', { class: 'today-col c3' }, chartCard(state), feedCard(state))));
  firstPaint = false;
  return node;
}
