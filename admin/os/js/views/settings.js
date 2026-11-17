// Settings: outreach rules, business details, PIN, integrations, opt-outs and exports.
import {
  el, icon, badge, toast, field, input, select, emptyState, dateTime, prettyPhone,
  copyText, busy, toCsv, downloadFile, plural, num
} from '../ui.js?v=20261118a';
import { state, saveSettings, changePin, suppress, normalisePhone, refreshSmsStatus } from '../api.js?v=20261118a';
import { FUNCTIONS_URL } from '../config.js?v=20261118a';

const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];
const TIMEZONES = ['Australia/Brisbane', 'Australia/Sydney', 'Australia/Melbourne', 'Australia/Hobart',
  'Australia/Adelaide', 'Australia/Darwin', 'Australia/Perth'];
const hourLabel = (h) => (h === 0 || h === 24 ? '12am' : h === 12 ? '12pm' : h < 12 ? `${h}am` : `${h - 12}pm`);

/** Validate a settings patch. Returns an error message or null. */
export function validateSettings(p) {
  if ('sender_name' in p && !String(p.sender_name || '').trim()) return 'Sender name is required: every text must say who it is from.';
  if ('optout_text' in p && !/stop/i.test(p.optout_text || '')) return 'The opt-out text must tell people to reply STOP.';
  if ('daily_cap' in p && !(Number.isInteger(p.daily_cap) && p.daily_cap >= 0 && p.daily_cap <= 500)) return 'Daily cap must be a whole number from 0 to 500.';
  if ('send_start_hour' in p && 'send_end_hour' in p && !(p.send_start_hour < p.send_end_hour)) return 'The window must end after it starts.';
  if ('send_days' in p && !p.send_days.length) return 'Pick at least one sending day.';
  if ('booking_url' in p && p.booking_url && !/^https:\/\/\S+$/.test(p.booking_url)) return 'The booking link must start with https://';
  if ('notify_email' in p && p.notify_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.notify_email)) return 'That notification email does not look right.';
  if ('avg_deal_value' in p && !(p.avg_deal_value >= 0)) return 'Average deal value must be zero or more.';
  return null;
}

