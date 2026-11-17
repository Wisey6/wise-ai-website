// Leads: the CRM. Table + board, filters, bulk actions, CSV import, lead drawer.
import {
  el, $, $$, clear, fill, icon, badge, statusBadge, toast, modal, confirmDialog, field, input, select, textarea,
  timeAgo, dateTime, dayLabel, go, copyText, STATUSES, STATUS, prettyPhone, num, plural, money, busy, trapFocus,
  emptyState, downloadFile, toCsv
} from '../ui.js?v=20261118a';
import {
  state, saveLead, saveLeads, addLeads, deleteLead, logEvent, addMessage, suppress, messagesFor, onMessage, onChange,
  normalisePhone, isAuMobile, leadName, leadById, campaignById, isSuppressed, formatValue, composeSms
} from '../api.js?v=20261118a';

/* ------------------------------------------------------------ view state */
const VIEW_KEY = 'wiseos.leads.view';
const ui = {
  q: '',
  status: 'all',
  campaign: '',
  source: '',
  special: '', // '' | 'needs-hook' | 'no-source' | 'unread' | 'archived' | 'batch'
  sort: 'recent',
  mode: (() => { try { return localStorage.getItem(VIEW_KEY) || 'table'; } catch { return 'table'; } })(),
  limit: 150,
  selected: new Set(),
  batchIds: null
};

const SOURCES = [
  { id: 'import', label: 'Imported' }, { id: 'manual', label: 'Added by hand' }, { id: 'website', label: 'Website' },
  { id: 'booking', label: 'Booking' }, { id: 'inbound_sms', label: 'Texted in' }
];
const SOURCE_LABEL = Object.fromEntries(SOURCES.map((s) => [s.id, s.label]));
const isFresh = (l) => l.status === 'new' || l.status === 'queued';
const needsHook = (l) => !l.archived && isFresh(l) && !(l.hook || '').trim() && isAuMobile(l.phone) && !isSuppressed(l.phone);
const noSource = (l) => !l.archived && isFresh(l) && (l.source === 'import' || l.source === 'manual') && !l.number_source_url && !l.last_reply_at;
const safeHref = (u) => {
  const s = String(u || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/i.test(s)) return `https://${s}`;
  return null;
};
const lastActivity = (l) => [l.last_reply_at, l.last_contacted_at, l.updated_at].filter(Boolean).sort().pop();

/* ------------------------------------------------------------- filtering */
function matches(l) {
  if (ui.special === 'archived') { if (!l.archived) return false; } else if (l.archived) return false;
  if (ui.special === 'needs-hook' && !needsHook(l)) return false;
  if (ui.special === 'no-source' && !noSource(l)) return false;
  if (ui.special === 'unread' && !l.unread) return false;
  if (ui.special === 'batch' && !(ui.batchIds && ui.batchIds.has(l.id))) return false;
  if (ui.status !== 'all' && l.status !== ui.status) return false;
  if (ui.campaign === 'none' ? l.campaign_id : ui.campaign && l.campaign_id !== ui.campaign) return false;
  if (ui.source && l.source !== ui.source) return false;
  if (ui.q) {
    const q = ui.q.toLowerCase();
    const digits = q.replace(/\D/g, '');
    const hay = [l.business, l.contact_name, l.email, l.suburb, l.industry, l.notes, l.hook, (l.tags || []).join(' ')].join(' ').toLowerCase();
    const phoneHit = digits.length >= 3 && (String(l.phone || '').includes(digits) || prettyPhone(l.phone).replace(/\D/g, '').includes(digits));
    if (!hay.includes(q) && !phoneHit) return false;
  }
  return true;
}

