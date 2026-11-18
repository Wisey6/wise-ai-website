// Settings: outreach rules, business details, PIN, integrations, opt-outs, exports,
// and the one-off import from the old HQ console (/admin).
import {
  el, icon, badge, toast, field, input, select, emptyState, dateTime, prettyPhone,
  copyText, busy, toCsv, downloadFile, plural, num, money, confirmDialog, fill
} from '../ui.js?v=20261118d';
import { state, saveSettings, changePin, suppress, normalisePhone, refreshSmsStatus, saveRow, aiStatus, agentStatus, sb } from '../api.js?v=20261118d';
import { FUNCTIONS_URL } from '../config.js?v=20261118d';
import { AGENTS, CHAT_AGENT, agentsInfo, settingSwitch } from './agents.js?v=20261118d';
import { chatModelPicker } from '../chat.js?v=20261118d';
import { setMyEmail, teamSave } from '../api.js?v=20261118d';
import { ownerBadge, initialsOf, meId } from '../owners.js?v=20261118d';

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
  if ('business_name' in p && !String(p.business_name || '').trim()) return 'Business name is required.';
  if ('abn' in p && p.abn && String(p.abn).replace(/\s/g, '').length !== 11) return 'An ABN is 11 digits.';
  if ('tax_rate' in p && !(p.tax_rate >= 0 && p.tax_rate < 1)) return 'Tax set-aside must be from 0 to 99%.';
  if ('monthly_target' in p && !(p.monthly_target >= 0)) return 'Monthly revenue target must be zero or more.';
  if ('owner_draw' in p && !(p.owner_draw >= 0)) return 'Monthly take-home must be zero or more.';
  if ('ai_monthly_cap_usd' in p && !(p.ai_monthly_cap_usd >= 0 && p.ai_monthly_cap_usd <= 500)) return 'The AI monthly cap must be from US$0 to US$500.';
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
    avg_deal_value: input('avg_deal_value', { type: 'number', min: 0, step: 100, value: s.avg_deal_value, inputmode: 'numeric' }),
    business_name: input('business_name', { value: s.business_name || '', required: true, maxlength: 80 }),
    abn: input('abn', { value: s.abn || '', placeholder: '12 345 678 901', inputmode: 'numeric', maxlength: 14 }),
    gst_registered: el('input', { type: 'checkbox', class: 'check', name: 'gst_registered', checked: s.gst_registered || null }),
    tax_rate: input('tax_rate', { type: 'number', min: 0, max: 99, step: 0.5, value: pct(s.tax_rate), inputmode: 'decimal' }),
    monthly_target: input('monthly_target', { type: 'number', min: 0, step: 500, value: s.monthly_target ?? '', inputmode: 'numeric' }),
    owner_draw: input('owner_draw', { type: 'number', min: 0, step: 100, value: s.owner_draw ?? '', inputmode: 'numeric' }),
    proposal_terms: el('textarea', { class: 'input', name: 'proposal_terms', rows: 4, placeholder: 'e.g. 50% to start, 50% on handover. Monthly fees invoiced on the 1st, 14 days to pay. Cancel any time with 30 days notice.' })
  };
  f.proposal_terms.value = s.proposal_terms || '';
  f.ai_enabled = el('input', { type: 'checkbox', class: 'check', name: 'ai_enabled', checked: s.ai_enabled || null });
  f.ai_monthly_cap_usd = input('ai_monthly_cap_usd', { type: 'number', min: 0, max: 500, step: 1, value: s.ai_monthly_cap_usd ?? 5, inputmode: 'decimal' });
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
    avg_deal_value: Number(f.avg_deal_value.value),
    business_name: f.business_name.value.trim(),
    abn: formatAbn(f.abn.value) || null,
    gst_registered: f.gst_registered.checked,
    tax_rate: f.tax_rate.value === '' ? 0 : Math.round(Number(f.tax_rate.value) * 100) / 10000,
    monthly_target: Number(f.monthly_target.value) || 0,
    owner_draw: Number(f.owner_draw.value) || 0,
    proposal_terms: f.proposal_terms.value.trim() || null,
    ai_enabled: f.ai_enabled.checked,
    ai_monthly_cap_usd: f.ai_monthly_cap_usd.value === '' ? 0 : Number(f.ai_monthly_cap_usd.value)
  });

  /* AI status, spend and this month's usage (live: redrawn on state changes). */
  const aiLive = el('div', { class: 'set-ai', dataset: { ai: 'status' } });
  let usage = null;
  let usageFor = null;
  const loadUsage = async () => {
    const month = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' }).slice(0, 7);
    usageFor = state.ai?.spent_usd ?? null;
    const { data, error } = await sb.from('ai_usage').select('task,cost_usd,ok,at').gte('at', `${month}-01T00:00:00+10:00`).order('at', { ascending: false }).limit(2000);
    usage = error ? { error: error.message } : summariseAiUsage(data || []);
    renderAiLive();
  };
  function renderAiLive() {
    const a = state.ai;
    const status = !a ? ['warn', 'Status unavailable right now'] : a.configured ? ['ok', 'Connected'] : ['warn', 'Not connected'];
    const cap = Number(a?.cap_usd ?? state.settings?.ai_monthly_cap_usd ?? 0);
    const spent = Number(a?.spent_usd || 0);
    const pctUsed = cap ? Math.min(100, Math.round((spent / cap) * 100)) : 0;
    fill(aiLive,
      el('div', { class: 'set-ai-status' },
        el('span', { class: `badge is-${status[0]}`, dataset: { aiStatus: a?.configured ? 'connected' : 'not-connected' } }, el('span', { class: 'badge-dot', 'aria-hidden': 'true' }), status[1]),
        a && a.configured && !a.enabled ? el('span', { class: 'small muted' }, 'Switched off below') : null),
      !a || !a.configured ? el('p', { class: 'small muted' }, 'To connect: in Supabase, Edge Functions, Secrets, add a secret named ANTHROPIC_API_KEY holding your Anthropic API key. It is never stored in the hub.') : null,
      a ? el('div', { class: 'set-ai-spend' },
        el('div', { class: 'row' }, el('span', { class: 'field-label' }, 'Spent this month'), el('span', { class: 'spacer' }),
          el('span', { class: 'tnum small', dataset: { aiSpend: '' } }, `${usd(spent)} of ${usd(cap)}`)),
        el('span', { class: 'set-ai-meter', role: 'img', 'aria-label': `${pctUsed}% of the monthly AI cap used` }, el('i', { style: `width:${pctUsed}%` }))) : null,
      usage === null ? el('p', { class: 'small muted' }, 'Loading this month’s usage…')
        : usage.error ? el('p', { class: 'small muted' }, `Usage could not be loaded (${usage.error}).`)
          : usage.rows.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'table imp-table set-ai-usage' },
            el('thead', {}, el('tr', {}, el('th', {}, 'Used for'), el('th', { class: 'num' }, 'Drafts'), el('th', { class: 'num' }, 'Cost'))),
            el('tbody', {}, usage.rows.map((r) => el('tr', { dataset: { task: r.task } }, el('td', {}, AI_TASK_LABEL[r.task] || r.task), el('td', { class: 'num' }, num(r.count)), el('td', { class: 'num' }, usd(r.cost))))),
            el('tfoot', {}, el('tr', {}, el('td', {}, 'Total'), el('td', { class: 'num' }, num(usage.count)), el('td', { class: 'num' }, usd(usage.cost))))))
            : el('p', { class: 'small muted' }, 'No drafts yet this month.'));
  }
  renderAiLive();
  loadUsage();

  const preview = el('p', { class: 'set-preview' });
  const saveBtn = el('button', { class: 'btn btn-primary', type: 'submit', disabled: true }, 'Save changes');
  const dirtyNote = el('span', { class: 'muted set-dirty' });

  function changed() {
    const cur = state.settings || {};
    const v = read();
    const patch = {};
    for (const [k, val] of Object.entries(v)) {
      const before = cur[k] ?? null;
      const same = Array.isArray(val) ? JSON.stringify(val) === JSON.stringify([...(before || [])].sort((a, b) => a - b))
        : typeof val === 'number' && before !== null && before !== '' ? Math.abs(val - Number(before)) < 1e-9
          : String(val ?? '') === String(before ?? '');
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
    group('Business', 'Business and targets', 'Used on proposals and invoices, and by Today and Runway to read the month.',
      el('div', { class: 'form-grid' },
        field('Business name', f.business_name, 'As it appears on proposals and invoices.'),
        field('ABN', f.abn, 'Optional. 11 digits.'),
        field('Monthly revenue target ($)', f.monthly_target, 'Today shows money in this month against it.'),
        field('Monthly take-home needed ($)', f.owner_draw, 'What you need to pay yourself each month. Runway plans around it.'),
        field('Tax set-aside (%)', f.tax_rate, 'Share of profit to put aside for tax.'),
        el('label', { class: 'set-toggle set-toggle-inline' }, f.gst_registered,
          el('span', {},
            el('strong', {}, 'Registered for GST'),
            el('span', { class: 'set-toggle-hint' }, 'Adds GST to invoices and proposal totals.'))),
        el('div', { class: 'full' }, field('Default proposal terms', f.proposal_terms, 'Dropped into each new proposal. Cash on hand lives on the Runway page.')))),
    group('AI', 'AI drafting', 'Drafts personal lines, replies, proposals and ROI write-ups when you ask. Nothing is ever sent without you reading it.',
      aiLive,
      el('div', { class: 'form-grid' },
        el('label', { class: 'set-toggle set-toggle-inline' }, f.ai_enabled,
          el('span', {}, el('strong', {}, 'AI drafting on'), el('span', { class: 'set-toggle-hint' }, 'Off hides every AI button in the hub.'))),
        field('Monthly cap (US$)', f.ai_monthly_cap_usd, 'Drafting stops for the month once this is spent. 0 to 500.')),
      el('ul', { class: 'set-ai-notes' },
        el('li', {}, 'Short texts (personal lines and replies) use the small, fast model. Proposals and ROI write-ups use the mid model.'),
        el('li', {}, 'Nothing is ever sent without you reading it: every draft lands in a field for you to edit, then you save or send it yourself.'))),
    group('Bookings', 'Bookings and notifications', 'Where people book, where alerts go, and what a client is worth.',
      el('div', { class: 'form-grid' },
        field('Booking link', f.booking_url, 'Your Cal.com page. Used by {booking_url} and “Send booking link”.'),
        field('Notification email', f.notify_email, 'Gets an email for each reply, booking and website lead.'),
        field('Average deal value ($)', f.avg_deal_value, 'Used by the playbook calculator and pipeline value.'))),
    savebar);

  function resetForm() {
    const c = state.settings || {};
    for (const k of ['sender_name', 'optout_text', 'daily_cap', 'send_start_hour', 'send_end_hour', 'timezone', 'avg_deal_value', 'monthly_target', 'owner_draw']) f[k].value = String(c[k] ?? '');
    f.business_name.value = c.business_name || '';
    f.abn.value = c.abn || '';
    f.gst_registered.checked = !!c.gst_registered;
    f.tax_rate.value = pct(c.tax_rate);
    f.proposal_terms.value = c.proposal_terms || '';
    f.ai_enabled.checked = !!c.ai_enabled;
    f.ai_monthly_cap_usd.value = String(c.ai_monthly_cap_usd ?? 5);
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
        if ('ai_enabled' in patch || 'ai_monthly_cap_usd' in patch) aiStatus();
        toast('Settings saved');
      } catch (er) { toast(`Could not save: ${er.message}`, 'bad'); }
      refreshDirty();
    });
  });
  refreshDirty();

  /* ------------------------------------------------ agents */
  const agentsSettings = agentsGroup();

  /* ------------------------------------------------ your sign-in + team */
  const signIn = yourSignIn();
  const team = teamGroup();

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
    agentsSettings.node,
    signIn.node,
    team.node,
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
        el('a', { class: 'btn btn-ghost', href: '../admin/', dataset: { legacy: '' } }, icon('external', 15), 'Old HQ console (retire it once imported)'))),
    group('Data', 'Import from the old HQ console', 'Brings clients, deals, projects, tasks, income, costs and library entries across from /admin, with their links kept. Run it once; after that the old console can be retired.',
      importTool()));

  renderIntegrations();
  renderSup();
  root.onState = () => {
    agentsSettings.update();
    signIn.update();
    team.update();
    // Forms keep what is typed; only the live panels refresh.
    if ((state.ai?.spent_usd ?? null) !== usageFor && usage !== null) loadUsage(); else renderAiLive();
    renderIntegrations();
    renderSup();
    if (!Object.keys(changed()).length) refreshDirty();
  };
  return root;
}