export default function settings() {
  const s = state.settings || {};
  const root = el('div', { class: 'page set' });
  if (!state.settings) {
    root.append(el('section', { class: 'card' }, emptyState({ icon: 'settings', title: 'Settings not loaded', text: 'Check the connection and reload.' })));
    return root;
  }

  /* ------------------------------------------------ outreach rules */
  const f = {
    sender_name: input('sender_name', { value: s.sender_name, required: true, maxlength: 40 }),
    optout_text: input('optout_text', { value: s.optout_text, required: true, maxlength: 60 }),
    daily_cap: input('daily_cap', { type: 'number', min: 0, max: 500, value: s.daily_cap, inputmode: 'numeric' }),
    send_start_hour: select('send_start_hour', Array.from({ length: 24 }, (_, h) => ({ id: h, label: hourLabel(h) })), s.send_start_hour),
    send_end_hour: select('send_end_hour', Array.from({ length: 24 }, (_, i) => ({ id: i + 1, label: hourLabel(i + 1) })), s.send_end_hour),
    timezone: select('timezone', TIMEZONES.map((t) => ({ id: t, label: t.replace('Australia/', '') })), s.timezone),
    require_hook: el('input', { type: 'checkbox', class: 'check', name: 'require_hook', checked: s.require_hook || null }),
    booking_url: input('booking_url', { type: 'url', value: s.booking_url || '', placeholder: 'https://cal.com/…' }),
    notify_email: input('notify_email', { type: 'email', value: s.notify_email || '', placeholder: 'you@wise-ai.au' }),
    avg_deal_value: input('avg_deal_value', { type: 'number', min: 0, step: 100, value: s.avg_deal_value, inputmode: 'numeric' })
  };
  if (!TIMEZONES.includes(s.timezone)) f.timezone.append(el('option', { value: s.timezone }, s.timezone));
  f.timezone.value = s.timezone;
  const dayBoxes = DAYS.map(([d, label]) => {
    const box = el('input', { type: 'checkbox', class: 'check', value: String(d), checked: (s.send_days || []).includes(d) || null, 'aria-label': label });
    return { d, box, node: el('label', { class: 'set-day' }, box, el('span', {}, label)) };
  });

  const read = () => ({
    sender_name: f.sender_name.value.trim(),
    optout_text: f.optout_text.value.trim(),
    daily_cap: Number(f.daily_cap.value),
    send_start_hour: Number(f.send_start_hour.value),
    send_end_hour: Number(f.send_end_hour.value),
    send_days: dayBoxes.filter((x) => x.box.checked).map((x) => x.d),
    timezone: f.timezone.value,
    require_hook: f.require_hook.checked,
    booking_url: f.booking_url.value.trim() || null,
    notify_email: f.notify_email.value.trim() || null,
    avg_deal_value: Number(f.avg_deal_value.value)
  });

  const preview = el('p', { class: 'set-preview' });
  const saveBtn = el('button', { class: 'btn btn-primary', type: 'submit', disabled: true }, 'Save changes');
  const dirtyNote = el('span', { class: 'muted set-dirty' });

  function changed() {
    const cur = state.settings || {};
    const v = read();
    const patch = {};
    for (const [k, val] of Object.entries(v)) {
      const before = cur[k] ?? null;
      const same = Array.isArray(val) ? JSON.stringify(val) === JSON.stringify([...(before || [])].sort((a, b) => a - b)) : String(val ?? '') === String(before ?? '');
      if (!same) patch[k] = val;
    }
    return patch;
  }
  function refreshDirty() {
    const n = Object.keys(changed()).length;
    saveBtn.disabled = !n;
    savebar.classList.toggle('is-dirty', !!n);
    dirtyNote.textContent = n ? `${plural(n, 'unsaved change')}` : 'All saved';
    const v = read();
    preview.textContent = `A cold text ends like this: “…worth a quick chat? - ${v.sender_name || '(no sender)'} ${v.optout_text}”`;
  }

  const savebar = el('div', { class: 'set-savebar' }, dirtyNote, el('span', { class: 'spacer' }),
    el('button', { class: 'btn btn-ghost', type: 'button', onClick: () => resetForm() }, 'Undo'), saveBtn);
  const form = el('form', { class: 'set-form', novalidate: true },
    group('Outreach', 'Sending rules', 'Who texts are from, how many go out, and when.',
      el('div', { class: 'form-grid' },
        field('Sender name', f.sender_name, 'Who every text is from. Added to a cold text if it is missing.'),
        field('Opt-out text', f.optout_text, 'Added to cold texts that do not mention STOP.'),
        field('Daily cap', f.daily_cap, 'Texts per day through Twilio. Replies to people who wrote back do not count.'),
        field('Timezone', f.timezone),
        el('div', { class: 'field' },
          el('span', { class: 'field-label' }, 'Sending window'),
          el('div', { class: 'row set-window' }, f.send_start_hour, el('span', { class: 'muted' }, 'to'), f.send_end_hour)),
        el('div', { class: 'field' },
          el('span', { class: 'field-label', id: 'set-days-l' }, 'Sending days'),
          el('div', { class: 'set-days', role: 'group', 'aria-labelledby': 'set-days-l' }, dayBoxes.map((x) => x.node))),
        el('label', { class: 'set-toggle full' }, f.require_hook,
          el('span', {},
            el('strong', {}, 'Require a personal line for first texts'),
            el('span', { class: 'set-toggle-hint' }, 'A lead with no hook cannot get a cold first text. Recommended: no generic blasts.')))),
      preview),
    group('Business', 'Bookings and notifications', 'Where people book, where alerts go, and what a client is worth.',
      el('div', { class: 'form-grid' },
        field('Booking link', f.booking_url, 'Your Cal.com page. Used by {booking_url} and “Send booking link”.'),
        field('Notification email', f.notify_email, 'Gets an email for each reply, booking and website lead.'),
        field('Average deal value ($)', f.avg_deal_value, 'Used by the playbook calculator and pipeline value.'))),
    savebar);

  function resetForm() {
    const c = state.settings || {};
    for (const k of ['sender_name', 'optout_text', 'daily_cap', 'send_start_hour', 'send_end_hour', 'timezone', 'avg_deal_value']) f[k].value = String(c[k] ?? '');
    f.booking_url.value = c.booking_url || '';
    f.notify_email.value = c.notify_email || '';
    f.require_hook.checked = !!c.require_hook;
    for (const x of dayBoxes) x.box.checked = (c.send_days || []).includes(x.d);
    refreshDirty();
  }

  form.addEventListener('input', refreshDirty);
  form.addEventListener('change', refreshDirty);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const patch = changed();
    if (!Object.keys(patch).length) return;
    const full = { ...read() };
    const err = validateSettings({ ...patch, send_start_hour: full.send_start_hour, send_end_hour: full.send_end_hour });
    if (err) { toast(err, 'bad'); return; }
    busy(saveBtn, async () => {
      try {
        await saveSettings(patch);
        toast('Settings saved');
      } catch (er) { toast(`Could not save: ${er.message}`, 'bad'); }
      refreshDirty();
    });
  });
  refreshDirty();

  /* ------------------------------------------------ PIN */
  const pinForm = el('form', { class: 'stack', novalidate: true });
  const pinFields = {
    old: input('old_pin', { type: 'password', inputmode: 'numeric', autocomplete: 'current-password', maxlength: 12, pattern: '[0-9]*', 'aria-label': 'Current PIN' }),
    nw: input('new_pin', { type: 'password', inputmode: 'numeric', autocomplete: 'new-password', maxlength: 12, pattern: '[0-9]*', 'aria-label': 'New PIN' }),
    again: input('new_pin2', { type: 'password', inputmode: 'numeric', autocomplete: 'new-password', maxlength: 12, pattern: '[0-9]*', 'aria-label': 'New PIN again' })
  };
  const pinBtn = el('button', { class: 'btn btn-primary', type: 'submit' }, icon('lock', 15), 'Change PIN');
  pinForm.append(
    el('div', { class: 'grid cols-3 set-pin' },
      field('Current PIN', pinFields.old), field('New PIN', pinFields.nw, '6 to 12 digits'), field('New PIN again', pinFields.again)),
    el('div', { class: 'row' }, pinBtn));
  pinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const oldPin = pinFields.old.value.trim();
    const newPin = pinFields.nw.value.trim();
    if (!/^\d{6,12}$/.test(newPin)) { toast('The new PIN must be 6 to 12 digits', 'bad'); return; }
    if (newPin !== pinFields.again.value.trim()) { toast('The new PINs do not match', 'bad'); return; }
    if (newPin === oldPin) { toast('Pick a PIN that is different from the current one', 'bad'); return; }
    if (/^(\d)\1+$/.test(newPin) || '01234567890123'.includes(newPin) || '98765432109876'.includes(newPin)) { toast('Pick a PIN that is harder to guess', 'bad'); return; }
    busy(pinBtn, async () => {
      const r = await changePin(oldPin, newPin);
      if (r.ok) {
        toast('PIN changed. Use the new one next time you unlock.');
        pinForm.reset();
        return;
      }
      const msg = r.error === 'bad_pin' ? `Current PIN is wrong${r.remaining !== undefined ? ` (${r.remaining} tries left before a lockout)` : ''}`
        : r.error === 'locked' ? `Too many tries. Locked for ${Math.ceil((r.retry_after_s || 60) / 60)} min.`
          : r.error === 'weak_pin' ? 'The new PIN must be 6 to 12 digits'
            : `Could not change the PIN (${r.error})`;
      toast(msg, 'bad');
    });
  });

  /* ------------------------------------------------ integrations */
  const integ = el('div', { class: 'stack' });
  function renderIntegrations() {
    const sms = state.sms;
    const bookingsSeen = (state.bookings || []).some((b) => b.cal_uid);
    const cur = state.settings || {};
    integ.replaceChildren(
      integration('Twilio · SMS',
        sms === null ? badge('Send service not reachable', 'warn') : sms.configured ? badge('Connected', 'ok') : badge('Not set up', 'warn'),
        sms?.configured ? `Sending is live. ${num(sms.sent_today)} of ${num(sms.daily_cap)} sent today.` : 'Until this is set up, send from your phone with “Copy & mark sent”. Everything is still recorded.',
        [
          'In Twilio, get an Australian mobile number that can send SMS (Australian numbers need a regulatory bundle approved first).',
          'In Supabase → Edge Functions → Secrets, add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER (the number as +614…).',
          'In Twilio → Phone Numbers → your number → Messaging, set “A message comes in” to Webhook, HTTP POST, with the URL below.',
          'Delivery receipts are requested on every send automatically. Text the number from your phone to check replies arrive in the Inbox.'
        ],
        [['Incoming messages webhook', `${FUNCTIONS_URL}twilio-webhook`]]),
      integration('Cal.com · bookings',
        bookingsSeen ? badge('Receiving bookings', 'ok') : badge('No bookings received yet', 'mute'),
        'Bookings arrive here and are matched to the lead by phone, then email.',
        [
          'In Cal.com → Settings → Developer → Webhooks, add a new webhook with the URL below.',
          'Tick Booking Created, Booking Rescheduled and Booking Cancelled.',
          'Set a secret (a long random string) and add the same value in Supabase secrets as CAL_WEBHOOK_SECRET.',
          'Ask for the phone number on your event type so bookings match the right lead.'
        ],
        [['Booking webhook', `${FUNCTIONS_URL}cal-webhook`]]),
      integration('Resend · email alerts',
        cur.notify_email ? badge(`Alerts go to ${cur.notify_email}`, 'info') : badge('No notification email', 'warn'),
        'The API key cannot be checked from here. If replies arrive but no email does, check this.',
        [
          'In Resend, add and verify the wise-ai.au domain (add the DNS records it gives you).',
          'Create an API key with sending access and add it in Supabase secrets as RESEND_API_KEY.',
          'Set the notification email above. Alerts come from dailybrief@wise-ai.au.'
        ],
        []));
  }
  const recheck = el('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, icon('refresh', 14), 'Recheck');
  recheck.addEventListener('click', () => busy(recheck, async () => {
    await refreshSmsStatus();
    renderIntegrations();
    toast(state.sms?.configured ? 'SMS is connected' : state.sms ? 'SMS is not set up yet' : 'Send service not reachable', state.sms?.configured ? 'ok' : 'warn');
  }));

  /* ------------------------------------------------ suppressions */
  const supBody = el('div');
  const supInput = input('phone', { type: 'tel', placeholder: '0412 345 678', 'aria-label': 'Phone number to suppress', inputmode: 'tel' });
  const supBtn = el('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, icon('ban', 14), 'Add');
  const supForm = el('form', { class: 'row set-sup-add' }, supInput, supBtn);
  supForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const p = normalisePhone(supInput.value);
    if (!p) { toast('Enter a valid phone number', 'bad'); return; }
    if ((state.suppressions || []).some((x) => x.phone === p)) { toast('That number is already on the list', 'info'); return; }
    busy(supBtn, async () => {
      try { await suppress(p, 'manual'); supInput.value = ''; toast(`${prettyPhone(p)} will never be texted`); renderSup(); } catch (er) { toast(`Could not add: ${er.message}`, 'bad'); }
    });
  });
  let supQuery = '';
  const supSearch = el('input', { class: 'input sm', type: 'search', placeholder: 'Search numbers', 'aria-label': 'Search suppressed numbers' });
  supSearch.addEventListener('input', () => { supQuery = supSearch.value.replace(/\D/g, ''); renderSup(); });
  function renderSup() {
    const list = state.suppressions || [];
    const rows = supQuery ? list.filter((x) => x.phone.replace(/\D/g, '').includes(supQuery) || prettyPhone(x.phone).replace(/\D/g, '').includes(supQuery)) : list;
    supBody.replaceChildren(
      list.length
        ? el('div', { class: 'table-wrap set-sup-table' }, el('table', { class: 'table' },
          el('thead', {}, el('tr', {}, el('th', {}, 'Number'), el('th', {}, 'Reason'), el('th', {}, 'Added'))),
          el('tbody', {}, rows.slice(0, 200).map((x) => el('tr', {},
            el('td', { class: 'mono' }, prettyPhone(x.phone)),
            el('td', {}, x.reason === 'opt_out' ? 'Replied STOP' : x.reason === 'manual' ? 'Added by you' : x.reason),
            el('td', { class: 'muted' }, dateTime(x.created_at)))))))
        : el('p', { class: 'muted' }, 'Nobody has opted out yet.'),
      rows.length > 200 ? el('p', { class: 'muted' }, `Showing 200 of ${num(rows.length)}. Export for the full list.`) : '');
  }
  const exportSup = () => {
    const rows = (state.suppressions || []).map((x) => ({ phone: x.phone, reason: x.reason, added: x.created_at }));
    downloadFile(`wise-ai-suppressions-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows, ['phone', 'reason', 'added']));
    toast(`Exported ${plural(rows.length, 'number')}`);
  };
  const exportLeads = () => {
    const cols = ['business', 'contact_name', 'phone', 'email', 'website', 'suburb', 'industry', 'status', 'source', 'number_source_url',
      'hook', 'pain', 'est_monthly_value', 'campaign', 'sequence_step', 'last_contacted_at', 'last_reply_at', 'next_followup_at', 'tags', 'notes', 'archived', 'created_at'];
    const camp = Object.fromEntries((state.campaigns || []).map((c) => [c.id, c.name]));
    const rows = (state.leads || []).map((l) => ({ ...l, campaign: camp[l.campaign_id] || '' }));
    downloadFile(`wise-ai-leads-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows, cols));
    toast(`Exported ${plural(rows.length, 'lead')}`);
  };

  root.append(
    el('header', { class: 'page-head' },
      el('div', { class: 'stack' }, el('div', { class: 'eyebrow' }, 'System'), el('h1', { class: 'h1' }, 'Settings'))),
    form,
    group('Security', 'Change PIN', 'Five wrong PINs lock this device for a while. The lock gets longer each time.',
      pinForm),
    group('Connections', 'Integrations', 'What is connected, and the steps to connect the rest.',
      el('div', { class: 'set-int-tools' }, recheck),
      integ),
    group('Compliance', 'Do-not-contact list', 'Numbers here are never texted, even if the lead is deleted or re-imported. Removal is not offered: once someone opts out, they stay out.',
      el('div', { class: 'set-sup-tools' }, supForm, el('span', { class: 'spacer' }), supSearch,
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: exportSup }, icon('download', 14), 'Export CSV')),
      supBody),
    group('Data', 'Export and other tools', 'Everything you have, as a spreadsheet.',
      el('div', { class: 'row' },
        el('button', { class: 'btn btn-ghost', type: 'button', onClick: exportLeads }, icon('download', 15), `Export all leads (${num((state.leads || []).length)})`),
        el('a', { class: 'btn btn-ghost', href: '../' }, icon('external', 15), 'Finance & projects (legacy HQ)'))));

  renderIntegrations();
  renderSup();
  root.onState = () => {
    // Forms keep what is typed; only the live panels refresh.
    renderIntegrations();
    renderSup();
    if (!Object.keys(changed()).length) refreshDirty();
  };
  return root;
}