function sorted(list) {
  const by = {
    recent: (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
    activity: (a, b) => String(lastActivity(b)).localeCompare(String(lastActivity(a))),
    name: (a, b) => leadName(a).localeCompare(leadName(b)),
    value: (a, b) => (Number(b.est_monthly_value) || 0) - (Number(a.est_monthly_value) || 0),
    followup: (a, b) => String(a.next_followup_at || '9').localeCompare(String(b.next_followup_at || '9'))
  }[ui.sort];
  return [...list].sort((a, b) => (b.unread - a.unread) || by(a, b));
}

/* ================================================================ view */
export default function leadsView(ctx) {
  const { state: st, param } = ctx;
  const root = el('div', { class: 'page leads-page' });

  // Params: #leads/<id>, #leads/import, #leads/new, #leads/needs-hook, #leads/no-source, #leads/unread
  let deferred = null;
  if (param) {
    const p = param.replace(/^filter[=:]/, '');
    if (['needs-hook', 'no-source', 'unread', 'archived'].includes(p)) { ui.special = p; ui.status = 'all'; ui.selected.clear(); }
    else if (p === 'import') deferred = () => openImport();
    else if (p === 'new') deferred = () => openAddLead();
    else if (/^[0-9a-f-]{36}$/i.test(p)) deferred = () => openLead(p);
    if (deferred || ['needs-hook', 'no-source', 'unread', 'archived'].includes(p)) {
      if (!/^[0-9a-f-]{36}$/i.test(p)) history.replaceState(null, '', '#leads');
    }
  }

  const head = el('div', { class: 'page-head' },
    el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, 'CRM'), el('h1', { class: 'h1' }, 'Leads')),
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'btn btn-ghost', onClick: () => openImport() }, icon('upload', 16), 'Import CSV'),
      el('button', { type: 'button', class: 'btn btn-primary', onClick: () => openAddLead() }, icon('plus', 16), 'Add lead')));

  const search = input('q', { type: 'search', value: ui.q, placeholder: 'Search name, phone, suburb, tag…', 'aria-label': 'Search leads', autocomplete: 'off' });
  search.addEventListener('input', () => { ui.q = search.value.trim(); ui.limit = 150; paint(); });

  const campaignSel = el('select', { class: 'input sm', 'aria-label': 'Campaign' });
  const sourceSel = select('source', [{ id: '', label: 'All sources' }, ...SOURCES], ui.source);
  sourceSel.classList.add('sm');
  sourceSel.setAttribute('aria-label', 'Source');
  sourceSel.addEventListener('change', () => { ui.source = sourceSel.value; paint(); });
  campaignSel.addEventListener('change', () => { ui.campaign = campaignSel.value; paint(); });
  const sortSel = select('sort', [
    { id: 'recent', label: 'Newest first' }, { id: 'activity', label: 'Recent activity' }, { id: 'value', label: 'Highest value' },
    { id: 'followup', label: 'Follow-up due' }, { id: 'name', label: 'Name A–Z' }
  ], ui.sort);
  sortSel.classList.add('sm');
  sortSel.setAttribute('aria-label', 'Sort');
  sortSel.addEventListener('change', () => { ui.sort = sortSel.value; paint(); });

  const modeTabs = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Layout' });
  const drawModeTabs = () => {
    fill(modeTabs, 
      ...[['table', 'list', 'Table'], ['board', 'board', 'Board']].map(([id, ic, label]) => el('button', {
        type: 'button', class: `tab${ui.mode === id ? ' is-active' : ''}`, role: 'tab', 'aria-selected': String(ui.mode === id),
        onClick: () => { ui.mode = id; try { localStorage.setItem(VIEW_KEY, id); } catch { /* */ } drawModeTabs(); paint(); }
      }, icon(ic, 14), label)));
  };
  drawModeTabs();

  const toolbar = el('div', { class: 'leads-bar' },
    el('label', { class: 'search' }, icon('search', 16), search),
    campaignSel, sourceSel, sortSel, el('span', { class: 'spacer' }), modeTabs);

  const chips = el('div', { class: 'leads-chips', role: 'group', 'aria-label': 'Filter by status' });
  const bulk = el('div');
  const content = el('div');
  root.append(head, toolbar, chips, bulk, content);

  function drawCampaigns() {
    const opts = [{ id: '', label: 'All campaigns' }, ...st.campaigns.map((c) => ({ id: c.id, label: c.name })), { id: 'none', label: 'No campaign' }];
    const cur = ui.campaign;
    fill(campaignSel, ...opts.map((o) => el('option', { value: o.id }, o.label)));
    campaignSel.value = cur;
  }

  function drawChips() {
    const base = st.leads.filter((l) => !l.archived);
    const count = (fn) => base.filter(fn).length;
    const chip = (label, active, onClick, n, tone) => el('button', {
      type: 'button', class: `chip${active ? ' is-active' : ''}`, 'aria-pressed': String(active), onClick
    }, tone ? el('span', { class: 'dot', style: `background:${tone}` }) : null, label, n !== undefined ? el('span', { class: 'count' }, num(n)) : null);
    const setStatus = (s) => () => { ui.status = s; if (ui.special === 'archived' || ui.special === 'batch') ui.special = ''; ui.selected.clear(); paint(); };
    const setSpecial = (s) => () => { ui.special = ui.special === s ? '' : s; ui.selected.clear(); paint(); };
    const nh = count(needsHook);
    const ns = count(noSource);
    const unread = count((l) => l.unread);
    fill(chips, 
      chip('All', ui.status === 'all' && !ui.special, () => { ui.status = 'all'; ui.special = ''; ui.selected.clear(); paint(); }, base.length),
      ...STATUSES.map((s) => {
        const n = count((l) => l.status === s.id);
        return n || ui.status === s.id ? chip(s.label, ui.status === s.id, setStatus(s.id), n) : null;
      }),
      el('span', { style: 'width:6px' }),
      unread ? chip('Unread', ui.special === 'unread', setSpecial('unread'), unread, 'var(--rose)') : null,
      nh || ui.special === 'needs-hook' ? chip('Needs a personal line', ui.special === 'needs-hook', setSpecial('needs-hook'), nh, 'var(--violet)') : null,
      ns || ui.special === 'no-source' ? chip('No number source', ui.special === 'no-source', setSpecial('no-source'), ns, 'var(--amber)') : null,
      ui.special === 'batch' ? chip('Just imported', true, setSpecial('batch'), ui.batchIds?.size || 0, 'var(--up)') : null,
      st.leads.some((l) => l.archived) ? chip('Archived', ui.special === 'archived', setSpecial('archived'), st.leads.filter((l) => l.archived).length) : null);
  }

  function drawBulk(visible) {
    clear(bulk);
    for (const id of [...ui.selected]) if (!visible.some((l) => l.id === id)) ui.selected.delete(id);
    if (!ui.selected.size) return;
    const ids = [...ui.selected];
    const statusSel = select('bulk-status', [{ id: '', label: 'Set status…' }, ...STATUSES.filter((s) => s.id !== 'dnc').map((s) => ({ id: s.id, label: s.label }))], '');
    statusSel.classList.add('sm'); statusSel.style.width = 'auto'; statusSel.setAttribute('aria-label', 'Set status for selected');
    const campSel = select('bulk-campaign', [{ id: '', label: 'Assign campaign…' }, ...st.campaigns.map((c) => ({ id: c.id, label: c.name })), { id: 'none', label: 'No campaign' }], '');
    campSel.classList.add('sm'); campSel.style.width = 'auto'; campSel.setAttribute('aria-label', 'Assign campaign to selected');
    const run = async (patch, msg) => {
      try { await saveLeads(ids, patch); toast(msg); ui.selected.clear(); paint(); } catch (e) { toast(e.message, 'bad'); }
    };
    statusSel.addEventListener('change', () => statusSel.value && run({ status: statusSel.value }, `${plural(ids.length, 'lead')} set to ${STATUS[statusSel.value].label}`));
    campSel.addEventListener('change', () => campSel.value && run({ campaign_id: campSel.value === 'none' ? null : campSel.value }, `Campaign updated on ${plural(ids.length, 'lead')}`));
    const archived = ui.special === 'archived';
    bulk.append(el('div', { class: 'bulk-bar', role: 'region', 'aria-label': 'Bulk actions' },
      el('b', { class: 'bulk-count' }, `${num(ids.length)} selected`),
      statusSel, campSel,
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: (e) => busy(e.currentTarget, () => run({ status: 'queued' }, `${plural(ids.length, 'lead')} queued`)) }, icon('send', 13), 'Queue'),
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: (e) => busy(e.currentTarget, () => run({ archived: !archived }, archived ? 'Restored' : `${plural(ids.length, 'lead')} archived`)) }, icon('archive', 13), archived ? 'Restore' : 'Archive'),
      el('span', { class: 'spacer' }),
      el('button', { type: 'button', class: 'icon-btn sm', style: 'color:#fff', 'aria-label': 'Clear selection', onClick: () => { ui.selected.clear(); paint(); } }, icon('x', 16))));
  }

  function emptyFor(total) {
    if (!st.leads.length) {
      return el('div', { class: 'card' }, emptyState({
        icon: 'leads', title: 'No leads yet',
        text: 'Import a CSV from a directory or spreadsheet, or add someone by hand. Only Australian mobiles are kept for texting; we report what was dropped and why.',
        action: el('div', { class: 'row' },
          el('button', { type: 'button', class: 'btn btn-primary', onClick: () => openImport() }, icon('upload', 16), 'Import CSV'),
          el('button', { type: 'button', class: 'btn btn-ghost', onClick: () => openAddLead() }, icon('plus', 16), 'Add a lead'))
      }));
    }
    return el('div', { class: 'card' }, emptyState({
      icon: 'search', title: 'Nothing matches',
      text: total ? 'Try a different search or clear the filters.' : '',
      action: el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => { ui.q = ''; search.value = ''; ui.status = 'all'; ui.special = ''; ui.campaign = ''; ui.source = ''; campaignSel.value = ''; sourceSel.value = ''; paint(); } }, 'Clear filters')
    }));
  }

  /* ------------------------------------------------------------ table */
  function drawTable(list) {
    const shown = list.slice(0, ui.limit);
    const allChecked = shown.length > 0 && shown.every((l) => ui.selected.has(l.id));
    const headCheck = el('input', { type: 'checkbox', class: 'check', 'aria-label': 'Select all shown', checked: allChecked || null });
    headCheck.addEventListener('change', () => { shown.forEach((l) => (headCheck.checked ? ui.selected.add(l.id) : ui.selected.delete(l.id))); paint(); });

    const rowCheck = (l) => {
      const c = el('input', { type: 'checkbox', class: 'check', 'aria-label': `Select ${leadName(l)}`, checked: ui.selected.has(l.id) || null });
      c.addEventListener('click', (e) => e.stopPropagation());
      c.addEventListener('change', () => { if (c.checked) ui.selected.add(l.id); else ui.selected.delete(l.id); paint(); });
      return c;
    };
    const nameCell = (l) => el('button', { type: 'button', class: 'lead-name-btn lead-cell', onClick: (e) => { e.stopPropagation(); openLead(l.id); } },
      el('b', {}, l.unread ? el('span', { class: 'unread-dot', 'aria-label': 'Unread reply' }) : null, leadName(l)),
      el('span', {}, [l.business && l.contact_name ? l.contact_name : null, l.suburb, l.industry].filter(Boolean).join(' · ') || SOURCE_LABEL[l.source] || ''));
    const tick = (l) => ((l.hook || '').trim()
      ? el('span', { class: 'tick', title: 'Has a personal line', 'aria-label': 'Personalised' }, icon('check', 16))
      : el('span', { class: 'tick is-no', title: 'No personal line yet', 'aria-label': 'Not personalised' }, icon('x', 14)));

    const table = el('table', { class: 'table leads-table' },
      el('thead', {}, el('tr', {},
        el('th', { class: 'check-cell' }, headCheck), el('th', {}, 'Lead'), el('th', {}, 'Phone'), el('th', {}, 'Status'),
        el('th', { title: 'Has a personal line' }, 'Personal'), el('th', { class: 'num' }, 'Value/mo'), el('th', {}, 'Campaign'),
        el('th', {}, 'Last activity'), el('th', {}, 'Follow-up'))),
      el('tbody', {}, shown.map((l) => el('tr', { class: `is-click${ui.selected.has(l.id) ? ' is-selected' : ''}`, onClick: () => openLead(l.id), dataset: { id: l.id } },
        el('td', { class: 'check-cell' }, rowCheck(l)),
        el('td', {}, nameCell(l)),
        el('td', { class: 'phone-cell' }, l.phone ? prettyPhone(l.phone) : el('span', { class: 'faint' }, '—'),
          l.phone && !isAuMobile(l.phone) ? el('span', { class: 'faint small' }, ' (not mobile)') : null),
        el('td', {}, statusBadge(l.status)),
        el('td', {}, tick(l)),
        el('td', { class: 'num' }, l.est_monthly_value ? formatValue(l.est_monthly_value) : el('span', { class: 'faint' }, '—')),
        el('td', { class: 'small lead-camp-cell', title: campaignById(l.campaign_id)?.name || null }, campaignById(l.campaign_id)?.name || el('span', { class: 'faint' }, '—')),
        el('td', { class: 'small muted nowrap' }, timeAgo(lastActivity(l))),
        el('td', { class: 'small nowrap' }, l.next_followup_at
          ? el('span', { class: Date.parse(l.next_followup_at) <= Date.now() ? 'due' : null }, dayLabel(l.next_followup_at))
          : el('span', { class: 'faint' }, '—'))))));

    const mobile = el('div', { class: 'lead-mobile' }, shown.map((l) => el('div', { class: 'lead-card' },
      rowCheck(l),
      el('button', { type: 'button', class: 'lead-name-btn lead-cell', onClick: () => openLead(l.id) },
        el('b', {}, l.unread ? el('span', { class: 'unread-dot' }) : null, leadName(l)),
        el('span', {}, [prettyPhone(l.phone), l.suburb, (l.hook || '').trim() ? 'personalised' : null].filter(Boolean).join(' · '))),
      statusBadge(l.status))));

    return el('div', { class: 'card flush leads-table-card' },
      el('div', { class: 'table-wrap leads-table-wrap' }, table),
      mobile,
      list.length > shown.length ? el('div', { class: 'row', style: 'justify-content:center;padding:12px' },
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => { ui.limit += 300; paint(); } }, `Show more (${num(list.length - shown.length)})`)) : null);
  }

  /* ------------------------------------------------------------ board */
  function drawBoard(list) {
    const cols = ui.status === 'all' ? STATUSES : STATUSES.filter((s) => s.id === ui.status);
    let dragId = null;
    return el('div', { class: 'board', role: 'list', 'aria-label': 'Pipeline board' }, cols.map((s) => {
      const items = list.filter((l) => l.status === s.id);
      const col = el('div', { class: 'board-col', role: 'listitem', dataset: { status: s.id }, 'aria-label': `${s.label}: ${items.length}` },
        el('div', { class: 'board-head' }, statusBadge(s.id), el('span', { class: 'count' }, num(items.length))),
        items.length ? null : el('div', { class: 'board-empty' }, 'Drop a lead here'),
        items.slice(0, 60).map((l) => {
          const card = el('button', {
            type: 'button', class: 'board-card', draggable: 'true', dataset: { id: l.id },
            'aria-label': `${leadName(l)}, ${s.label}. Open`, onClick: () => openLead(l.id)
          },
            el('b', {}, l.unread ? el('span', { class: 'unread-dot' }) : null, leadName(l)),
            el('span', { class: 'meta' }, [l.suburb, l.industry].filter(Boolean).join(' · ') || prettyPhone(l.phone) || SOURCE_LABEL[l.source]),
            el('span', { class: 'meta' },
              (l.hook || '').trim() ? el('span', { class: 'tick', title: 'Personalised' }, icon('check', 13)) : null,
              l.est_monthly_value ? el('span', { class: 'val' }, `${formatValue(l.est_monthly_value)}/mo`) : null,
              el('span', {}, timeAgo(lastActivity(l)))));
          card.addEventListener('dragstart', (e) => { dragId = l.id; e.dataTransfer.setData('text/plain', l.id); e.dataTransfer.effectAllowed = 'move'; card.classList.add('is-dragging'); });
          card.addEventListener('dragend', () => card.classList.remove('is-dragging'));
          return card;
        }),
        items.length > 60 ? el('div', { class: 'board-more' }, `+${items.length - 60} more in the table`) : null);
      col.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; col.classList.add('is-over'); });
      col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('is-over'); });
      col.addEventListener('drop', async (e) => {
        e.preventDefault();
        col.classList.remove('is-over');
        const id = e.dataTransfer.getData('text/plain') || dragId;
        const lead = leadById(id);
        if (!lead || lead.status === s.id) return;
        await changeStatus(lead, s.id);
      });
      return col;
    }));
  }

  function paint() {
    drawCampaigns();
    drawChips();
    const all = st.leads.filter(matches);
    const list = sorted(all);
    drawBulk(list);
    clear(content);
    if (!list.length) { content.append(emptyFor(st.leads.length)); return; }
    content.append(ui.mode === 'board' ? drawBoard(list) : drawTable(list));
  }

  paint();
  root.onState = paint;
  if (deferred) setTimeout(deferred, 0);
  return root;
}

