// Bookings: calls from Cal.com, upcoming and past, linked to leads, with outcomes.
// Attendee fields come from outside: text nodes only.
import {
  el, icon, go, badge, statusBadge, toast, modal, field, input, textarea, emptyState,
  dayKey, dayLabel, timeOnly, dateTime, timeAgo, prettyPhone, copyText, busy, plural
} from '../ui.js';
import { state, saveLead, logEvent, leadName } from '../api.js';

let showCancelled = false;

const BOOKING_TONE = { booked: 'ok', rescheduled: 'mute', cancelled: 'bad' };
const BOOKING_LABEL = { booked: 'Booked', rescheduled: 'Rescheduled', cancelled: 'Cancelled' };

function leadFor(b) {
  return b.lead_id ? (state.leads || []).find((l) => l.id === b.lead_id) || null : null;
}

/** Split bookings into upcoming (soonest first) and past (latest first). */
export function splitBookings(list, now = Date.now(), { includeCancelled = false } = {}) {
  const live = list.filter((b) => includeCancelled || b.status === 'booked');
  const upcoming = [];
  const past = [];
  for (const b of live) {
    const end = Date.parse(b.ends_at || b.starts_at);
    if (!b.starts_at || Number.isNaN(end) || end >= now) upcoming.push(b); else past.push(b);
  }
  upcoming.sort((a, b) => Date.parse(a.starts_at || 0) - Date.parse(b.starts_at || 0));
  past.sort((a, b) => Date.parse(b.starts_at || 0) - Date.parse(a.starts_at || 0));
  return { upcoming, past };
}