/** A settings group: title and a short description on the left, the controls on the right. */
function group(eyebrow, title, desc, ...body) {
  return el('section', { class: 'set-sec' },
    el('div', { class: 'set-sec-head' },
      el('div', { class: 'eyebrow' }, eyebrow),
      el('h2', { class: 'h2' }, title),
      desc ? el('p', { class: 'set-sec-desc' }, desc) : null),
    el('div', { class: 'set-sec-body' }, ...body));
}

const openInt = new Set();

function integration(name, status, lead, steps, urls) {
  const d = el('details', { class: 'set-int', open: openInt.has(name) || null },
    el('summary', { class: 'set-int-sum' },
      el('span', { class: 'set-int-name' }, name), status, el('span', { class: 'spacer' }),
      el('span', { class: 'set-int-more muted' }, 'Setup steps', icon('chevron-down', 14))),
    el('div', { class: 'set-int-body' },
      el('p', { class: 'muted' }, lead),
      el('ol', { class: 'set-steps' }, steps.map((t) => el('li', {}, t))),
      urls.map(([label, url]) => el('div', { class: 'set-url' },
        el('span', { class: 'field-label' }, label),
        el('div', { class: 'row nowrap' },
          el('code', { class: 'set-code' }, url),
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => copyText(url, 'URL copied') }, icon('copy', 14), 'Copy'))))));
  d.addEventListener('toggle', () => { if (d.open) openInt.add(name); else openInt.delete(name); });
  return d;
}