/* ===================================================== status changes */
async function changeStatus(lead, status) {
  if (status === 'dnc') return markDnc(lead);
  const prev = lead.status;
  const patch = { status };
  if (['lost', 'won', 'booked'].includes(status)) patch.next_followup_at = null;
  try {
    await saveLead(lead.id, patch);
    logEvent('status', lead.id, `${leadName(lead)}: ${STATUS[prev]?.label || prev} → ${STATUS[status].label}`).catch(() => {});
    toast(`${leadName(lead)} moved to ${STATUS[status].label}`);
  } catch (e) {
    toast(e.message, 'bad');
  }
}

async function markDnc(lead) {
  const ok = await confirmDialog('Mark as do not contact?',
    `${leadName(lead)} will never be texted again${lead.phone ? ` and ${prettyPhone(lead.phone)} goes on the suppression list (it stays there even if the lead is deleted)` : ''}.`,
    { confirmLabel: 'Do not contact', danger: true });
  if (!ok) return false;
  try {
    if (lead.phone) await suppress(lead.phone, 'manual');
    await saveLead(lead.id, { status: 'dnc', next_followup_at: null });
    logEvent('dnc', lead.id, `${leadName(lead)} marked do not contact`).catch(() => {});
    toast(`${leadName(lead)} will not be contacted`);
    return true;
  } catch (e) { toast(e.message, 'bad'); return false; }
}