/** The Agents group: master switch, the assistant (on/off and model), the Researcher and
 *  briefing switches, monthly budget, spend. Saves at once. */
function agentsGroup() {
  const master = settingSwitch('agents_enabled', 'Agents');
  const chatSw = settingSwitch(CHAT_AGENT.col, 'The assistant');
  const models = chatModelPicker();
  const switches = AGENTS.map((a) => ({ a, sw: settingSwitch(a.col, a.name) }));
  const cap = input('agent_monthly_cap_usd', { type: 'number', min: 0, max: 100, step: 1, value: state.settings?.agent_monthly_cap_usd ?? 25, inputmode: 'decimal' });
  const saveCap = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { act: 'save-agent-cap' } }, 'Save budget');
  saveCap.addEventListener('click', () => {
    const v = Number(cap.value);
    if (cap.value === '' || !(v >= 0 && v <= 100)) { toast('The agent budget must be from US$0 to US$100.', 'bad'); cap.focus(); return; }
    busy(saveCap, async () => {
      try { await saveSettings({ agent_monthly_cap_usd: v }); toast('Agent budget saved'); agentStatus(); } catch (e) { toast(`Could not save: ${e.message}`, 'bad'); }
    });
  });
  const live = el('div', { class: 'set-agents-spend', dataset: { agentsSpend: '' } });
  const update = () => {
    master.update();
    chatSw.update();
    models.update();
    switches.forEach((x) => x.sw.update());
    if (document.activeElement !== cap) cap.value = String(state.settings?.agent_monthly_cap_usd ?? 25);
    const info = agentsInfo();
    const pctUsed = info.cap > 0 ? Math.min(100, Math.round((info.spent / info.cap) * 100)) : 100;
    fill(live,
      el('div', { class: 'row' },
        el('span', { class: `badge is-${info.connected ? 'ok' : 'warn'}` }, el('span', { class: 'badge-dot', 'aria-hidden': 'true' }), !info.reachable ? 'Status unavailable right now' : info.connected ? 'Connected' : 'Not connected'),
        el('span', { class: 'spacer' }),
        el('span', { class: 'tnum small' }, `${usd(info.spent)} of ${usd(info.cap)} this month`)),
      el('span', { class: `ag-meter${pctUsed >= 90 ? ' is-high' : ''}`, role: 'img', 'aria-label': `${pctUsed}% of the monthly agent budget used` }, el('i', { style: `width:${pctUsed}%` })));
  };
  update();
  const node = group('Agents', 'Agents', 'The assistant you talk to, plus the Researcher and the morning briefing. The assistant makes the changes you ask for and lists each with an Undo. None of them ever sends anything.',
    el('div', { class: 'set-agents', dataset: { setAgents: '' } },
      live,
      el('ul', { class: 'set-agents-list' },
        el('li', { dataset: { sw: 'agents_enabled' } }, el('span', {}, el('strong', {}, 'Agents on'), el('span', { class: 'set-toggle-hint' }, 'Off stops all of them at once.')), master),
        el('li', { dataset: { sw: CHAT_AGENT.col } }, el('span', {}, el('strong', {}, 'The assistant'), el('span', { class: 'set-toggle-hint' }, CHAT_AGENT.does)), chatSw),
        el('li', { class: 'set-agents-model' }, models.node),
        switches.map(({ a, sw }) => el('li', { dataset: { sw: a.col } }, el('span', {}, el('strong', {}, a.name), el('span', { class: 'set-toggle-hint' }, a.does)), sw))),
      el('div', { class: 'set-agents-budget' },
        field('Monthly agent budget (US$)', cap, 'All of them stop for the month once this is spent. 0 to 100.'),
        saveCap),
      el('p', { class: 'small muted' }, 'Separate from AI drafting above: drafting has its own monthly cap, and this budget covers only the agents.'),
      el('div', { class: 'row' },
        el('a', { class: 'btn btn-ghost btn-sm', href: '#agents' }, icon('agents', 14), 'Open Agents'),
        el('a', { class: 'btn btn-ghost btn-sm', href: '#agents/runs' }, icon('list', 14), 'Run log'))));
  return { node, update };
}