export default function bookings() {
  const root = el('div', { class: 'page book' });
  const linkCard = el('section', { class: 'card book-link' });
  const summary = el('div', { class: 'grid cols-3 book-kpis' });
  const lists = el('div', { class: 'stack' });

  function renderLink() {
    const url = state.settings?.booking_url || '';
    linkCard.replaceChildren(
      el('div', { class: 'book-link-icon', 'aria-hidden': 'true' }, icon('calendar', 20)),
      el('div', { class: 'book-link-main' },
        el('div', { class: 'eyebrow' }, 'Your booking link'),
        url ? el('a', { class: 'book-link-url', href: url, target: '_blank', rel: 'noopener' }, url)
          : el('span', { class: 'muted' }, 'Not set yet. Add it in Settings so you can send it from the Inbox.')),
      el('div', { class: 'row' },
        url ? el('button', { class: 'btn btn-primary btn-sm', type: 'button', onClick: () => copyText(url, 'Booking link copied') }, icon('copy', 15), 'Copy') : null,
        url ? el('a', { class: 'btn btn-ghost btn-sm', href: url, target: '_blank', rel: 'noopener' }, icon('external', 15), 'Open') : null,
        url ? null : el('button', { class: 'btn btn-primary btn-sm', type: 'button', onClick: () => go('#settings') }, 'Set it up')));
  }

  function renderLists() {
    const all = state.bookings || [];
    const { upcoming, past } = splitBookings(all, Date.now(), { includeCancelled: showCancelled });
    const today = dayKey();
    const weekEnd = Date.now() + 7 * 86400000;
    const live = all.filter((b) => b.status === 'booked');
    const todayCount = live.filter((b) => b.starts_at && dayKey(b.starts_at) === today).length;
    const weekCount = live.filter((b) => b.starts_at && Date.parse(b.starts_at) >= Date.now() && Date.parse(b.starts_at) <= weekEnd).length;
    const pastLive = live.filter((b) => b.starts_at && Date.parse(b.ends_at || b.starts_at) < Date.now());
    const needOutcome = pastLive.filter((b) => { const l = leadFor(b); return l && l.status === 'booked'; }).length;
    summary.replaceChildren(
      kpi('Calls today', todayCount, todayCount ? 'Check the notes before each one' : 'Nothing booked today'),
      kpi('Next 7 days', weekCount, weekCount ? plural(weekCount, 'call') : 'Send more booking links'),
      kpi('Need an outcome', needOutcome, needOutcome ? 'Mark won, lost or follow up' : 'All up to date'));

    const toggle = el('label', { class: 'check-row book-toggle' },
      el('input', { type: 'checkbox', class: 'check', checked: showCancelled || null, onChange: (e) => { showCancelled = e.target.checked; renderLists(); } }),
      el('span', {}, 'Show cancelled and rescheduled'));

    const upcomingCard = el('section', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', {}, el('div', { class: 'eyebrow' }, 'Coming up'), el('h2', { class: 'h2' }, 'Upcoming calls')),
        toggle),
      upcoming.length ? groupByDay(upcoming) : emptyState({ icon: 'calendar', title: 'No upcoming calls',
        text: all.length ? 'New bookings from Cal.com appear here as soon as they are made.' : 'When someone books through your Cal.com link it appears here, linked to the lead.' }));
    const pastCard = el('section', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', {}, el('div', { class: 'eyebrow' }, 'Done'), el('h2', { class: 'h2' }, 'Past calls'))),
      past.length ? el('ul', { class: 'book-list' }, past.slice(0, 60).map((b) => row(b, true)))
        : el('p', { class: 'muted' }, 'No past calls yet.'));
    lists.replaceChildren(upcomingCard, pastCard);
  }

  function groupByDay(items) {
    const out = el('div', { class: 'book-days' });
    let day = '';
    let ul = null;
    for (const b of items) {
      const k = b.starts_at ? dayKey(b.starts_at) : 'tbc';
      if (k !== day) {
        day = k;
        ul = el('ul', { class: 'book-list' });
        out.append(el('div', { class: 'book-day' }, el('h3', { class: 'eyebrow book-day-label' }, b.starts_at ? dayLabel(b.starts_at) : 'Time to be confirmed'), ul));
      }
      ul.append(row(b, false));
    }
    return out;
  }

  function row(b, isPast) {
    const l = leadFor(b);
    const who = b.attendee_name || (l ? leadName(l) : 'Unknown attendee');
    const contact = [b.attendee_phone ? prettyPhone(b.attendee_phone) : null, b.attendee_email].filter(Boolean).join(' · ');
    const startsIn = b.starts_at ? Date.parse(b.starts_at) - Date.now() : null;
    const soon = !isPast && startsIn !== null && startsIn < 30 * 60000;
    return el('li', { class: `book-item${b.status !== 'booked' ? ' is-off' : ''}${soon ? ' is-soon' : ''}` },
      el('div', { class: 'book-when' },
        el('span', { class: 'book-time' }, b.starts_at ? timeOnly(b.starts_at) : 'TBC'),
        el('span', { class: 'book-date muted' }, b.starts_at ? (isPast ? dateTime(b.starts_at).replace(/,.*$/, '') : timeAgo(b.starts_at)) : '')),
      el('div', { class: 'book-main' },
        el('div', { class: 'book-who' },
          el('strong', {}, who),
          b.status !== 'booked' ? badge(BOOKING_LABEL[b.status] || b.status, BOOKING_TONE[b.status] || 'mute') : null,
          l ? statusBadge(l.status) : null),
        b.title ? el('div', { class: 'book-title muted' }, b.title) : null,
        contact ? el('div', { class: 'book-contact muted' }, contact) : null,
        el('div', { class: 'book-links row' },
          l ? el('a', { href: `#leads/${l.id}`, class: 'book-lead' }, icon('user', 13), leadName(l)) : el('span', { class: 'muted' }, 'No lead linked'),
          l ? el('a', { href: `#inbox/${l.id}`, class: 'book-lead' }, icon('message', 13), 'Messages') : null)),
      el('div', { class: 'book-actions row' },
        b.meeting_url && !isPast && b.status === 'booked'
          ? el('a', { class: `btn btn-sm ${soon ? 'btn-primary' : 'btn-ghost'}`, href: safeUrl(b.meeting_url), target: '_blank', rel: 'noopener' }, icon('external', 14), 'Join')
          : null,
        b.status === 'booked' && l ? outcomeButtons(b, l) : null));
  }

  function outcomeButtons(b, l) {
    const wrap = el('div', { class: 'book-outcome row', role: 'group', 'aria-label': `Outcome for ${leadName(l)}` });
    const done = ['won', 'lost'].includes(l.status);
    if (done) {
      wrap.append(el('span', { class: 'muted book-outcome-note' }, l.status === 'won' ? 'Won' : 'Lost'));
      return wrap;
    }
    const mk = (label, tone, onClick) => {
      const btn = el('button', { class: `btn btn-sm btn-ghost book-oc is-${tone}`, type: 'button' }, label);
      btn.addEventListener('click', () => onClick(btn));
      return btn;
    };
    wrap.append(
      mk('Won', 'ok', (btn) => outcome(btn, l, 'won')),
      mk('Lost', 'bad', (btn) => outcome(btn, l, 'lost')),
      mk('Follow up', 'info', () => followUp(l)));
    return wrap;
  }

  async function outcome(btn, l, status) {
    await busy(btn, async () => {
      try {
        await saveLead(l.id, { status, next_followup_at: null });
        logEvent('outcome', l.id, `Call with ${leadName(l)}: ${status}`).catch(() => {});
        toast(status === 'won' ? `Won: ${leadName(l)}. Ask for a referral once it is delivering.` : `Marked lost: ${leadName(l)}`);
      } catch (err) { toast(`Could not update: ${err.message}`, 'bad'); }
    });
  }

  async function followUp(l) {
    const d = new Date(Date.now() + 3 * 86400000);
    const iso = d.toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' });
    const res = await modal({
      title: `Follow up with ${leadName(l)}`,
      body: [
        field('Follow up on', input('date', { type: 'date', value: iso, required: true })),
        field('What was agreed', textarea('note', '', 'e.g. Sending a quote for the missed-call setup by Thursday'))
      ],
      confirmLabel: 'Save'
    });
    if (!res) return;
    try {
      const when = new Date(`${res.date}T09:00:00+10:00`).toISOString();
      const note = String(res.note || '').trim();
      const patch = { status: 'interested', next_followup_at: when };
      if (note) patch.notes = [l.notes, `${new Date().toLocaleDateString('en-AU')}: after call: ${note}`].filter(Boolean).join('\n');
      await saveLead(l.id, patch);
      logEvent('outcome', l.id, `Call with ${leadName(l)}: follow up${note ? ` (${note})` : ''}`).catch(() => {});
      toast('Follow-up saved');
    } catch (err) { toast(`Could not save: ${err.message}`, 'bad'); }
  }

  root.append(
    el('header', { class: 'page-head' },
      el('div', { class: 'stack' }, el('div', { class: 'eyebrow' }, 'Calls'), el('h1', { class: 'h1' }, 'Bookings'))),
    linkCard, summary, lists);
  renderLink();
  renderLists();
  root.onState = () => {
    if (root.contains(document.activeElement) && document.activeElement.matches('input, textarea')) return;
    renderLink();
    renderLists();
  };
  return root;
}

function kpi(label, value, sub) {
  return el('div', { class: 'kpi' }, el('div', { class: 'kpi-label' }, label), el('div', { class: 'kpi-value' }, String(value)), el('div', { class: 'kpi-sub' }, sub));
}

/** Only http(s) links from a webhook payload become hrefs. */
function safeUrl(u) {
  try { const x = new URL(u); return ['http:', 'https:'].includes(x.protocol) ? x.href : '#'; } catch { return '#'; }
}