/* ============================================================ add lead */
function leadFormFields(l = {}, { compact = false } = {}) {
  const camp = select('campaign_id', [{ id: '', label: 'No campaign' }, ...state.campaigns.map((c) => ({ id: c.id, label: c.name }))], l.campaign_id || (compact ? state.campaigns.find((c) => c.active)?.id || '' : ''));
  return el('div', { class: 'form-grid' },
    field('Business', input('business', { value: l.business || '', placeholder: 'Smith Plumbing', autocomplete: 'off' })),
    field('Contact name', input('contact_name', { value: l.contact_name || '', placeholder: 'Dave Smith', autocomplete: 'off' })),
    field('Mobile', input('phone', { type: 'tel', value: l.phone ? prettyPhone(l.phone) : '', placeholder: '0412 345 678', inputmode: 'tel', autocomplete: 'off' })),
    field('Email', input('email', { type: 'email', value: l.email || '', placeholder: 'dave@example.com.au', autocomplete: 'off' })),
    field('Suburb', input('suburb', { value: l.suburb || '', placeholder: 'Paddington' })),
    field('Industry', input('industry', { value: l.industry || '', placeholder: 'Plumbing' })),
    field('Website', input('website', { value: l.website || '', placeholder: 'smithplumbing.com.au' })),
    field('Campaign', camp),
    el('div', { class: 'full' }, field('Where the number is listed', input('number_source_url', { type: 'url', value: l.number_source_url || '', placeholder: 'https://www.google.com/maps/…' }), 'Evidence the number is publicly listed for business enquiries. Needed before a cold text.')),
    compact ? el('div', { class: 'full' }, field('Personal line', textarea('hook', l.hook || '', 'e.g. saw your reviews mention it is hard to get through on the phone'), 'One specific thing you noticed. It goes in the first text as {hook}.')) : null);
}

export async function openAddLead() {
  const values = await modal({ title: 'Add a lead', body: leadFormFields({}, { compact: true }), confirmLabel: 'Add lead', wide: true });
  if (!values) return;
  const phone = values.phone ? normalisePhone(values.phone) : null;
  if (values.phone && !phone) { toast(`"${values.phone}" doesn't look like a phone number`, 'bad'); return; }
  if (!values.business && !values.contact_name && !phone && !values.email) { toast('Add at least a name, phone or email', 'bad'); return; }
  if (phone && isSuppressed(phone)) { toast('That number is on the do-not-contact list', 'bad'); return; }
  try {
    const row = await saveLead(null, { ...values, phone, source: 'manual', status: 'new' });
    logEvent('lead_added', row.id, `Added ${leadName(row)} by hand`).catch(() => {});
    toast(phone && !isAuMobile(phone) ? 'Lead added. Note: not an AU mobile, so it cannot be texted' : 'Lead added', phone && !isAuMobile(phone) ? 'warn' : 'ok');
    openLead(row.id);
  } catch (e) { toast(e.message, 'bad'); }
}

/* ============================================================ CSV import */

/** Parse CSV/TSV text → {headers, rows: string[][]}. Handles quotes, CRLF, BOM. */
export function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const delim = [',', '\t', ';'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = []; let cell = ''; let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  const headers = (nonEmpty.shift() || []).map((h, i) => String(h).trim() || `Column ${i + 1}`);
  return { headers, rows: nonEmpty.map((r) => headers.map((_, i) => String(r[i] ?? '').trim())) };
}

/**
 * Classify a raw phone for import:
 * {kind:'mobile', phone} | {kind:'landline'} | {kind:'invalid'} | {kind:'overseas', phone} | {kind:'empty'}
 */
export function classifyPhone(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { kind: 'empty' };
  let p = s.replace(/[\s\-().]/g, '');
  if (/^4\d{8}$/.test(p)) p = `0${p}`; // spreadsheets drop the leading zero
  if (/^\+?610?4\d{8}$/.test(p)) p = `+61${p.replace(/^\+?610?/, '')}`;
  const n = normalisePhone(p);
  if (n && isAuMobile(n)) return { kind: 'mobile', phone: n };
  const d = p.replace(/^\+/, '');
  if (/^0[2378]\d{8}$/.test(d) || /^610?[2378]\d{8}$/.test(d) || /^(1300|1800)\d{6}$/.test(d) || /^13\d{4}$/.test(d)) return { kind: 'landline' };
  if (n && !n.startsWith('+61')) return { kind: 'overseas', phone: n };
  return { kind: 'invalid' };
}

const TARGETS = [
  { id: 'business', label: 'Business', syn: ['business', 'company', 'business name', 'name of business', 'organisation', 'organization', 'trading name', 'title'] },
  { id: 'contact_name', label: 'Contact name', syn: ['contact', 'contact name', 'name', 'full name', 'owner', 'first name', 'person'] },
  { id: 'phone', label: 'Phone', required: true, syn: ['phone', 'mobile', 'mobile number', 'phone number', 'cell', 'tel', 'telephone', 'number', 'contact number', 'ph'] },
  { id: 'email', label: 'Email', syn: ['email', 'e-mail', 'email address'] },
  { id: 'website', label: 'Website', syn: ['website', 'web', 'url', 'site', 'domain'] },
  { id: 'suburb', label: 'Suburb', syn: ['suburb', 'city', 'town', 'location', 'locality', 'area'] },
  { id: 'industry', label: 'Industry', syn: ['industry', 'category', 'trade', 'type', 'niche', 'sector'] },
  { id: 'number_source_url', label: 'Number source URL', syn: ['source url', 'number source', 'number_source_url', 'listing', 'listing url', 'source', 'google maps', 'maps url', 'profile'] },
  { id: 'hook', label: 'Personal line', syn: ['hook', 'personal line', 'observation', 'personal', 'opener', 'icebreaker'] },
  { id: 'pain', label: 'Pain', syn: ['pain', 'problem', 'pain point'] },
  { id: 'est_monthly_value', label: 'Value $/month', syn: ['value', 'est monthly value', 'est_monthly_value', 'monthly value', 'roi'] },
  { id: 'notes', label: 'Notes', syn: ['notes', 'note', 'comments', 'comment', 'description'] }
];

function guessMapping(headers) {
  const norm = (s) => s.toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  const H = headers.map(norm);
  const used = new Set();
  const map = {};
  for (const t of TARGETS) {
    let idx = H.findIndex((h, i) => !used.has(i) && (h === norm(t.id) || t.syn.includes(h)));
    if (idx < 0) idx = H.findIndex((h, i) => !used.has(i) && t.syn.some((s) => s.length > 3 && h.includes(s)));
    if (idx >= 0) { map[t.id] = idx; used.add(idx); }
  }
  return map;
}

/** Analyse parsed rows → {ready:[leadRows], dropped:[{row, reason}], counts}. */
export function analyseImport({ rows, map, batch }) {
  const existing = new Set(state.leads.map((l) => l.phone).filter(Boolean));
  const suppressed = new Set(state.suppressions.map((s) => s.phone));
  const seen = new Set();
  const counts = { total: rows.length, ready: 0, landline: 0, invalid: 0, overseas: 0, empty: 0, duplicate: 0, existing: 0, suppressed: 0, no_source: 0 };
  const ready = [];
  const dropped = [];
  const get = (r, k) => (map[k] === undefined || map[k] === '' ? '' : String(r[map[k]] ?? '').trim());
  for (const r of rows) {
    const c = classifyPhone(get(r, 'phone'));
    const drop = (reason, label) => { counts[reason]++; dropped.push({ row: r, reason, label }); };
    if (c.kind === 'empty') { drop('empty', 'No phone number'); continue; }
    if (c.kind === 'landline') { drop('landline', 'Landline'); continue; }
    if (c.kind === 'overseas') { drop('overseas', 'Not an Australian number'); continue; }
    if (c.kind === 'invalid') { drop('invalid', 'Not a valid number'); continue; }
    if (suppressed.has(c.phone)) { drop('suppressed', 'On the do-not-contact list'); continue; }
    if (seen.has(c.phone)) { drop('duplicate', 'Duplicate in this file'); continue; }
    if (existing.has(c.phone)) { drop('existing', 'Already in your leads'); continue; }
    const source = get(r, 'number_source_url') || batch.number_source_url || '';
    if (!source) { drop('no_source', 'No number source'); continue; }
    seen.add(c.phone);
    const value = get(r, 'est_monthly_value').replace(/[^0-9.]/g, '');
    ready.push({
      business: get(r, 'business'), contact_name: get(r, 'contact_name'), phone: c.phone, email: get(r, 'email'),
      website: get(r, 'website'), suburb: get(r, 'suburb'), industry: get(r, 'industry') || batch.industry || '',
      number_source_url: source, hook: get(r, 'hook'), pain: get(r, 'pain'), est_monthly_value: value ? Number(value) : null,
      notes: get(r, 'notes'), source: 'import', status: 'new', campaign_id: batch.campaign_id || null,
      tags: batch.tags || []
    });
  }
  counts.ready = ready.length;
  return { ready, dropped, counts };
}