/* ------------------------------------------------------- Your sign-in
   Everyone: change your own PIN (current, new, confirm) and the address a PIN
   reset is emailed to. Only a masked hint of that address is ever shown. */
const PIN_RE = /^\d{4,12}$/;
const guessable = (p) => /^(\d)\1+$/.test(p) || '01234567890123'.includes(p) || '98765432109876'.includes(p);

/** Check a PIN change before it is sent. Returns {field, message} or null. Pure. */
export function validatePinChange(oldPin, newPin, again) {
  if (!oldPin) return { field: 'old', message: 'Enter your current PIN.' };
  if (!PIN_RE.test(oldPin)) return { field: 'old', message: 'Your current PIN is 4 to 12 digits.' };
  if (!PIN_RE.test(newPin)) return { field: 'nw', message: 'The new PIN must be 4 to 12 digits.' };
  if (newPin !== again) return { field: 'again', message: 'The two new PINs do not match.' };
  if (newPin === oldPin) return { field: 'nw', message: 'Pick a PIN that is different from the current one.' };
  if (guessable(newPin)) return { field: 'nw', message: 'Pick a PIN that is harder to guess.' };
  return null;
}

const pinIn = (name, label, auto) => {
  const n = input(name, { type: 'password', inputmode: 'numeric', autocomplete: auto, maxlength: 12, pattern: '[0-9]*', 'aria-label': label });
  n.addEventListener('input', () => { const c = n.value.replace(/\D/g, '').slice(0, 12); if (c !== n.value) n.value = c; });
  return n;
};

function yourSignIn() {
  const f = { old: pinIn('old_pin', 'Current PIN', 'current-password'), nw: pinIn('new_pin', 'New PIN', 'new-password'), again: pinIn('new_pin2', 'Confirm new PIN', 'new-password') };
  const err = el('p', { class: 'set-err', role: 'alert', dataset: { pinErr: '' } });
  const pinBtn = el('button', { class: 'btn btn-primary', type: 'submit' }, icon('lock', 15), 'Change PIN');
  const pinForm = el('form', { class: 'stack', novalidate: true, dataset: { form: 'change-pin' } },
    el('div', { class: 'grid cols-3 set-pin' },
      field('Current PIN', f.old), field('New PIN', f.nw, '4 to 12 digits'), field('Confirm new PIN', f.again)),
    err, el('div', { class: 'row' }, pinBtn));
  const showErr = (fieldKey, msg) => {
    err.textContent = msg || '';
    for (const [k, n] of Object.entries(f)) n.setAttribute('aria-invalid', String(k === fieldKey));
    if (fieldKey) f[fieldKey].focus();
  };
  Object.values(f).forEach((n) => n.addEventListener('input', () => { if (err.textContent) showErr(null, ''); }));
  pinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const bad = validatePinChange(f.old.value.trim(), f.nw.value.trim(), f.again.value.trim());
    if (bad) { showErr(bad.field, bad.message); return; }
    busy(pinBtn, async () => {
      const r = await changePin(f.old.value.trim(), f.nw.value.trim());
      if (r.ok) {
        showErr(null, '');
        toast('PIN changed. Use the new one next time you unlock.');
        pinForm.reset();
        return;
      }
      if (r.error === 'bad_pin') showErr('old', `Your current PIN is not right${Number.isFinite(Number(r.remaining)) && r.remaining !== null && r.remaining !== undefined ? `. ${plural(Number(r.remaining), 'try', 'tries')} left before a lockout.` : '.'}`);
      else if (r.error === 'locked') showErr('old', `Too many tries. Locked for ${Math.ceil((r.retry_after_s || 60) / 60)} min.`);
      else if (r.error === 'weak_pin') showErr('nw', 'The new PIN must be 4 to 12 digits.');
      else if (r.error === 'unauthorized') showErr(null, 'Your session has expired. Lock and unlock, then try again.');
      else showErr(null, `Could not change the PIN (${r.error}).`);
    });
  });

  // Email for PIN resets.
  const hint = el('p', { class: 'set-email-hint', dataset: { emailHint: '' } });
  const emailIn = input('reset_email', { type: 'email', placeholder: 'name@example.com', autocomplete: 'email', 'aria-label': 'New email for PIN resets' });
  const emailErr = el('p', { class: 'set-err', role: 'alert' });
  const emailBtn = el('button', { class: 'btn btn-ghost', type: 'submit' }, 'Save email');
  const emailForm = el('form', { class: 'set-email', novalidate: true, dataset: { form: 'reset-email' } },
    el('div', { class: 'set-email-row' }, field('Change it to', emailIn), emailBtn), emailErr);
  emailForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = emailIn.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { emailErr.textContent = 'That does not look like an email address.'; emailIn.focus(); return; }
    emailErr.textContent = '';
    busy(emailBtn, async () => {
      const r = await setMyEmail(v);
      if (r.ok) { emailIn.value = ''; toast('Reset email saved'); update(); } else emailErr.textContent = r.message;
    });
  });

  const who = el('div', { class: 'set-me' });
  function update() {
    const me = state.me;
    fill(who, me ? ownerBadge(me.id, { size: 'lg', title: false }) : null,
      el('div', { class: 'stack tight' },
        el('strong', {}, me ? me.name : 'Signed in'),
        el('span', { class: 'small muted' }, me ? `${me.role === 'owner' ? 'Owner' : 'Team member'} · signs in with their own PIN` : 'Loading who is signed in…')));
    hint.replaceChildren(...(me?.email_hint
      ? [el('span', { class: 'muted' }, 'Reset links go to '), el('strong', { class: 'tnum' }, me.email_hint)]
      : [el('span', { class: 'muted' }, 'No email on file yet, so a forgotten PIN can only be reset by the owner.')]));
  }
  update();
  const node = group('Your sign-in', 'Your PIN and reset email', 'Each person signs in with their own PIN. Five wrong PINs lock that person out for a while, and the lock gets longer each time.',
    who,
    el('div', { class: 'set-sub' }, el('h3', { class: 'h3' }, 'Change your PIN'), pinForm),
    el('div', { class: 'set-sub' }, el('h3', { class: 'h3' }, 'Email for PIN resets'), hint, emailForm));
  node.dataset.sec = 'sign-in';
  return { node, update };
}