/** A lightweight sheet with a custom footer (same look as modal()). */
function sheet(title, { wide = true } = {}) {
  const titleId = `sheet-${Math.random().toString(36).slice(2)}`;
  const body = el('div', { class: 'modal-body' });
  const foot = el('div', { class: 'modal-foot' });
  const h = el('h2', { class: 'h2', id: titleId }, title);
  const prevFocus = document.activeElement;
  let onClose = null;
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    backdrop.classList.add('is-leaving');
    setTimeout(() => backdrop.remove(), 160);
    prevFocus?.focus?.({ preventScroll: true });
    onClose?.();
  };
  const dialog = el('div', { class: `modal${wide ? ' is-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    el('div', { class: 'modal-head' }, h, el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onClick: close }, icon('x', 18))),
    body, foot);
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Tab') trapFocus(e, dialog);
  };
  const backdrop = el('div', { class: 'modal-backdrop', onMousedown: (e) => { if (e.target === backdrop) close(); } }, dialog);
  document.addEventListener('keydown', onKey, true);
  document.body.append(backdrop);
  return { body, foot, close, setTitle: (t) => { h.textContent = t; }, onClose: (fn) => { onClose = fn; } };
}

const SAMPLE_CSV = 'Business,Contact,Mobile,Suburb,Industry,Listing URL,Personal line\r\n'
  + 'Example Plumbing,Dave,0400 000 000,Paddington,Plumbing,https://www.google.com/maps/place/example,saw your reviews say you always turn up on time\r\n';

export function openImport() {
  const s = sheet('Import leads');
  let parsed = null;
  let fileName = 'pasted list';
  let map = {};
  const batch = { campaign_id: state.campaigns.find((c) => c.active)?.id || '', industry: '', number_source_url: '', tags: [] };
  const stepper = (n) => el('div', { class: 'steps', 'aria-label': `Step ${n} of 3` },
    ...['Choose file', 'Match columns', 'Check and import'].flatMap((t, i) => [
      i ? el('span', { 'aria-hidden': 'true' }, '›') : null,
      el('span', { class: i + 1 === n ? 'is-on' : '' }, `${i + 1}. ${t}`)]));

  function stepFile() {
    s.setTitle('Import leads');
    const fileIn = el('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv', class: 'sr-only', id: 'import-file', 'aria-label': 'Choose a CSV file' });
    const paste = textarea('paste', '', 'Or paste rows here, with a header row (from Excel or Google Sheets)');
    paste.rows = 5;
    const drop = el('label', { class: 'import-drop', for: 'import-file' },
      el('span', { class: 'empty-icon' }, icon('upload', 20)),
      el('b', {}, 'Drop a CSV here, or click to choose'),
      el('span', { class: 'muted small' }, 'Any columns. You match them up next. Nothing is saved until the last step.'),
      fileIn);
    const load = (text, name) => {
      const p = parseCsv(text);
      if (!p.headers.length || !p.rows.length) { toast('That file has no rows under a header', 'bad'); return; }
      parsed = p; fileName = name; map = guessMapping(p.headers);
      stepMap();
    };
    fileIn.addEventListener('change', async () => { const f = fileIn.files[0]; if (f) load(await f.text(), f.name); });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', async (e) => { e.preventDefault(); drop.classList.remove('is-over'); const f = e.dataTransfer.files[0]; if (f) load(await f.text(), f.name); });
    fill(s.body, stepper(1), drop, paste,
      el('p', { class: 'small muted' }, 'Only Australian mobiles are imported for texting. Landlines, invalid numbers, duplicates and anyone on the do-not-contact list are left out and listed in a report. ',
        el('button', { type: 'button', class: 'link-btn', onClick: () => downloadFile('wise-os-leads-sample.csv', SAMPLE_CSV) }, 'Download a sample CSV')));
    fill(s.foot, 
      el('button', { type: 'button', class: 'btn btn-ghost', onClick: s.close }, 'Cancel'),
      el('button', { type: 'button', class: 'btn btn-primary', onClick: () => { if (paste.value.trim()) load(paste.value, 'pasted list'); else toast('Choose a file or paste some rows first', 'warn'); } }, 'Next', icon('arrow', 15)));
  }

  function stepMap() {
    s.setTitle(`Import: ${fileName}`);
    const sample = (i) => parsed.rows.find((r) => r[i])?.[i] || '';
    const colOpts = [{ id: '', label: '— not in file —' }, ...parsed.headers.map((h, i) => ({ id: String(i), label: h }))];
    const sels = {};
    const grid = el('div', { class: 'map-grid' }, TARGETS.map((t) => {
      const sel = select(`map-${t.id}`, colOpts, map[t.id] === undefined ? '' : String(map[t.id]));
      sel.classList.add('sm');
      const sam = el('span', { class: 'map-sample' }, map[t.id] !== undefined ? sample(map[t.id]) : '');
      sel.addEventListener('change', () => { sam.textContent = sel.value === '' ? '' : sample(Number(sel.value)); });
      sels[t.id] = sel;
      return el('label', { class: 'field' },
        el('span', { class: 'field-label' }, el('span', {}, t.label), t.required ? el('span', { class: 'faint' }, 'required') : null),
        sel, sam);
    }));
    const campSel = select('batch-campaign', [{ id: '', label: 'No campaign' }, ...state.campaigns.map((c) => ({ id: c.id, label: c.name }))], batch.campaign_id);
    const indIn = input('batch-industry', { value: batch.industry, placeholder: 'e.g. Plumbing' });
    const srcIn = input('batch-source', { type: 'url', value: batch.number_source_url, placeholder: 'https://… where you found this list' });
    const tagIn = input('batch-tags', { value: batch.tags.join(', '), placeholder: 'e.g. brisbane-north, nov' });
    const err = el('div');
    fill(s.body, stepper(2),
      el('p', { class: 'small muted' }, `${plural(parsed.rows.length, 'row')} found. Check each field points at the right column.`),
      grid,
      el('hr', { class: 'divider' }),
      el('p', { class: 'eyebrow' }, 'For this whole batch'),
      el('div', { class: 'form-grid' },
        field('Campaign', campSel),
        field('Industry', indIn, 'Used when a row has none'),
        el('div', { class: 'full' }, field('Number source URL', srcIn, 'Required for compliance unless every row has its own. Where these numbers are publicly listed.')),
        el('div', { class: 'full' }, field('Tags', tagIn, 'Comma separated'))),
      err);
    fill(s.foot, 
      el('button', { type: 'button', class: 'btn btn-ghost', onClick: stepFile }, icon('chevron-left', 15), 'Back'),
      el('span', { class: 'spacer' }),
      el('button', {
        type: 'button', class: 'btn btn-primary', onClick: () => {
          map = {};
          for (const [k, sel] of Object.entries(sels)) if (sel.value !== '') map[k] = Number(sel.value);
          batch.campaign_id = campSel.value; batch.industry = indIn.value.trim(); batch.number_source_url = srcIn.value.trim();
          batch.tags = tagIn.value.split(',').map((t) => t.trim()).filter(Boolean);
          clear(err);
          if (map.phone === undefined) { err.append(el('div', { class: 'callout is-bad' }, icon('alert', 16), 'Choose the column that holds the phone number.')); return; }
          if (map.number_source_url === undefined && !batch.number_source_url) {
            err.append(el('div', { class: 'callout is-bad' }, icon('alert', 16), 'Add a number source URL for the batch, or map a column that has one per row.'));
            srcIn.focus();
            return;
          }
          stepReview();
        }
      }, 'Check rows', icon('arrow', 15)));
  }

  function stepReview() {
    const res = analyseImport({ rows: parsed.rows, map, batch });
    const c = res.counts;
    const cell = (n, label, cls = '', key) => el('div', { class: `report-cell ${cls}`, dataset: { k: key } }, el('b', {}, num(n)), el('span', {}, label));
    const report = el('div', { class: 'report', 'aria-label': 'Import report' },
      cell(c.ready, 'AU mobiles ready', 'is-ok', 'ready'),
      cell(c.landline, 'Landlines', '', 'landline'),
      cell(c.invalid + c.empty, 'Invalid or missing', '', 'invalid'),
      cell(c.duplicate + c.existing, 'Duplicates', '', 'duplicate'),
      c.suppressed ? cell(c.suppressed, 'Do not contact', '', 'suppressed') : null,
      c.overseas ? cell(c.overseas, 'Overseas', '', 'overseas') : null,
      c.no_source ? cell(c.no_source, 'No number source', '', 'no_source') : null);
    const hdr = parsed.headers;
    const preview = res.ready.slice(0, 6);
    const droppedRows = res.dropped.slice(0, 40);
    const noHook = res.ready.filter((r) => !r.hook).length;
    fill(s.body, stepper(3), report,
      c.duplicate || c.existing ? el('p', { class: 'small muted' }, `${c.duplicate} repeated within the file, ${c.existing} already in your leads.`) : null,
      preview.length ? el('div', { class: 'stack tight' },
        el('p', { class: 'eyebrow' }, `Preview (${num(res.ready.length)})`),
        el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
          el('thead', {}, el('tr', {}, el('th', {}, 'Lead'), el('th', {}, 'Mobile'), el('th', {}, 'Suburb'), el('th', {}, 'Personal line'))),
          el('tbody', {}, preview.map((r) => el('tr', {},
            el('td', {}, r.business || r.contact_name || '—'), el('td', { class: 'phone-cell' }, prettyPhone(r.phone)),
            el('td', {}, r.suburb || '—'), el('td', { class: 'small' }, r.hook || el('span', { class: 'faint' }, 'none yet')))))))) : null,
      noHook && res.ready.length ? el('div', { class: 'callout is-info' }, icon('edit', 16),
        el('span', {}, `${plural(noHook, 'lead')} ${noHook === 1 ? 'has' : 'have'} no personal line yet. They import fine, and wait under "Needs a personal line" until you write one.`)) : null,
      droppedRows.length ? el('details', {},
        el('summary', { class: 'small', style: 'cursor:pointer;font-weight:600' }, `${plural(res.dropped.length, 'row')} left out: see why`),
        el('div', { class: 'table-wrap', style: 'margin-top:8px' }, el('table', { class: 'table' },
          el('thead', {}, el('tr', {}, el('th', {}, 'Row'), el('th', {}, 'Phone as given'), el('th', {}, 'Reason'))),
          el('tbody', {}, droppedRows.map((d) => el('tr', {},
            el('td', { class: 'small' }, d.row[map.business] || d.row[map.contact_name] || d.row[0] || '—'),
            el('td', { class: 'small phone-cell' }, d.row[map.phone] || '—'),
            el('td', { class: 'small' }, d.label)))))),
        res.dropped.length > 40 ? el('p', { class: 'small muted' }, `…and ${res.dropped.length - 40} more`) : null,
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', style: 'margin-top:8px', onClick: () => downloadFile('left-out-rows.csv', toCsv(res.dropped.map((d) => ({ reason: d.label, ...Object.fromEntries(hdr.map((h, i) => [h, d.row[i]])) })), ['reason', ...hdr])) }, icon('download', 13), 'Download left-out rows')) : null);
    const go2 = el('button', { type: 'button', class: 'btn btn-primary', disabled: !res.ready.length || null }, icon('upload', 15), res.ready.length ? `Import ${plural(res.ready.length, 'lead')}` : 'Nothing to import');
    go2.addEventListener('click', () => busy(go2, async () => {
      try {
        const out = await addLeads(res.ready);
        logEvent('import', null, `Imported ${plural(out.inserted, 'lead')} from ${fileName}`).catch(() => {});
        toast(`Imported ${plural(out.inserted, 'lead')}`);
        stepDone(out, res);
      } catch (e) { toast(e.message, 'bad'); }
    }));
    fill(s.foot, el('button', { type: 'button', class: 'btn btn-ghost', onClick: stepMap }, icon('chevron-left', 15), 'Back'), el('span', { class: 'spacer' }), go2);
  }

  function stepDone(out, res) {
    s.setTitle('Import complete');
    ui.batchIds = new Set(out.rows.map((r) => r.id));
    fill(s.body, 
      el('div', { class: 'report' },
        el('div', { class: 'report-cell is-ok', dataset: { k: 'inserted' } }, el('b', {}, num(out.inserted)), el('span', {}, 'Imported')),
        el('div', { class: 'report-cell', dataset: { k: 'left' } }, el('b', {}, num(res.dropped.length + out.skipped)), el('span', {}, 'Left out'))),
      out.skipped ? el('p', { class: 'small muted' }, `${out.skipped} turned out to exist already and were skipped.`) : null,
      el('p', { class: 'muted' }, 'Next: write a personal line for each one, then send a careful first batch from Campaigns.'));
    fill(s.foot, 
      el('button', { type: 'button', class: 'btn btn-ghost', onClick: s.close }, 'Close'),
      el('button', { type: 'button', class: 'btn btn-primary', onClick: () => { ui.special = 'batch'; ui.status = 'all'; s.close(); go('leads'); } }, 'View imported leads'));
  }

  stepFile();
}

/* ============================================================ drawer */
let openDrawer = null;

/** Open the lead drawer over the current view. */
export function openLead(id) {
  if (openDrawer) openDrawer.close(true);
  const lead0 = leadById(id);
  if (!lead0) { toast('That lead no longer exists', 'warn'); return; }
  const cleanup = [];
  const prevFocus = document.activeElement;
  let thread = [];

  const titleId = `ld-${id}`;
  const nameH = el('h1', { class: 'h1', id: titleId });
  const statusSel = select('status', STATUSES.map((s) => ({ id: s.id, label: s.label })), lead0.status);
  statusSel.classList.add('sm');
  statusSel.style.width = 'auto';
  statusSel.setAttribute('aria-label', 'Status');
  statusSel.addEventListener('change', async () => {
    const lead = leadById(id);
    const v = statusSel.value;
    if (v === 'dnc') { const ok = await markDnc(lead); if (!ok) statusSel.value = lead.status; return; }
    await changeStatus(lead, v);
  });
  const sub = el('div', { class: 'ld-sub' });
  const actions = el('div', { class: 'ld-actions' });
  const eyebrow = el('p', { class: 'eyebrow' });

  const drawHead = () => {
    const l = leadById(id);
    if (!l) return;
    nameH.textContent = leadName(l);
    if (document.activeElement !== statusSel) statusSel.value = l.status;
    eyebrow.textContent = `${SOURCE_LABEL[l.source] || l.source} · added ${timeAgo(l.created_at)}${l.archived ? ' · archived' : ''}`;
    fill(sub, 
      l.business && l.contact_name ? el('span', {}, icon('user', 13), ' ', l.contact_name) : null,
      l.phone ? el('span', { class: 'mono' }, prettyPhone(l.phone)) : null,
      l.phone && !isAuMobile(l.phone) ? badge('not a mobile', 'warn') : null,
      isSuppressed(l.phone) ? badge('suppressed', 'bad') : null,
      l.suburb ? el('span', {}, l.suburb) : null,
      l.industry ? el('span', {}, l.industry) : null,
      campaignById(l.campaign_id) ? el('span', {}, icon('send', 12), ' ', campaignById(l.campaign_id).name) : null);
    const web = safeHref(l.website);
    fill(actions, 
      l.phone ? el('a', { class: 'btn btn-ghost btn-sm', href: `tel:${l.phone}` }, icon('phone', 14), 'Call') : null,
      l.phone ? el('a', { class: 'btn btn-ghost btn-sm', href: `#inbox/${l.id}` }, icon('message', 14), 'Text') : null,
      l.email ? el('a', { class: 'btn btn-ghost btn-sm', href: `mailto:${encodeURIComponent(l.email).replace('%40', '@')}` }, icon('mail', 14), 'Email') : null,
      l.phone ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => copyText(l.phone, 'Number copied') }, icon('copy', 14), 'Copy') : null,
      web ? el('a', { class: 'btn btn-ghost btn-sm', href: web, target: '_blank', rel: 'noopener noreferrer' }, icon('external', 14), 'Website') : null);
  };

  /* --------------------------------------------- personal line + ROI */
  const l0 = lead0;
  const hookIn = textarea('hook', l0.hook || '', 'e.g. saw your Google reviews mention it is hard to get through on the phone');
  hookIn.rows = 2;
  const painIn = input('pain', { value: l0.pain || '', placeholder: 'e.g. missed calls while on the tools' });
  const valueIn = input('est_monthly_value', { type: 'number', value: l0.est_monthly_value ?? '', min: 0, step: 50, placeholder: '2400', inputmode: 'numeric' });
  const previewBox = el('div', { class: 'msg out', style: 'max-width:100%;align-self:stretch' });
  const previewMeta = el('div', { class: 'small muted' });
  const step0 = () => {
    const l = leadById(id) || l0;
    const tpls = state.templates.filter((t) => t.active && t.step === 0);
    return tpls.find((t) => t.campaign_id === l.campaign_id) || tpls[0] || null;
  };
  const drawPreview = () => {
    const t = step0();
    if (!t) { previewBox.textContent = 'No first-touch template yet. Create one in Campaigns.'; previewMeta.textContent = ''; return; }
    const l = { ...(leadById(id) || l0), hook: hookIn.value, pain: painIn.value, est_monthly_value: valueIn.value || null };
    const text = composeSms(t.body, l);
    previewBox.textContent = text;
    previewMeta.textContent = `${text.length} characters · template "${t.name}"${!hookIn.value.trim() && /\{hook\}/.test(t.body) ? ' · needs a personal line' : ''}`;
  };
  [hookIn, painIn, valueIn].forEach((n) => n.addEventListener('input', drawPreview));

  const missedIn = input('roi-missed', { type: 'number', value: 3, min: 0, step: 1, inputmode: 'numeric' });
  const jobIn = input('roi-job', { type: 'number', value: 450, min: 0, step: 10, inputmode: 'numeric' });
  const closeIn = input('roi-close', { type: 'number', value: 40, min: 0, max: 100, step: 5, inputmode: 'numeric' });
  const roiOut = el('b', {});
  const roiExplain = el('span', { class: 'small muted' });
  const roiCalc = () => {
    const missed = Math.max(0, Number(missedIn.value) || 0);
    const job = Math.max(0, Number(jobIn.value) || 0);
    const rate = Math.min(100, Math.max(0, Number(closeIn.value) || 0)) / 100;
    const monthly = Math.round((missed * job * rate * 52) / 12);
    roiOut.textContent = `${money(monthly)}/mo`;
    roiExplain.textContent = `${missed} missed a week × ${money(job)} a job × ${Math.round(rate * 100)}% won × 4.33 weeks`;
    return { missed, job, rate, monthly };
  };
  [missedIn, jobIn, closeIn].forEach((n) => n.addEventListener('input', roiCalc));
  roiCalc();
  const useRoi = el('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, icon('check', 13), 'Use this estimate');
  useRoi.addEventListener('click', () => busy(useRoi, async () => {
    const r = roiCalc();
    const pain = `Missing about ${r.missed} enquir${r.missed === 1 ? 'y' : 'ies'} a week, roughly ${money(r.monthly)} a month in lost work`;
    try {
      await saveLead(id, { est_monthly_value: r.monthly, pain });
      valueIn.value = String(r.monthly);
      painIn.value = pain;
      drawPreview();
      toast('Estimate saved to the lead');
    } catch (e) { toast(e.message, 'bad'); }
  }));
  const savePersonal = el('button', { type: 'button', class: 'btn btn-primary btn-sm' }, 'Save personal line');
  savePersonal.addEventListener('click', () => busy(savePersonal, async () => {
    try {
      await saveLead(id, { hook: hookIn.value, pain: painIn.value, est_monthly_value: valueIn.value === '' ? null : valueIn.value });
      toast('Saved');
    } catch (e) { toast(e.message, 'bad'); }
  }));

  const personal = el('section', { class: 'ld-personal', 'aria-label': 'Personal line and value' },
    el('div', { class: 'ld-section-head' },
      el('div', { class: 'stack tight' }, el('p', { class: 'eyebrow' }, 'Why they should care'), el('h2', { class: 'h2' }, 'Personal line and value'))),
    field('Personal line', hookIn, 'One specific thing you noticed about this business. Goes in as {hook}.'),
    el('div', { class: 'form-grid' },
      field('Their pain', painIn, '{pain}'),
      field('Worth to them ($/month)', valueIn, '{value}')),
    el('details', { class: 'roi' },
      el('summary', {}, 'ROI estimator'),
      el('div', { class: 'roi-grid', style: 'margin-top:10px' },
        field('Missed enquiries / week', missedIn),
        field('Average job ($)', jobIn),
        field('Close rate (%)', closeIn)),
      el('div', { class: 'roi-out', style: 'margin-top:10px' }, roiOut, roiExplain),
      el('div', { class: 'row', style: 'margin-top:8px' }, useRoi)),
    el('div', { class: 'stack tight' }, el('span', { class: 'field-label' }, 'How the first text reads'), previewBox, previewMeta),
    el('div', { class: 'row' }, savePersonal));
  drawPreview();

  /* --------------------------------------------------------- thread */
  const threadBox = el('div', { class: 'thread', 'aria-live': 'polite' }, el('p', { class: 'small muted' }, 'Loading conversation…'));
  const drawThread = () => {
    clear(threadBox);
    if (!thread.length) { threadBox.append(el('p', { class: 'small muted' }, 'No messages yet.')); return; }
    for (const m of thread) {
      const isLog = m.channel === 'call' || m.channel === 'note';
      const cls = isLog ? 'msg log' : `msg ${m.direction}${m.status === 'failed' ? ' failed' : ''}`;
      threadBox.append(el('div', { class: cls },
        isLog ? el('b', {}, m.channel === 'call' ? 'Call: ' : 'Note: ') : null,
        m.body,
        el('div', { class: 'msg-meta' }, el('span', {}, dateTime(m.created_at)),
          !isLog && m.direction === 'out' ? el('span', {}, `· ${m.status}`) : null,
          m.error ? el('span', {}, `· ${m.error}`) : null)));
    }
  };
  messagesFor(id).then((rows) => { thread = rows; drawThread(); }).catch((e) => { fill(threadBox, el('p', { class: 'small', style: 'color:var(--rose-t)' }, e.message)); });
  cleanup.push(onMessage((m) => {
    if (m.lead_id !== id) return;
    const i = thread.findIndex((x) => x.id === m.id);
    if (i >= 0) thread[i] = { ...thread[i], ...m }; else thread.push(m);
    thread.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    drawThread();
  }));

  let logKind = 'call';
  const logTabs = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Log type' });
  const logText = textarea('log', '', 'What was said, what happens next');
  logText.rows = 2;
  const drawLogTabs = () => fill(logTabs, ...[['call', 'Log a call'], ['note', 'Add a note']].map(([k, label]) =>
    el('button', { type: 'button', role: 'tab', 'aria-selected': String(logKind === k), class: `tab${logKind === k ? ' is-active' : ''}`, onClick: () => { logKind = k; drawLogTabs(); } }, label)));
  drawLogTabs();
  const logBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, icon('plus', 13), 'Save');
  logBtn.addEventListener('click', () => busy(logBtn, async () => {
    const body = logText.value.trim();
    if (!body) { toast('Write something first', 'warn'); logText.focus(); return; }
    try {
      await addMessage({ lead_id: id, channel: logKind, body });
      const l = leadById(id);
      if (logKind === 'call') {
        const patch = { last_contacted_at: new Date().toISOString() };
        if (isFresh(l)) patch.status = 'contacted';
        await saveLead(id, patch);
      }
      logEvent(logKind === 'call' ? 'call_logged' : 'note', id, `${logKind === 'call' ? 'Call with' : 'Note on'} ${leadName(l)}: ${body.slice(0, 80)}`).catch(() => {});
      logText.value = '';
      toast(logKind === 'call' ? 'Call logged' : 'Note added');
    } catch (e) { toast(e.message, 'bad'); }
  }));

  const conversation = el('section', { class: 'ld-section', 'aria-label': 'Conversation' },
    el('div', { class: 'ld-section-head' }, el('h2', { class: 'h2' }, 'Conversation'),
      el('a', { class: 'btn btn-ghost btn-sm', href: `#inbox/${id}` }, icon('message', 13), 'Open in inbox')),
    threadBox,
    el('div', { class: 'stack tight' }, logTabs, logText, el('div', { class: 'row' }, logBtn)));

  /* --------------------------------------------------------- details */
  const detailsForm = el('form', { class: 'stack' }, leadFormFields(l0),
    el('div', { class: 'form-grid' },
      field('Tags', input('tags', { value: (l0.tags || []).join(', '), placeholder: 'comma separated' })),
      field('Next follow-up', input('next_followup_at', { type: 'date', value: l0.next_followup_at ? new Date(l0.next_followup_at).toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' }) : '' })),
      el('div', { class: 'full' }, field('Notes', textarea('notes', l0.notes || '', 'Anything worth remembering')))),
    el('div', { class: 'row' }, el('button', { type: 'submit', class: 'btn btn-primary btn-sm' }, 'Save details')));
  const srcLink = safeHref(l0.number_source_url);
  detailsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = detailsForm.querySelector('button[type=submit]');
    const v = Object.fromEntries(new FormData(detailsForm));
    const phone = v.phone ? normalisePhone(v.phone) : null;
    if (v.phone && !phone) { toast(`"${v.phone}" doesn't look like a phone number`, 'bad'); return; }
    v.phone = phone;
    v.next_followup_at = v.next_followup_at ? new Date(`${v.next_followup_at}T09:00:00+10:00`).toISOString() : null;
    await busy(btn, async () => {
      try { await saveLead(id, v); toast('Details saved'); drawHead(); } catch (err) { toast(err.message, 'bad'); }
    });
  });
  const details = el('section', { class: 'ld-section', 'aria-label': 'Details' },
    el('div', { class: 'ld-section-head' }, el('h2', { class: 'h2' }, 'Details'),
      srcLink ? el('a', { class: 'small', href: srcLink, target: '_blank', rel: 'noopener noreferrer' }, icon('link', 12), ' Number source') : null),
    detailsForm);

  /* --------------------------------------------------------- foot */
  const archiveBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm' });
  const drawArchive = () => { const l = leadById(id); fill(archiveBtn, icon('archive', 13), l?.archived ? 'Restore' : 'Archive'); };
  drawArchive();
  archiveBtn.addEventListener('click', () => busy(archiveBtn, async () => {
    const l = leadById(id);
    try { await saveLead(id, { archived: !l.archived }); toast(l.archived ? 'Restored' : 'Archived'); drawArchive(); drawHead(); } catch (e) { toast(e.message, 'bad'); }
  }));
  const dncBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm is-danger', onClick: async () => { await markDnc(leadById(id)); drawHead(); } }, icon('ban', 13), 'Do not contact');
  const delBtn = el('button', {
    type: 'button', class: 'btn btn-ghost btn-sm is-danger', onClick: async () => {
      const l = leadById(id);
      const ok = await confirmDialog('Delete this lead?', `${leadName(l)} and their whole conversation will be deleted. This cannot be undone. Opt-outs stay on the suppression list.`);
      if (!ok) return;
      try { await deleteLead(id); toast('Lead deleted'); close(); } catch (e) { toast(e.message, 'bad'); }
    }
  }, icon('trash', 13), 'Delete');

  const body = el('div', { class: 'drawer-body' }, personal, conversation, details);
  const drawer = el('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    el('div', { class: 'drawer-head' },
      el('div', { class: 'ld-title' },
        el('div', { class: 'stack tight', style: 'flex:1;min-width:0' }, eyebrow, nameH),
        el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close lead', onClick: () => close() }, icon('x', 18))),
      el('div', { class: 'row' }, statusSel, sub),
      actions),
    body,
    el('div', { class: 'drawer-foot' }, archiveBtn, el('span', { class: 'spacer' }), dncBtn, delBtn));
  const backdrop = el('div', { class: 'drawer-backdrop', onClick: () => close() });

  function close(silent) {
    cleanup.forEach((fn) => fn());
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', onHash);
    drawer.classList.add('is-leaving');
    backdrop.remove();
    setTimeout(() => drawer.remove(), 180);
    if (openDrawer && openDrawer.id === id) openDrawer = null;
    if (!silent && location.hash.startsWith('#leads/')) history.replaceState(null, '', '#leads');
    if (!silent && prevFocus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
  }
  const onKey = (e) => {
    if (document.querySelector('.modal-backdrop')) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Tab') trapFocus(e, drawer);
  };
  const onHash = () => { if (location.hash !== `#leads/${id}`) close(true); };
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', onHash);
  cleanup.push(onChange(() => {
    const l = leadById(id);
    if (!l) { toast('This lead was deleted', 'warn'); close(); return; }
    drawHead(); drawArchive();
  }));

  drawHead();
  document.body.append(backdrop, drawer);
  openDrawer = { id, close };
  setTimeout(() => drawer.querySelector('.icon-btn')?.focus({ preventScroll: true }), 40);
  return drawer;
}

export { changeStatus, markDnc };