/* --------------------------------------------------------------- Team
   Everyone sees who is on the team; only the owner changes it. All through teamSave. */
function teamGroup() {
  const body = el('div', { class: 'set-team', dataset: { team: '' } });
  const isOwner = () => state.me?.role === 'owner';
  const ownerOf = () => (state.team || []).find((m) => m.role === 'owner');

  const save = async (args, okMsg) => {
    const r = await teamSave(args);
    if (r.ok) { if (okMsg) toast(okMsg); return r.member; }
    toast(r.message, 'bad');
    return null;
  };

  async function editPerson(m) {
    const name = input('name', { value: m.name, required: true, maxlength: 60, autocomplete: 'off' });
    const ini = input('initials', { value: m.initials || '', maxlength: 3, autocomplete: 'off' });
    const v = await modal2('Edit ' + m.name, el('div', { class: 'form-grid' }, field('Name', name), field('Initials', ini, 'Up to 3 letters, shown in the ring')), 'Save');
    if (!v) return;
    await save({ member: { id: m.id, name: v.name.trim(), initials: v.initials.trim() } }, 'Saved');
  }

  async function resetPin(m) {
    const a = pinIn('pin', 'New PIN', 'new-password');
    const b = pinIn('pin2', 'Confirm new PIN', 'new-password');
    const emailIn = input('email', { type: 'email', placeholder: 'Leave empty to keep the one on file', autocomplete: 'off' });
    const v = await modal2(`Reset ${m.name}'s PIN`, el('div', { class: 'stack' },
      el('p', { class: 'small muted' }, `Set a new PIN for ${m.name}. You will see it once, so you can tell them; they can change it in Settings after signing in.`),
      el('div', { class: 'form-grid' }, field('New PIN', a, '4 to 12 digits'), field('Confirm new PIN', b)),
      field('Reset email (optional)', emailIn, 'Where their own "Forgot PIN?" link is sent')), 'Reset PIN');
    if (!v) return;
    if (!PIN_RE.test(v.pin)) { toast('A PIN is 4 to 12 digits.', 'bad'); return; }
    if (v.pin !== v.pin2) { toast('The two PINs do not match.', 'bad'); return; }
    if (guessable(v.pin)) { toast('Pick a PIN that is harder to guess.', 'bad'); return; }
    const args = { member: { id: m.id }, pin: v.pin, sign_in: true };
    if (v.email.trim()) args.email = v.email.trim();
    const saved = await save(args);
    if (saved) await showOnce(m.name, v.pin);
  }

  async function addPerson() {
    const name = input('name', { required: true, maxlength: 60, placeholder: 'e.g. Sam Lee', autocomplete: 'off' });
    const ini = input('initials', { maxlength: 3, placeholder: 'SL', autocomplete: 'off' });
    const can = el('input', { type: 'checkbox', class: 'check', name: 'sign_in', value: 'yes' });
    const a = pinIn('pin', 'Starting PIN', 'new-password');
    const em = input('email', { type: 'email', placeholder: 'For their PIN resets', autocomplete: 'off' });
    const loginBits = el('div', { class: 'form-grid', hidden: true }, field('Starting PIN', a, '4 to 12 digits, shown to you once'), field('Reset email', em, 'Optional'));
    can.addEventListener('change', () => { loginBits.hidden = !can.checked; });
    name.addEventListener('input', () => { if (!ini.dataset.touched) ini.placeholder = initialsOf({ name: name.value }) || 'SL'; });
    ini.addEventListener('input', () => { ini.dataset.touched = '1'; });
    const v = await modal2('Add a person', el('div', { class: 'stack' },
      el('div', { class: 'form-grid' }, field('Name', name), field('Initials', ini, 'Shown in their ring')),
      el('label', { class: 'check-row' }, can, el('span', {}, 'They can sign in to the hub ', el('span', { class: 'muted' }, '(otherwise work can still be given to them)'))),
      loginBits), 'Add person');
    if (!v) return;
    if (!v.name.trim()) { toast('A name is needed.', 'bad'); return; }
    const signIn = v.sign_in === 'yes';
    if (signIn && (!PIN_RE.test(v.pin) || guessable(v.pin))) { toast('Give them a starting PIN of 4 to 12 digits that is hard to guess.', 'bad'); return; }
    const sort = Math.max(0, ...(state.team || []).map((x) => Number(x.sort) || 0)) + 10;
    const args = { member: { name: v.name.trim(), initials: (v.initials || '').trim() || undefined, sort } };
    if (signIn) { args.sign_in = true; args.pin = v.pin; if ((v.email || '').trim()) args.email = v.email.trim(); }
    const saved = await save(args, `${v.name.trim()} added`);
    if (saved && signIn) await showOnce(saved.name, v.pin);
  }

  async function move(m, dir) {
    const list = [...(state.team || [])];
    const i = list.findIndex((x) => x.id === m.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    const a = list[i]; const b = list[j];
    // Swap the two places; only renumber when they share a sort value.
    let changes = Number(a.sort) !== Number(b.sort)
      ? [{ x: a, sort: Number(b.sort) }, { x: b, sort: Number(a.sort) }]
      : null;
    if (!changes) {
      [list[i], list[j]] = [list[j], list[i]];
      changes = list.map((x, k) => ({ x, sort: k * 10 })).filter(({ x, sort }) => Number(x.sort) !== sort);
    }
    for (const { x, sort } of changes) { if (!await save({ member: { id: x.id, sort } })) return; }
    body.querySelector(`[data-member="${m.id}"] [data-act="${dir < 0 ? 'up' : 'down'}"]`)?.focus();
  }

  async function setActive(m, on) {
    if (!on && !await confirmDialog(`Switch off ${m.name}'s login?`, `${m.name} will not be able to sign in. Their work keeps its owner, and you can switch the login back on later.`, { confirmLabel: 'Switch off' })) return;
    await save({ member: { id: m.id, active: on } }, on ? `${m.name} can sign in again` : `${m.name}'s login is off`);
  }

  function update() {
    const owner = isOwner();
    const team = state.team || [];
    const boss = ownerOf();
    fill(body,
      owner ? null : el('p', { class: 'set-team-note', dataset: { readonly: '' } }, icon('lock', 14), `${boss?.name || 'The owner'} manages the team. Ask ${boss?.name || 'them'} to add someone or reset a PIN.`),
      team.length ? el('ul', { class: 'set-team-list' }, team.map((m, i) => {
        const self = m.id === meId();
        return el('li', { class: `set-person${m.active === false ? ' is-off' : ''}`, dataset: { member: m.id } },
          ownerBadge(m.id, { size: 'lg', title: false }),
          el('div', { class: 'set-person-main' },
            el('strong', {}, m.name, self ? el('span', { class: 'muted' }, ' (you)') : null),
            el('span', { class: 'small muted' }, [m.role === 'owner' ? 'Owner' : 'Member', m.active === false ? 'Login switched off' : m.can_sign_in ? 'Can sign in' : 'No login, can be given work'].join(' · '))),
          owner ? el('div', { class: 'set-person-acts' },
            el('button', { type: 'button', class: 'icon-btn sm', 'aria-label': `Move ${m.name} up`, disabled: i === 0 || null, dataset: { act: 'up' }, onClick: () => move(m, -1) }, el('span', { class: 'dl-rot' }, icon('chevron', 15))),
            el('button', { type: 'button', class: 'icon-btn sm', 'aria-label': `Move ${m.name} down`, disabled: i === team.length - 1 || null, dataset: { act: 'down' }, onClick: () => move(m, 1) }, el('span', { class: 'dl-rot is-down' }, icon('chevron', 15))),
            el('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { act: 'edit' }, onClick: () => editPerson(m) }, icon('edit', 13), 'Rename'),
            self ? null : el('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { act: 'reset-pin' }, onClick: () => resetPin(m) }, icon('lock', 13), m.can_sign_in ? 'Reset PIN' : 'Give a login'),
            m.role === 'owner' || !m.can_sign_in ? null : m.active === false
              ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { act: 'login-on' }, onClick: () => setActive(m, true) }, 'Switch login on')
              : el('button', { type: 'button', class: 'btn btn-ghost btn-sm is-danger', dataset: { act: 'login-off' }, onClick: () => setActive(m, false) }, 'Switch login off')) : null);
      })) : el('p', { class: 'small muted' }, 'Loading the team…'),
      owner ? el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn btn-ghost', dataset: { act: 'add-person' }, onClick: addPerson }, icon('plus', 15), 'Add a person')) : null);
  }
  update();
  const node = group('Team', 'Who is on the team', 'Everyone sees the same hub. What changes is what it puts in front of each person: their tasks, their replies, their next steps.', body);
  node.dataset.sec = 'team';
  let lastKey = '';
  return {
    node,
    update() {
      const key = JSON.stringify([state.me?.id, state.me?.role, (state.team || []).map((m) => [m.id, m.name, m.initials, m.sort, m.active, m.can_sign_in])]);
      if (key === lastKey || body.contains(document.activeElement) && document.activeElement.matches('input')) return;
      lastKey = key;
      update();
    }
  };
}

/** A small modal with a form; resolves the values or null. */
function modal2(title, body, confirmLabel) {
  return import('../ui.js?v=20261118d').then(({ modal }) => modal({ title, body, confirmLabel }));
}
/** Show a PIN the owner just set, once. */
function showOnce(name, pin) {
  return import('../ui.js?v=20261118d').then(({ modal }) => modal({
    title: `${name}'s PIN`, hideConfirm: true, cancelLabel: 'Done',
    body: el('div', { class: 'stack' },
      el('p', {}, `Tell ${name} this PIN in person. It is not shown again.`),
      el('p', { class: 'set-pin-once tnum', dataset: { pinOnce: '' } }, pin),
      el('p', { class: 'small muted' }, 'They can change it in Settings, under Your sign-in, after they sign in.'))
  }));
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

/* ===================================================== business helpers */
const pct = (v) => (v === null || v === undefined || v === '' ? '' : String(Math.round(Number(v) * 10000) / 100));
/** "12345678901" → "12 345 678 901"; anything else is returned trimmed. */
export function formatAbn(v) {
  const d = String(v || '').replace(/\s/g, '');
  return /^\d{11}$/.test(d) ? `${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}` : String(v || '').trim();
}

/* ================================================= HQ console import
   The old console (/admin) keeps one JSON object: {meta, settings, clients, deals,
   projects, tasks, income, expenses, subscriptions, outputs, library} with ids like
   "c_1a2b3c4d" and camelCase links (clientId, projectId). Its Settings page exports
   that object as plain JSON, or sealed in an envelope {v, kdf, iterations, salt, iv, ct}.
   Everything below up to importTool() is pure, and unit-tested. */

export const HQ_MARK = 'Imported from the old HQ console';
const refLine = (id) => `${HQ_MARK} (ref ${id})`;
const REF_RE = /Imported from the old HQ console \(ref ([\w-]+)\)/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const date = (v) => (ISO.test(String(v || '').slice(0, 10)) ? String(v).slice(0, 10) : null);
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const amt = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const joinNotes = (...parts) => parts.map(str).filter(Boolean).join('\n\n') || null;
const lower = (v) => str(v).toLowerCase();

export const HQ_CLIENT_STATUS = { active: 'active', building: 'active', 'pro-bono': 'active', paused: 'paused', prospect: 'paused', past: 'past' };
export const HQ_DEAL_STAGE = { lead: 'qualified', qualified: 'qualified', proposal: 'proposal', won: 'won', lost: 'lost' };
export const HQ_PROJECT_STATUS = { active: 'active', planned: 'planned', blocked: 'waiting', shipped: 'done', archived: 'done' };
export const HQ_INCOME_STATUS = { paid: 'paid', invoiced: 'invoiced', unbilled: 'draft' };
export const HQ_COST_CATEGORY = {
  'ai / tooling': 'software', 'cloud / email': 'software', 'domain / hosting': 'hosting', 'software / marketing': 'marketing',
  'hardware / asset': 'equipment', 'finance repayment': 'finance', 'govt / registration': 'government', other: 'other'
};
const TASK_STATES = ['todo', 'doing', 'review', 'blocked', 'done'];
const PRIORITIES = ['low', 'medium', 'high'];
const LIB_KINDS = ['playbook', 'standard', 'knowledge', 'research', 'brand', 'template', 'case_study', 'other'];
const OUTPUT_KIND = { runbook: 'playbook', report: 'other', proposal: 'template', contract: 'template', deliverable: 'other', demo: 'other', invoice: 'other', other: 'other' };
const cap = (s) => str(s).replace(/^\w/, (m) => m.toUpperCase());

/** Is this the encrypted backup envelope rather than the plain export? */
export const isHqEnvelope = (raw) => Boolean(raw && typeof raw === 'object' && raw.ct && raw.iv && raw.salt);

/** Validate and normalise the parsed file. → {data} or {error}. */
export function readHqExport(raw) {
  if (isHqEnvelope(raw)) return { error: 'encrypted' };
  const keys = ['clients', 'deals', 'projects', 'tasks', 'income', 'expenses', 'subscriptions', 'outputs', 'library'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !keys.some((k) => Array.isArray(raw[k]))) return { error: 'shape' };
  const data = { settings: raw.settings || {}, meta: raw.meta || {} };
  for (const k of keys) data[k] = Array.isArray(raw[k]) ? raw[k].filter((r) => r && typeof r === 'object') : [];
  return { data };
}

/** One old record → one new row (without its link ids, which are resolved at insert time). */
export const mapHq = {
  client(c) {
    return {
      row: {
        name: str(c.name) || 'Unnamed client', contact_name: str(c.contact) || null, email: str(c.email) || null,
        suburb: str(c.location) || null, status: HQ_CLIENT_STATUS[lower(c.status)] || 'active',
        monthly_value: Math.max(0, amt(c.mrr)), started_on: date(c.started),
        notes: joinNotes(c.notes, c.code ? `Client ID ${str(c.code)}` : '', lower(c.status) === 'prospect' ? 'Was a prospect in the old console.' : '', refLine(c.id)),
        tags: ['hq-import', ...(lower(c.status) === 'prospect' ? ['prospect'] : [])],
        archived: Boolean(c.archived)
      },
      links: {}
    };
  },
  deal(d) {
    const stage = HQ_DEAL_STAGE[lower(d.stage)] || 'qualified';
    const p = Number(d.probability);
    return {
      row: {
        title: str(d.name) || 'Untitled deal', stage, value: Math.max(0, amt(d.value)),
        probability: Number.isFinite(p) && str(d.probability) !== '' ? Math.min(100, Math.max(0, Math.round(p))) : (stage === 'won' ? 100 : stage === 'lost' ? 0 : 30),
        next_step: str(d.nextAction) || null, next_step_on: ['won', 'lost'].includes(stage) ? null : date(d.due),
        closed_on: ['won', 'lost'].includes(stage) ? date(d.due) : null,
        notes: joinNotes(d.notes, refLine(d.id)), archived: Boolean(d.archived)
      },
      links: { client_id: d.clientId || null }
    };
  },
  project(p) {
    return {
      row: {
        name: str(p.name) || 'Untitled project', status: HQ_PROJECT_STATUS[lower(p.status)] || 'active',
        started_on: date(p.start), due_on: date(p.due), description: joinNotes(p.notes, refLine(p.id)),
        archived: Boolean(p.archived) || lower(p.status) === 'archived'
      },
      links: { client_id: p.clientId || null }
    };
  },
  task(t) {
    const st = TASK_STATES.includes(lower(t.status)) ? lower(t.status) : 'todo';
    return {
      row: {
        title: str(t.title) || 'Untitled task', state: st, priority: PRIORITIES.includes(lower(t.priority)) ? lower(t.priority) : 'medium',
        due_on: date(t.due), done_at: st === 'done' ? `${date(t.due) || date(t.archivedAt) || new Date().toISOString().slice(0, 10)}T00:00:00Z` : null,
        notes: joinNotes(t.notes, refLine(t.id))
      },
      links: { project_id: t.projectId || null, client_id: t.clientId || null }
    };
  },
  income(i) {
    const status = HQ_INCOME_STATUS[lower(i.status)] || 'invoiced';
    const type = lower(i.type) || 'other';
    return {
      row: {
        description: [cap(type), str(i.client) && !i.clientId ? str(i.client) : ''].filter(Boolean).join(' · ') || 'Income',
        amount: Math.max(0, amt(i.amount)), gst: 0, kind: type === 'retainer' ? 'retainer' : 'one_off', status,
        invoice_no: str(i.invoice) || null, issued_on: date(i.date), due_on: date(i.due), paid_on: status === 'paid' ? date(i.date) : null,
        notes: joinNotes(i.notes, i.paidVia ? `Paid via ${str(i.paidVia)}` : '', refLine(i.id))
      },
      links: { client_id: i.clientId || null }
    };
  },
  expense(x) {
    return {
      row: {
        name: str(x.item) || 'Expense', vendor: str(x.vendor) || null, category: HQ_COST_CATEGORY[lower(x.category)] || 'other',
        amount: Math.max(0, amt(x.amount)), cadence: 'one_off', incurred_on: date(x.date), active: true,
        notes: joinNotes(x.notes, x.paidVia ? `Paid via ${str(x.paidVia)}` : '', x.deductible ? `Deductible: ${str(x.deductible)}` : '', refLine(x.id))
      },
      links: {}
    };
  },
  subscription(x) {
    const cycle = lower(x.cycle) || 'monthly';
    const a = Math.max(0, amt(x.amount));
    const conv = cycle === 'quarterly' ? { cadence: 'monthly', amount: Math.round((a / 3) * 100) / 100, note: `Was ${money(a)} a quarter, shown as a monthly cost.` }
      : cycle === 'weekly' ? { cadence: 'monthly', amount: Math.round(((a * 52) / 12) * 100) / 100, note: `Was ${money(a)} a week, shown as a monthly cost.` }
        : { cadence: ['yearly', 'annual'].includes(cycle) ? 'yearly' : 'monthly', amount: a, note: '' };
    return {
      row: {
        name: str(x.item) || 'Subscription', vendor: str(x.vendor) || null, category: HQ_COST_CATEGORY[lower(x.category)] || 'software',
        amount: conv.amount, cadence: conv.cadence, next_due: date(x.nextDue), active: lower(x.status || 'active') !== 'cancelled',
        notes: joinNotes(x.notes, conv.note, x.paidVia ? `Paid via ${str(x.paidVia)}` : '', refLine(x.id))
      },
      links: {}
    };
  },
  library(e) {
    const path = str(e.path);
    const url = /^https?:\/\/\S+$/i.test(path) ? path : null;
    const tags = String(Array.isArray(e.tags) ? e.tags.join(',') : e.tags || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    return {
      row: {
        title: str(e.title) || 'Untitled', kind: LIB_KINDS.includes(lower(e.kind)) ? lower(e.kind) : 'other',
        body: joinNotes(e.notes, path && !url ? `Where it lives: ${path}` : '', refLine(e.id)), url,
        tags: [...new Set([...tags, 'hq-import'])], archived: Boolean(e.archived)
      },
      links: {}
    };
  },
  output(o) {
    const path = str(o.path);
    const url = /^https?:\/\/\S+$/i.test(path) ? path : null;
    return {
      row: {
        title: str(o.title) || 'Untitled', kind: OUTPUT_KIND[lower(o.kind)] || 'other',
        body: joinNotes(o.notes, `${cap(o.kind || 'output')} from the old console${o.status ? `, ${lower(o.status)}` : ''}${date(o.date) ? `, ${date(o.date)}` : ''}.`, path && !url ? `Where it lives: ${path}` : '', refLine(o.id)),
        url, tags: ['hq-import', 'output'], archived: Boolean(o.archived)
      },
      links: { client_id: o.clientId || null }
    };
  }
};

/** Import order: parents before children, so links resolve. */
export const HQ_STEPS = [
  { key: 'clients', from: 'clients', table: 'clients', map: 'client', label: 'Clients', name: 'name' },
  { key: 'deals', from: 'deals', table: 'deals', map: 'deal', label: 'Deals', name: 'title' },
  { key: 'projects', from: 'projects', table: 'projects', map: 'project', label: 'Projects', name: 'name' },
  { key: 'tasks', from: 'tasks', table: 'tasks', map: 'task', label: 'Tasks', name: 'title' },
  { key: 'income', from: 'income', table: 'income', map: 'income', label: 'Income', name: null },
  { key: 'expenses', from: 'expenses', table: 'costs', map: 'expense', label: 'Expenses → Costs', name: 'name' },
  { key: 'subscriptions', from: 'subscriptions', table: 'costs', map: 'subscription', label: 'Subscriptions → Costs', name: 'name' },
  { key: 'library', from: 'library', table: 'library', map: 'library', label: 'Library', name: 'title' },
  { key: 'outputs', from: 'outputs', table: 'library', map: 'output', label: 'Outputs → Library', name: 'title' }
];
const NOTE_FIELD = { clients: 'notes', deals: 'notes', projects: 'description', tasks: 'notes', income: 'notes', costs: 'notes', library: 'body' };

/** Old ids already imported, from the marker line: → Map(oldId → {table, id}). */
export function priorHqRefs(existing) {
  const out = new Map();
  for (const [table, f] of Object.entries(NOTE_FIELD)) {
    for (const r of existing[table] || []) {
      const m = REF_RE.exec(r[f] || '');
      if (m) out.set(m[1], { table, id: r.id });
    }
  }
  return out;
}

/** A key for "the same record" when skipping duplicates by name. */
function dupKey(step, row) {
  if (step.table === 'income') return row.invoice_no ? `inv:${lower(row.invoice_no)}` : `amt:${row.amount}:${row.issued_on || ''}:${lower(row.description)}`;
  if (step.table === 'tasks') return null; // tasks repeat by name across projects; only the ref marker counts
  return lower(row[step.name]);
}
function existingKeys(step, rows) {
  const m = new Map();
  for (const r of rows || []) {
    const k = dupKey(step, r);
    if (k && !m.has(k)) m.set(k, r.id);
  }
  return m;
}

/**
 * Work out exactly what an import would do.
 * existing: {clients, deals, projects, tasks, income, costs, library} (rows already in the hub).
 * opts: {includeArchived = true, skipDuplicates = true}
 * → {steps:[{key,label,table,found,archived,toImport,already,dupes}], items:[{step,ref,row,links,reuse?}], notes:[], previous:n}
 * An item with `reuse` is not inserted; its old id simply maps onto the existing row.
 */
export function planHqImport(data, existing = {}, { includeArchived = true, skipDuplicates = true } = {}) {
  const prior = priorHqRefs(existing);
  const items = [];
  const steps = [];
  const notes = [];
  const seenNames = {};
  for (const step of HQ_STEPS) {
    const rows = data[step.from] || [];
    const keys = existingKeys(step, existing[step.table]);
    seenNames[step.table] ||= new Map();
    const s = { key: step.key, label: step.label, table: step.table, found: rows.length, archived: 0, toImport: 0, already: 0, dupes: 0, skipped: 0 };
    for (const old of rows) {
      const isArchived = Boolean(old.archived);
      if (isArchived) s.archived++;
      const ref = str(old.id) || null;
      if (ref && prior.has(ref)) { s.already++; items.push({ step: step.key, table: step.table, ref, reuse: prior.get(ref).id }); continue; }
      if (isArchived && !includeArchived) { s.skipped++; continue; }
      if (step.key === 'income' && Number(old.amount) < 0) { s.skipped++; notes.push(`An income row of ${money(old.amount)} is negative and was left out.`); continue; }
      const mapped = mapHq[step.map](old);
      const k = dupKey(step, mapped.row);
      if (skipDuplicates && k && (keys.has(k) || seenNames[step.table].has(k))) {
        s.dupes++;
        items.push({ step: step.key, table: step.table, ref, reuse: keys.get(k) || null, sameAs: keys.has(k) ? null : seenNames[step.table].get(k) });
        continue;
      }
      if (k) seenNames[step.table].set(k, ref);
      s.toImport++;
      items.push({ step: step.key, table: step.table, ref, row: mapped.row, links: mapped.links });
    }
    steps.push(s);
  }
  const prospects = (data.clients || []).filter((c) => lower(c.status) === 'prospect').length;
  if (prospects) notes.push(`${plural(prospects, 'prospect')} become${prospects === 1 ? 's a paused client' : ' paused clients'} tagged “prospect”. The hub tracks prospects as leads or deals, so move them over when you next talk.`);
  const odd = (data.subscriptions || []).filter((x) => ['quarterly', 'weekly'].includes(lower(x.cycle))).length;
  if (odd) notes.push(`${plural(odd, 'subscription')} billed quarterly or weekly ${odd === 1 ? 'is' : 'are'} shown as a monthly cost (the note on each keeps the original amount).`);
  const unbilled = (data.income || []).filter((i) => lower(i.status) === 'unbilled').length;
  if (unbilled) notes.push(`${plural(unbilled, 'unbilled income row')} come${unbilled === 1 ? 's' : ''} in as draft invoices.`);
  if ((data.outputs || []).length) notes.push('Outputs (proposals, contracts, runbooks and so on) become library entries tagged “output”: the new Proposals section starts fresh.');
  if ((data.tasks || []).some((t) => t.archived)) notes.push('Tasks have no archive in the hub: archived tasks you import come in as they were.');
  if (data.settings && (data.settings.quitLine || data.settings.quitLine === 0)) notes.push(`The old quit line (${money(data.settings.quitLine)} a month) is not copied. Set “Monthly take-home needed” under Business above.`);
  const dangling = (data.deals || []).concat(data.projects || [], data.tasks || [], data.income || [], data.outputs || [])
    .filter((r) => (r.clientId && !(data.clients || []).some((c) => c.id === r.clientId)) || (r.projectId && !(data.projects || []).some((p) => p.id === r.projectId))).length;
  if (dangling) notes.push(`${plural(dangling, 'record')} point${dangling === 1 ? 's' : ''} at a client or project that is not in the file; ${dangling === 1 ? 'it comes' : 'they come'} in unlinked.`);
  const previous = [...prior.keys()].length;
  return { steps, items, notes, previous };
}

/**
 * Carry out a plan. save(table, row) → saved row (saveRow in the app).
 * Old ids are mapped to new ids as each row lands, so links are kept.
 * → {inserted: {table: n}, idMap: Map, errors: [msg]}
 */
export async function runHqImport(plan, save, onProgress) {
  const idMap = new Map();
  const inserted = {};
  const errors = [];
  let done = 0;
  const total = plan.items.filter((i) => i.row).length;
  for (const it of plan.items) {
    if (!it.row) {
      const to = it.reuse || (it.sameAs ? idMap.get(it.sameAs) : null);
      if (it.ref && to) idMap.set(it.ref, to);
      continue;
    }
    const row = { ...it.row };
    for (const [k, old] of Object.entries(it.links || {})) row[k] = old ? (idMap.get(old) || null) : null;
    try {
      const saved = await save(it.table, row);
      if (it.ref) idMap.set(it.ref, saved.id);
      inserted[it.table] = (inserted[it.table] || 0) + 1;
    } catch (e) {
      errors.push(`${it.table}: ${row.name || row.title || row.description || it.ref}: ${e.message}`);
    }
    done++;
    onProgress?.(done, total);
  }
  return { inserted, idMap, errors };
}

/* ------------------------------------------------------- the tool (UI) */
function importTool() {
  const box = el('div', { class: 'imp stack' });
  let data = null;
  let fileName = '';
  const opts = { includeArchived: true, skipDuplicates: true };
  const existing = () => ({ clients: state.clients, deals: state.deals, projects: state.projects, tasks: state.tasks, income: state.income, costs: state.costs, library: state.library });

  const fileIn = el('input', { type: 'file', accept: '.json,application/json', class: 'imp-file', id: 'hq-import-file', 'aria-label': 'Old HQ console export (JSON)' });
  fileIn.addEventListener('change', async () => {
    const file = fileIn.files?.[0];
    if (!file) return;
    fileName = file.name;
    let raw;
    try { raw = JSON.parse(await file.text()); } catch { data = null; drawStart('That file is not valid JSON. Export it again from the old console.'); return; }
    const res = readHqExport(raw);
    if (res.error === 'encrypted') { data = null; drawStart('This is the encrypted backup. Open the old console, unlock it, and use Settings → Plain JSON export, then pick that file here.'); return; }
    if (res.error) { data = null; drawStart('That file does not look like an export from the old HQ console.'); return; }
    data = res.data;
    drawPreview();
  });

  function drawStart(err) {
    fileIn.value = '';
    fill(box, 
      el('div', { class: 'imp-drop' },
        el('ol', { class: 'set-steps' },
          el('li', {}, 'Open the old console at ', el('a', { href: '../admin/', target: '_blank', rel: 'noopener' }, '/admin'), ' and unlock it.'),
          el('li', {}, 'In its Settings, choose ', el('strong', {}, 'Plain JSON export'), '. An encrypted backup will not work here: export it as plain JSON first.'),
          el('li', {}, 'Pick that file below. You see exactly what will come across before anything is saved.')),
        el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Export file'), fileIn),
        err ? el('div', { class: 'callout is-warn', role: 'alert' }, icon('alert', 16), el('span', {}, err)) : null,
        el('p', { class: 'small muted' }, 'The file stays on this device and is read in the browser. Delete it once the import is done: it is not encrypted.')));
  }

  function drawPreview() {
    const plan = planHqImport(data, existing(), opts);
    const total = plan.steps.reduce((t, s) => t + s.toImport, 0);
    const box1 = el('input', { type: 'checkbox', class: 'check', name: 'imp-archived', checked: opts.includeArchived || null, onChange: (e) => { opts.includeArchived = e.target.checked; drawPreview(); } });
    const box2 = el('input', { type: 'checkbox', class: 'check', name: 'imp-dupes', checked: opts.skipDuplicates || null, onChange: (e) => { opts.skipDuplicates = e.target.checked; drawPreview(); } });
    const go = el('button', { type: 'button', class: 'btn btn-primary', disabled: !total || null, dataset: { act: 'import' } }, icon('upload', 15), total ? `Import ${plural(total, 'record')}` : 'Nothing new to import');
    const progress = el('p', { class: 'small muted', role: 'status' });
    go.addEventListener('click', async () => {
      const ok = await confirmDialog('Import from the old console?', `${plural(total, 'record')} will be added to the hub. Records already imported are skipped, so running it again is safe.`, { confirmLabel: 'Import', danger: false });
      if (!ok) return;
      await busy(go, async () => {
        const fresh = planHqImport(data, existing(), opts);
        const res = await runHqImport(fresh, saveRow, (d, t) => { progress.textContent = `Saving ${d} of ${t}…`; });
        drawDone(res);
      });
    });
    fill(box, 
      el('p', { class: 'small muted' }, `From ${fileName || 'the export'}${data.meta?.updated ? `, last updated ${data.meta.updated}` : ''}.`),
      plan.previous ? el('div', { class: 'callout is-info', dataset: { imp: 'previous' } }, icon('alert', 16),
        el('span', {}, `An earlier import is already here (${plural(plan.previous, 'record')}). Those records are skipped, so nothing comes across twice.`)) : null,
      el('div', { class: 'table-wrap' }, el('table', { class: 'table imp-table' },
        el('thead', {}, el('tr', {}, el('th', {}, 'From the old console'), el('th', { class: 'num' }, 'In file'), el('th', { class: 'num' }, 'Will import'), el('th', {}, 'Skipped'))),
        el('tbody', {}, plan.steps.filter((s) => s.found).map((s) => el('tr', { dataset: { step: s.key } },
          el('td', {}, s.label), el('td', { class: 'num' }, num(s.found)), el('td', { class: 'num', dataset: { n: 'import' } }, num(s.toImport)),
          el('td', { class: 'small muted' }, [s.already ? `${s.already} imported before` : '', s.dupes ? `${s.dupes} already in the hub by name` : '', s.skipped ? `${s.skipped} archived or not usable` : ''].filter(Boolean).join(' · ') || '–')))))),
      el('div', { class: 'imp-opts' },
        el('label', {}, box1, el('span', {}, 'Include archived records (they come in archived)')),
        el('label', {}, box2, el('span', {}, 'Skip anything already in the hub with the same name (links still point at the existing record)'))),
      plan.notes.length ? el('div', { class: 'stack tight' }, el('span', { class: 'field-label' }, 'Worth knowing'), el('ul', { class: 'imp-notes' }, plan.notes.map((n) => el('li', {}, n)))) : null,
      el('div', { class: 'row' }, go, el('button', { type: 'button', class: 'btn btn-ghost', onClick: () => { data = null; drawStart(); } }, 'Choose another file')),
      progress);
  }

  function drawDone(res) {
    const n = Object.values(res.inserted).reduce((t, v) => t + v, 0);
    fill(box, 
      el('div', { class: `callout ${res.errors.length ? 'is-warn' : 'is-ok'}`, role: 'status', dataset: { imp: 'done' } }, icon(res.errors.length ? 'alert' : 'check', 16),
        el('span', {}, `Imported ${plural(n, 'record')}${Object.keys(res.inserted).length ? ` (${Object.entries(res.inserted).map(([t, v]) => `${v} ${t.replace('_', ' ')}`).join(', ')})` : ''}.${res.errors.length ? ` ${plural(res.errors.length, 'record')} could not be saved.` : ' The old console can now be retired.'}`)),
      res.errors.length ? el('ul', { class: 'imp-notes' }, res.errors.slice(0, 20).map((e) => el('li', {}, e))) : null,
      el('div', { class: 'row' },
        el('a', { class: 'btn btn-ghost btn-sm', href: '#clients' }, 'Clients'), el('a', { class: 'btn btn-ghost btn-sm', href: '#pipeline' }, 'Pipeline'),
        el('a', { class: 'btn btn-ghost btn-sm', href: '#income' }, 'Income'), el('a', { class: 'btn btn-ghost btn-sm', href: '#library' }, 'Library'),
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => { data = null; drawStart(); } }, 'Import another file')));
  }

  drawStart();
  return box;
}

/* ===================================================== AI usage helpers */
export const AI_TASK_LABEL = { hook: 'Personal lines', reply: 'Replies', proposal: 'Proposals', roi_summary: 'ROI write-ups' };
/** US dollars to the cent; a tiny non-zero amount reads "under 1 cent". */
export function usd(n) {
  const v = Number(n) || 0;
  if (v > 0 && v < 0.005) return 'under 1 cent';
  return `US$${v.toFixed(2)}`;
}
/** ai_usage rows → {rows:[{task,count,cost}], count, cost}, most expensive first. */
export function summariseAiUsage(rows) {
  const by = new Map();
  for (const r of rows) {
    const t = r.task || 'other';
    const cur = by.get(t) || { task: t, count: 0, cost: 0 };
    cur.count += 1;
    cur.cost += Number(r.cost_usd) || 0;
    by.set(t, cur);
  }
  const list = [...by.values()].sort((a, b) => b.cost - a.cost || b.count - a.count);
  return { rows: list, count: list.reduce((t, r) => t + r.count, 0), cost: list.reduce((t, r) => t + r.cost, 0) };
}
