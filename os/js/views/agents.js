// Agents: four tightly scoped assistants (Researcher, Morning briefing, Ask the hub,
// Doer), the approvals they wait on, the run log that audits them, and the rules.
// They read, research, draft and propose. A proposed change is applied only when
// Tyler presses Approve (applyAgentAction, in the browser, with his own session).
// Nothing an agent returns ever goes through innerHTML: it reaches the page as text
// nodes through el(), links are hub hashes or plain http(s) URLs.
import {
  el, icon, fill, clear, toast, busy, badge, confirmDialog, emptyState, timeAgo, dateTime, timeOnly, dayKey,
  money, num, plural, STATUS, go
} from '../ui.js?v=20261118c';
import {
  state, notify, saveLead, saveSettings, agentRun, agentStatus, applyAgentAction, rejectAgentAction,
  leadById, leadName, rowById
} from '../api.js?v=20261118c';
import { askPanel, safeHash } from '../ask.js?v=20261118c';

/* ================================================================ shared bits */

export const AGENTS = [
  {
    k: 'researcher', name: 'Researcher', col: 'agent_researcher', eyebrow: 'Before you text',
    does: 'Reads one lead’s own website and public listing, and tells you what it actually saw, with a link for each point.',
    never: 'Never contacts anyone and never changes the lead. You choose what to keep.'
  },
  {
    k: 'briefing', name: 'Morning briefing', col: 'agent_briefing', eyebrow: 'Every morning',
    does: 'Reads the whole hub and writes a short note on what matters today, most valuable first.',
    never: 'Never acts on what it finds. Every item is a link for you to open.'
  },
  {
    k: 'ask', name: 'Ask the hub', col: 'agent_ask', eyebrow: 'Questions',
    does: 'Answers questions about your business from the hub’s own records, with links to them.',
    never: 'Never changes anything, and says so plainly when your data cannot answer.'
  },
  {
    k: 'doer', name: 'Doer', col: 'agent_doer', eyebrow: 'Set-up work',
    does: 'Turns a plain instruction into suggested changes that you approve or reject one by one.',
    never: 'Never sends, deletes or pays. Nothing happens until you press Approve.'
  }
];
const AGENT = Object.fromEntries(AGENTS.map((a) => [a.k, a]));
const DEFAULT_LIMITS = { researcher: 40, briefing: 4, ask: 150, doer: 30 };

/** US dollars to the cent; a tiny non-zero amount reads "under 1 cent". */
export function usd(n) {
  const v = Number(n) || 0;
  if (v > 0 && v < 0.005) return 'under 1 cent';
  return `US$${v.toFixed(2)}`;
}

const str = (v) => typeof v === 'string' && v.trim() !== '';
const arr = (v) => (Array.isArray(v) ? v : []);
/** Plain http(s) URL or null. */
export function safeUrl(u) {
  if (!str(u)) return null;
  try { const x = new URL(u.trim()); return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : null; } catch { return null; }
}
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const extLink = (url, label, cls = 'ag-src') => el('a', { class: cls, href: url, target: '_blank', rel: 'noopener noreferrer' }, label || hostOf(url), icon('external', 11));
/** The model output inside a function response or an agent_runs.output. */
export function unwrap(o) {
  if (!o || typeof o !== 'object') return {};
  if (o.result && typeof o.result === 'object' && !Array.isArray(o.result)) return o.result;
  if (o.output && typeof o.output === 'object' && !Array.isArray(o.output)) return o.output;
  return o;
}
const sourcesOf = (...xs) => {
  for (const x of xs) {
    const list = arr(x).map((s) => safeUrl(typeof s === 'string' ? s : s?.url)).filter(Boolean);
    if (list.length) return [...new Set(list)];
  }
  return [];
};
const isoDay = (d) => (str(d) && /^\d{4}-\d{2}-\d{2}/.test(d) ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }) : '');

/** Everything a screen needs to know about whether the agents can run. */
export function agentsInfo() {
  const a = state.agents;
  const s = state.settings || {};
  const master = s.agents_enabled !== false;
  const on = (k) => master && s[`agent_${k}`] !== false;
  const connected = Boolean(a && a.configured);
  const monthKey = dayKey().slice(0, 7);
  const loggedSpend = state.agent_runs.filter((r) => String(r.at || '').slice(0, 7) === monthKey).reduce((t, r) => t + (Number(r.cost_usd) || 0), 0);
  return {
    reachable: Boolean(a), connected, master, on,
    ready: (k) => connected && on(k),
    cap: Number(a?.cap_usd ?? s.agent_monthly_cap_usd ?? 25),
    spent: Number(a?.spent_usd ?? loggedSpend),
    runsToday: (k) => Number(a?.runs_today?.[k] ?? 0),
    limit: (k) => Number(a?.limits?.[k] ?? DEFAULT_LIMITS[k])
  };
}

/** Proposed changes waiting for Tyler, newest first. */
export const pendingActions = () => state.agent_actions.filter((x) => x.status === 'proposed');

/** "Connected · On" (or why not) as [tone, text]. */
function statusLine(info) {
  if (!info.reachable) return ['warn', 'Not reachable right now'];
  if (!info.connected) return ['warn', 'Not connected'];
  if (!info.master) return ['mute', 'Switched off'];
  return ['ok', 'Connected · on'];
}

function meter(spent, cap, label) {
  const pct = cap > 0 ? Math.min(100, Math.round((spent / cap) * 100)) : 100;
  return el('span', { class: `ag-meter${pct >= 90 ? ' is-high' : ''}`, role: 'img', 'aria-label': label || `${pct}% of the monthly agent budget used` }, el('i', { style: `width:${pct}%` }));
}

/** A switch bound to one boolean settings column. Saves at once. */
export function settingSwitch(col, label, { onSaved } = {}) {
  const box = el('input', { type: 'checkbox', class: 'ag-switch-in', role: 'switch', name: col, 'aria-label': label });
  const word = el('span', { class: 'ag-switch-word' });
  const paint = () => {
    const v = state.settings?.[col] !== false;
    if (!box.disabled) box.checked = v;
    word.textContent = box.checked ? 'On' : 'Off';
  };
  box.addEventListener('change', async () => {
    const v = box.checked;
    word.textContent = v ? 'On' : 'Off';
    box.disabled = true;
    try {
      await saveSettings({ [col]: v });
      toast(`${label} ${v ? 'on' : 'off'}`);
      agentStatus();
      onSaved?.(v);
    } catch (e) { box.checked = !v; toast(e.message, 'bad'); }
    box.disabled = false;
    paint();
  });
  paint();
  const node = el('label', { class: 'ag-switch', dataset: { col } }, box, el('span', { class: 'ag-switch-track', 'aria-hidden': 'true' }), word);
  node.update = paint;
  return node;
}

/* ============================================================ researcher card */

const researchCache = new Map();   // leadId → {out, sources, at, cost, run_id}
const researching = new Set();

/** The newest successful research for a lead: this session's result or the run log's. */
export function latestResearch(leadId) {
  const run = state.agent_runs.find((r) => r.agent === 'researcher' && r.status === 'ok' && r.lead_id === leadId);
  const fromRun = run ? { out: unwrap(run.output), sources: sourcesOf(run.sources, unwrap(run.output).sources), at: run.at, cost: run.cost_usd, run_id: run.id } : null;
  const mine = researchCache.get(leadId);
  if (mine && (!fromRun || String(mine.at) >= String(fromRun.at) || mine.run_id === fromRun.run_id)) return mine;
  return fromRun;
}
export const isResearching = (leadId) => researching.has(leadId);

/** Run the researcher for one lead. Resolves to the result or null (the error is toasted). */
export async function runResearch(leadId) {
  if (researching.has(leadId)) return null;
  researching.add(leadId);
  notify();
  const res = await agentRun('researcher', { lead_id: leadId });
  researching.delete(leadId);
  if (!res.ok) {
    toast(res.message, 'bad');
    agentStatus();
    return null;
  }
  const out = unwrap(res);
  const r = { out, sources: sourcesOf(res.sources, out.sources), at: res.at || new Date().toISOString(), cost: res.cost_usd, run_id: res.run_id };
  researchCache.set(leadId, r);
  agentStatus();
  notify();
  return r;
}

/** Can the researcher look this lead up at all (mirrors the function's own check)? */
export const canResearch = (l) => Boolean(l && (str(l.website) || str(l.number_source_url) || (str(l.business) && str(l.suburb))));

/**
 * The researcher's findings for one lead, with the operator's own actions:
 * use a line (sets hook), save the problem (sets pain), mark do not contact,
 * save the number source. onSaved(field, value) lets a host form follow along.
 */
export function researchCard(lead, r, { onSaved } = {}) {
  const out = r?.out || {};
  const obs = arr(out.observations).filter((o) => o && str(o.text)).slice(0, 5);
  const lines = arr(out.hooks).filter(str).map((s) => s.trim()).slice(0, 3);
  const pain = str(out.pain) ? out.pain.trim() : '';
  const optedOut = out.opted_out === true;
  const cur = () => leadById(lead.id) || lead;
  const isDnc = () => cur().status === 'dnc';

  const useLine = async (line, btn) => {
    const now = (cur().hook || '').trim();
    if (now === line) { toast('That is already the personal line', 'info'); return; }
    if (now) {
      const ok = await confirmDialog('Replace the personal line?', `“${now}” will be replaced with “${line}”.`, { confirmLabel: 'Replace', danger: false });
      if (!ok) return;
    }
    await busy(btn, async () => {
      try { await saveLead(lead.id, { hook: line }); toast('Personal line saved'); onSaved?.('hook', line); } catch (e) { toast(e.message, 'bad'); }
    });
  };
  const savePain = async (btn) => {
    const now = (cur().pain || '').trim();
    if (now === pain) { toast('That is already saved as the problem', 'info'); return; }
    if (now) {
      const ok = await confirmDialog('Replace the problem?', `“${now}” will be replaced.`, { confirmLabel: 'Replace', danger: false });
      if (!ok) return;
    }
    await busy(btn, async () => {
      try { await saveLead(lead.id, { pain }); toast('Problem saved to the lead'); onSaved?.('pain', pain); } catch (e) { toast(e.message, 'bad'); }
    });
  };

  const warn = optedOut ? el('div', { class: 'callout is-bad ag-optout', role: 'alert', dataset: { optout: '' } },
    icon('ban', 16),
    el('div', { class: 'stack tight' },
      el('strong', {}, 'Their site says they do not want sales contact. Do not text them.'),
      str(out.opted_out_evidence) ? el('span', { class: 'small' }, `What it says: “${out.opted_out_evidence.trim().slice(0, 300)}”`) : null,
      isDnc() ? el('span', { class: 'small muted' }, 'Already marked do not contact.')
        : el('div', { class: 'row' }, el('button', {
          type: 'button', class: 'btn btn-danger btn-sm', dataset: { act: 'mark-dnc' },
          onClick: async () => {
            const { markDnc } = await import('./leads.js?v=20261118c');
            const ok = await markDnc(cur());
            if (ok) onSaved?.('status', 'dnc');
          }
        }, icon('ban', 13), 'Mark do not contact')))) : null;

  const unread = str(out.could_not_read) ? el('p', { class: 'callout is-warn ag-unread' }, icon('alert', 15), el('span', {}, el('strong', {}, 'Could not read everything. '), out.could_not_read.trim())) : null;

  const seen = el('div', { class: 'ag-rc-block' },
    el('p', { class: 'ag-rc-label' }, 'What it saw'),
    obs.length
      ? el('ul', { class: 'ag-obs' }, obs.map((o) => {
        const u = safeUrl(o.source_url);
        return el('li', {}, el('span', {}, o.text.trim()), u ? extLink(u) : el('span', { class: 'small faint' }, 'no link'));
      }))
      : el('p', { class: 'small muted' }, 'Nothing specific on the pages it could read.'));

  const linesBlock = el('div', { class: 'ag-rc-block' },
    el('p', { class: 'ag-rc-label' }, 'Personal lines it suggests'),
    lines.length
      ? el('ul', { class: 'ag-lines' }, lines.map((line) => {
        const inUse = (cur().hook || '').trim() === line;
        const b = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { act: 'use-line' }, disabled: inUse || null }, icon('check', 13), inUse ? 'In use' : 'Use this line');
        b.addEventListener('click', () => useLine(line, b));
        return el('li', {}, el('q', { class: 'ag-line' }, line), optedOut ? null : b);
      }))
      : el('p', { class: 'ag-honest', dataset: { nolines: '' } }, 'It found nothing specific enough to write a personal line from, so it has not made one up. Look at their reviews or socials yourself, or leave this one.'),
    lines.length && !optedOut ? el('p', { class: 'small muted' }, 'Each goes in after “Hi <name>, Tyler from Wise AI here in Brisbane.” Read it before you use it.') : null);

  const painSaved = pain && (cur().pain || '').trim() === pain;
  const painBtn = pain ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { act: 'save-pain' }, disabled: painSaved || null }, painSaved ? [icon('check', 13), 'Saved'] : 'Save the problem') : null;
  painBtn?.addEventListener('click', () => savePain(painBtn));
  const painBlock = pain ? el('div', { class: 'ag-rc-block' },
    el('p', { class: 'ag-rc-label' }, 'The likely problem'),
    el('div', { class: 'ag-rc-row' }, el('p', {}, pain), painBtn)) : null;

  const np = ['yes', 'no', 'unknown'].includes(out.number_published) ? out.number_published : 'unknown';
  const ev = safeUrl(out.number_evidence_url);
  const curSrc = cur().number_source_url;
  const srcBtn = np === 'yes' && ev && !curSrc ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { act: 'save-source' } }, icon('link', 13), 'Save this as the number source') : null;
  srcBtn?.addEventListener('click', () => busy(srcBtn, async () => {
    try { await saveLead(lead.id, { number_source_url: ev }); toast('Number source saved'); onSaved?.('number_source_url', ev); } catch (e) { toast(e.message, 'bad'); }
  }));
  const numberBlock = el('div', { class: 'ag-rc-block', dataset: { number: np } },
    el('p', { class: 'ag-rc-label' }, 'Is their mobile published?'),
    el('div', { class: 'ag-rc-row' },
      el('p', { class: 'ag-num-line' },
        badge(np === 'yes' ? 'Yes' : np === 'no' ? 'No' : 'Unknown', np === 'yes' ? 'ok' : np === 'no' ? 'warn' : 'mute'),
        el('span', { class: 'muted' }, np === 'yes' ? 'It is on a page it read.' : np === 'no' ? 'It could not find it on the pages it read.' : 'It could not tell.'),
        ev ? extLink(ev, 'Evidence') : null),
      srcBtn),
    np === 'yes' && curSrc ? el('p', { class: 'small muted' }, 'The lead already has a number source saved.') : null);

  const sources = arr(r?.sources);
  const meta = el('div', { class: 'ag-rc-meta small muted' },
    el('span', {}, r?.at ? `Researched ${dayKey(r.at) === dayKey() ? `today at ${timeOnly(r.at)}` : dateTime(r.at)}` : 'Researched'),
    r?.cost !== undefined && r?.cost !== null ? el('span', { class: 'tnum' }, usd(r.cost)) : null,
    sources.length ? el('details', { class: 'ag-pages' }, el('summary', {}, plural(sources.length, 'page'), ' read'),
      el('ul', {}, sources.map((u) => el('li', {}, extLink(u, u))))) : null);

  return el('div', { class: 'ag-rc', dataset: { research: lead.id } }, warn, unread, seen, linesBlock, painBlock, numberBlock, meta);
}

/* ============================================================ briefing */

let briefBusy = false;
let briefLast = null;   // {out, at, run_id}

/** Today's briefing (local day), from this session or the run log, or null. */
export function todaysBriefing() {
  const today = dayKey();
  const run = state.agent_runs.find((r) => r.agent === 'briefing' && r.status === 'ok' && dayKey(r.at) === today);
  const fromRun = run ? { out: unwrap(run.output), at: run.at, run_id: run.id } : null;
  if (briefLast && dayKey(briefLast.at) === today && (!fromRun || String(briefLast.at) >= String(fromRun.at))) return briefLast;
  return fromRun;
}

export async function writeBriefing(refresh = false) {
  if (briefBusy) return;
  briefBusy = true;
  notify();
  const res = await agentRun('briefing', refresh ? { refresh: true } : {});
  briefBusy = false;
  if (!res.ok) {
    toast(res.message, res.error === 'empty' ? 'info' : 'bad');
  } else {
    const run = res.run_id ? state.agent_runs.find((r) => r.id === res.run_id) : null;
    briefLast = { out: unwrap(res), at: res.at || run?.at || new Date().toISOString(), run_id: res.run_id };
  }
  agentStatus();
  notify();
}

function linkItem(it) {
  const t = str(it?.text) ? it.text.trim() : '';
  if (!t) return null;
  const h = safeHash(it.hash);
  return el('li', {}, h ? el('a', { href: h }, t, icon('arrow', 12)) : el('span', {}, t));
}

/** The briefing itself: headline, Do first, Watch, the numbers, and when it was written. */
export function briefingBody(b, { compact = false } = {}) {
  const out = b.out || {};
  const doFirst = arr(out.do_first).map(linkItem).filter(Boolean).slice(0, 5);
  const watch = arr(out.watch).map(linkItem).filter(Boolean).slice(0, 3);
  const refresh = el('button', { type: 'button', class: 'link-btn', dataset: { act: 'brief-refresh' }, disabled: briefBusy || null, onClick: () => writeBriefing(true) }, briefBusy ? 'refreshing…' : 'refresh');
  return el('div', { class: `ag-brief${compact ? ' is-compact' : ''}`, dataset: { briefing: '' } },
    str(out.headline) ? el('p', { class: 'ag-brief-head' }, out.headline.trim()) : null,
    el('div', { class: 'ag-brief-cols' },
      doFirst.length ? el('div', { class: 'ag-brief-col' }, el('p', { class: 'ag-rc-label' }, 'Do first'), el('ol', { class: 'ag-brief-do' }, doFirst)) : null,
      watch.length ? el('div', { class: 'ag-brief-col' }, el('p', { class: 'ag-rc-label' }, 'Watch'), el('ul', { class: 'ag-brief-watch' }, watch)) : null),
    str(out.numbers) ? el('p', { class: 'ag-brief-nums' }, out.numbers.trim()) : null,
    el('p', { class: 'ag-brief-meta small muted' }, `Written at ${timeOnly(b.at)} · `, refresh));
}

/** The briefing block for Today and the Agents page. Never runs on its own: it costs money. */
export function briefingPanel({ compact = false } = {}) {
  const b = todaysBriefing();
  if (b) return briefingBody(b, { compact });
  const btn = el('button', { type: 'button', class: compact ? 'link-btn' : 'btn btn-ghost btn-sm', dataset: { act: 'brief-write' }, disabled: briefBusy || null, onClick: () => writeBriefing(false) },
    compact ? null : icon('spark', 14), briefBusy ? 'Writing today’s briefing…' : 'Write today’s briefing');
  return el('div', { class: `ag-brief is-empty${compact ? ' is-compact' : ''}`, dataset: { briefing: 'none' } },
    el('p', { class: 'small muted' }, compact ? 'Not written yet today. It reads the whole hub and uses your agent budget, so it waits for you.' : 'Not written yet today. It reads the whole hub, so it only runs when you ask.'),
    btn);
}

/* ============================================================ proposals */

const KIND = {
  'lead.set_status': ['Lead status', 'status change', 'status changes'],
  'lead.set_followup': ['Follow-up date', 'follow-up date', 'follow-up dates'],
  'lead.set_hook': ['Personal line', 'personal line', 'personal lines'],
  'note.add': ['Note', 'note', 'notes'],
  'task.create': ['New task', 'new task', 'new tasks'],
  'deal.create': ['New deal', 'new deal', 'new deals'],
  'deal.update': ['Deal update', 'deal update', 'deal updates'],
  'message.draft': ['Reply draft', 'reply draft', 'reply drafts'],
  'invoice.draft': ['Draft invoice', 'draft invoice', 'draft invoices']
};
const STAGE = { qualified: 'Qualified', proposal: 'Proposal', negotiation: 'Negotiation', won: 'Won', lost: 'Lost' };
const DECIDED = { applied: ['ok', 'Done'], rejected: ['mute', 'Rejected'], failed: ['bad', 'Could not apply'], approved: ['info', 'Approved'] };
const opened = new Map(); // action id → hash to open after it was applied

const leadRef = (id) => { const l = leadById(id); return l ? el('a', { href: `#leads/${l.id}` }, leadName(l)) : el('span', { class: 'ag-gone' }, 'a lead that no longer exists'); };
const rowRef = (table, id, route, label) => { const r = rowById(table, id); return r ? el('a', { href: `#${route}/${r.id}` }, r[label] || 'Untitled') : null; };
const was = (text) => el('span', { class: 'ag-was' }, ` (now ${text})`);

/** Exactly what approving will change, in plain words. */
export function describeChange(a) {
  const p = a.payload || {};
  const line = (...kids) => el('li', {}, ...kids);
  switch (a.kind) {
    case 'lead.set_status': {
      const l = leadById(p.lead_id);
      return [line(leadRef(p.lead_id), ': status becomes ', el('b', {}, STATUS[p.status]?.label || String(p.status)), l ? was(STATUS[l.status]?.label || l.status) : null)];
    }
    case 'lead.set_followup': {
      const l = leadById(p.lead_id);
      return [line(leadRef(p.lead_id), ': next follow-up on ', el('b', {}, isoDay(p.date) || String(p.date)), l ? was(l.next_followup_at ? isoDay(l.next_followup_at.slice(0, 10)) || 'set' : 'none') : null)];
    }
    case 'lead.set_hook': {
      const l = leadById(p.lead_id);
      return [line(leadRef(p.lead_id), ': personal line becomes'), el('li', { class: 'ag-quote' }, String(p.hook || '')), l?.hook ? line(el('span', { class: 'ag-was' }, `Replaces “${l.hook}”`)) : null];
    }
    case 'note.add':
      return [line('Adds a note to ', p.lead_id ? leadRef(p.lead_id) : rowRef('clients', p.client_id, 'clients', 'name') || 'a client that no longer exists', ':'), el('li', { class: 'ag-quote' }, String(p.text || ''))];
    case 'task.create': {
      const bits = [];
      if (p.client_id && rowById('clients', p.client_id)) bits.push(line('For ', rowRef('clients', p.client_id, 'clients', 'name')));
      if (p.project_id && rowById('projects', p.project_id)) bits.push(line('In project ', rowRef('projects', p.project_id, 'projects', 'name')));
      if (p.due_on) bits.push(line('Due ', el('b', {}, isoDay(p.due_on) || String(p.due_on))));
      if (p.priority) bits.push(line('Priority ', String(p.priority)));
      return [line('Adds a task: ', el('b', {}, String(p.title || ''))), ...bits];
    }
    case 'deal.create': {
      const bits = [];
      if (p.lead_id) bits.push(line('For ', leadRef(p.lead_id)));
      else if (p.client_id) bits.push(line('For ', rowRef('clients', p.client_id, 'clients', 'name') || 'a client that no longer exists'));
      if (Number(p.value) > 0) bits.push(line('Value ', el('b', {}, money(p.value))));
      if (Number(p.monthly_value) > 0) bits.push(line('Monthly ', el('b', {}, `${money(p.monthly_value)}/mo`)));
      if (str(p.next_step)) bits.push(line('Next step: ', p.next_step));
      return [line('Opens a deal in the pipeline, at Qualified: ', el('b', {}, String(p.title || ''))), ...bits];
    }
    case 'deal.update': {
      const d = rowById('deals', p.deal_id);
      const bits = [line(d ? rowRef('deals', d.id, 'pipeline', 'title') : el('span', { class: 'ag-gone' }, 'a deal that no longer exists'))];
      if (p.stage !== undefined) bits.push(line('Stage becomes ', el('b', {}, STAGE[p.stage] || String(p.stage)), d ? was(STAGE[d.stage] || d.stage) : null));
      if (str(p.next_step)) bits.push(line('Next step: ', el('b', {}, p.next_step), d?.next_step ? was(d.next_step) : null));
      if (p.next_step_on) bits.push(line('Next step on ', el('b', {}, isoDay(p.next_step_on) || String(p.next_step_on))));
      if (p.probability !== undefined && p.probability !== null) bits.push(line('Probability ', el('b', {}, `${Math.round(Number(p.probability))}%`), d?.probability !== undefined && d?.probability !== null ? was(`${d.probability}%`) : null));
      return bits;
    }
    case 'message.draft':
      return [line('A reply draft for ', leadRef(p.lead_id), ':'), el('li', { class: 'ag-draft' }, String(p.body || '')),
        el('li', { class: 'ag-safe' }, icon('check', 13), 'This puts a draft in your inbox reply box. It does not send.')];
    case 'invoice.draft': {
      const c = rowById('clients', p.client_id);
      return [line('For ', c ? rowRef('clients', c.id, 'clients', 'name') : el('span', { class: 'ag-gone' }, 'a client that no longer exists')),
        line(el('b', {}, String(p.description || '')), ' · ', el('b', { class: 'tnum' }, money(p.amount)), p.kind === 'retainer' ? ' · retainer' : ' · one-off'),
        el('li', { class: 'ag-safe' }, icon('check', 13), 'Creates a draft invoice. Nothing is sent.')];
    }
    default:
      return [el('li', { class: 'ag-gone' }, 'This kind of change is not on the allowed list, so it cannot be applied.')];
  }
}

const LEAD_OK = ['new', 'queued', 'contacted', 'replied', 'interested', 'booked', 'won', 'lost'];
/** Why a proposal breaks the rules (so it cannot be approved), or null. Mirrors the allowlist in api.js. */
export function ruleBreak(a) {
  const p = a.payload || {};
  if (!KIND[a.kind]) return 'This kind of change is not on the allowed list.';
  const l = p.lead_id ? leadById(p.lead_id) : null;
  if (a.kind === 'lead.set_status' && p.status === 'dnc') return 'Marking someone do not contact is yours to do, not an agent’s.';
  if (a.kind === 'lead.set_status' && !LEAD_OK.includes(p.status)) return 'That status is not allowed.';
  if (['lead.set_status', 'lead.set_followup', 'message.draft'].includes(a.kind) && l?.status === 'dnc') return 'This lead is marked do not contact.';
  if (a.kind === 'deal.update' && p.stage !== undefined && !['qualified', 'proposal', 'negotiation'].includes(p.stage)) return 'Closing a deal is yours to do, not an agent’s.';
  return null;
}

async function approve(a, btn) {
  const run = async () => {
    const res = await applyAgentAction(a);
    if (res.ok) {
      if (res.open) opened.set(a.id, res.open);
      toast(a.kind === 'message.draft' ? 'Draft is waiting in the inbox reply box' : 'Done');
    } else {
      toast(res.message, 'bad');
    }
    return res;
  };
  return btn ? busy(btn, run) : run();
}

/** One proposal: what it is, exactly what changes, why, and Approve / Reject. */
export function actionCard(a) {
  const k = KIND[a.kind];
  if (a.status !== 'proposed') {
    const [tone, word] = DECIDED[a.status] || ['mute', a.status];
    const open = opened.get(a.id);
    return el('li', { class: 'ag-decided', dataset: { action: a.id, status: a.status } },
      el('span', { class: 'ag-decided-what' }, el('span', { class: 'small faint' }, k ? k[0] : a.kind), el('span', {}, a.summary)),
      el('span', { class: 'ag-decided-out' },
        el('span', { class: `badge is-${tone}` }, el('span', { class: 'badge-dot', 'aria-hidden': 'true' }), word),
        a.status === 'failed' && str(a.result) ? el('span', { class: 'small muted' }, a.result) : null,
        open && safeHash(open) ? el('a', { class: 'small ag-open', href: safeHash(open) }, 'Open', icon('arrow', 12)) : null,
        a.decided_at ? el('span', { class: 'small faint' }, timeAgo(a.decided_at)) : null));
  }
  const broken = ruleBreak(a);
  const ok = el('button', { type: 'button', class: 'btn btn-primary btn-sm', dataset: { act: 'approve' }, disabled: broken ? true : null }, icon('check', 14), 'Approve');
  const no = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { act: 'reject' } }, 'Reject');
  ok.addEventListener('click', () => approve(a, ok));
  no.addEventListener('click', () => busy(no, async () => {
    const res = await rejectAgentAction(a.id);
    if (res.ok) toast('Rejected. Nothing was changed.'); else toast(res.message, 'bad');
  }));
  return el('li', { class: 'ag-action', dataset: { action: a.id, kind: a.kind } },
    el('div', { class: 'ag-action-top' },
      el('span', { class: 'ag-kind' }, k ? k[0] : a.kind),
      el('span', { class: 'small faint' }, timeAgo(a.created_at))),
    el('p', { class: 'ag-action-sum' }, a.summary),
    el('div', { class: 'ag-change' }, el('p', { class: 'ag-rc-label' }, 'What will change'), el('ul', {}, describeChange(a))),
    str(a.reason) ? el('p', { class: 'ag-why small' }, el('span', { class: 'muted' }, 'Why: '), a.reason) : null,
    broken ? el('p', { class: 'callout is-bad ag-broken', dataset: { broken: '' } }, icon('ban', 15), el('span', {}, `Outside the rules, so it cannot be approved. ${broken} Reject it to clear it.`)) : null,
    el('div', { class: 'row ag-action-btns' }, ok, no));
}

/** Approve every proposal in one Doer run, after a confirm that lists them by kind. */
async function approveAll(list, btn) {
  const by = {};
  list.forEach((a) => { by[a.kind] = (by[a.kind] || 0) + 1; });
  const parts = Object.entries(by).map(([kind, n]) => `${n} ${KIND[kind] ? (n === 1 ? KIND[kind][1] : KIND[kind][2]) : kind}`);
  const ok = await confirmDialog(`Approve all ${list.length}?`,
    `${parts.join(', ')}. Each one is applied in turn, exactly as shown. Anything that fails is marked and the rest carry on. Nothing is sent.`,
    { confirmLabel: `Approve ${list.length}`, danger: false });
  if (!ok) return;
  await busy(btn, async () => {
    let done = 0; let failed = 0;
    for (const a of list) {
      const cur = state.agent_actions.find((x) => x.id === a.id) || a;
      if (cur.status !== 'proposed') continue;
      const res = await applyAgentAction(cur);
      if (res.ok) { done++; if (res.open) opened.set(a.id, res.open); } else failed++;
    }
    toast(failed ? `${done} applied, ${failed} could not be applied` : `${plural(done, 'change')} applied`, failed ? 'warn' : 'ok');
  });
}

/** A run's proposals as a group: header (what was asked), cards, Approve all. */
function proposalGroup(runId, list, { showHead = true } = {}) {
  const run = state.agent_runs.find((r) => r.id === runId);
  const proposed = list.filter((a) => a.status === 'proposed');
  const allowed = proposed.filter((a) => !ruleBreak(a));
  const all = allowed.length > 1 && (!run || run.agent === 'doer')
    ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { act: 'approve-all' } }, `Approve all ${allowed.length}`) : null;
  all?.addEventListener('click', () => approveAll(allowed, all));
  return el('section', { class: 'ag-group', dataset: { run: runId || '' } },
    showHead || all ? el('div', { class: 'ag-group-head' },
      showHead ? el('div', { class: 'stack tight' },
        el('span', { class: 'small muted' }, `${run ? AGENT[run.agent]?.name || run.agent : 'Doer'}${run ? ` · ${timeAgo(run.at)}` : ''}`),
        el('span', { class: 'ag-group-ask' }, run ? askedText(run) : 'A request')) : el('span'),
      all) : null,
    el('ul', { class: 'ag-actions' }, proposed.map(actionCard)));
}

/* ============================================================ runs */

const RUN_STATUS = { ok: ['ok', 'Done'], error: ['bad', 'Error'], declined: ['warn', 'Declined'], capped: ['warn', 'Over budget'], empty: ['mute', 'Nothing to do'] };
const runBadge = (s) => { const [t, w] = RUN_STATUS[s] || ['mute', s || 'Unknown']; return el('span', { class: `badge is-${t}`, dataset: { runStatus: s || '' } }, el('span', { class: 'badge-dot', 'aria-hidden': 'true' }), w); };
const dur = (ms) => (Number(ms) ? `${(Number(ms) / 1000).toFixed(1)} s` : '–');

export function askedText(r) {
  const i = r.input || {};
  if (r.agent === 'researcher') { const l = leadById(r.lead_id || i.lead_id); return l ? `Research ${leadName(l)}` : 'Research a lead'; }
  if (r.agent === 'briefing') return i.refresh ? 'Morning briefing, refreshed' : 'Morning briefing';
  if (r.agent === 'ask') return str(i.question) ? i.question.trim() : 'A question';
  if (r.agent === 'doer') return str(i.instruction) ? i.instruction.trim() : 'An instruction';
  return 'A run';
}
const short = (t, n = 90) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

const humanKey = (k) => String(k).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
/** Any JSON value as readable text: lists, labelled fields, links. Never innerHTML. */
function readable(v, key = '') {
  if (v === null || v === undefined || v === '') return el('span', { class: 'faint' }, 'none');
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    if (/_id$/.test(key)) {
      const l = leadById(v); if (l) return el('a', { href: `#leads/${l.id}` }, leadName(l));
      const c = rowById('clients', v); if (c) return el('a', { href: `#clients/${c.id}` }, c.name);
      const d = rowById('deals', v); if (d) return el('a', { href: `#pipeline/${d.id}` }, d.title);
    }
    if (key === 'hash' && safeHash(v)) return el('a', { href: safeHash(v) }, v);
    const u = /^https?:\/\//i.test(v) ? safeUrl(v) : null;
    return u ? extLink(u, u) : el('span', { class: 'ag-rd-text' }, v);
  }
  if (Array.isArray(v)) return v.length ? el('ol', { class: 'ag-rd-list' }, v.map((x) => el('li', {}, readable(x, key)))) : el('span', { class: 'faint' }, 'none');
  if (typeof v === 'object') {
    const entries = Object.entries(v);
    if (!entries.length) return el('span', { class: 'faint' }, 'none');
    return el('dl', { class: 'ag-rd' }, entries.map(([k, x]) => [el('dt', {}, humanKey(k)), el('dd', {}, readable(x, k))]));
  }
  return String(v);
}

/* ============================================================ the page */

const ui = { runFilter: 'all', research: null, researchQ: '' };
let doerDraft = '';
let doerLast = null;   // {run_id, note, dropped, actions, at, error}
let doerBusy = false;
const DOER_EXAMPLES = [
  'Set a follow-up for next Tuesday for everyone who went quiet last week',
  'Draft a reply to my newest unread lead offering a call on Thursday',
  'Make a task to send this month’s retainer invoices'
];

const TABS = [['', 'Overview'], ['approvals', 'Approvals'], ['runs', 'Run log'], ['ask', 'Ask'], ['doer', 'Doer']];

export default function agentsView(ctx) {
  const parts = String(ctx.param || '').split('/');
  const tab = ['approvals', 'runs', 'ask', 'doer'].includes(parts[0]) ? parts[0] : '';
  if (parts[0] === 'research' && parts[1]) ui.research = parts[1];
  const runId = tab === 'runs' && parts[1] ? parts[1] : null;

  const root = el('div', { class: 'page ag', dataset: { tab: tab || 'overview' } });
  const head = el('div', { class: 'ag-statusbar' });
  const tabsBox = el('div');
  const body = el('div', { class: 'ag-body' });
  root.append(
    el('header', { class: 'page-head' },
      el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, 'Assistants'), el('h1', { class: 'h1' }, 'Agents'),
        el('p', { class: 'lede ag-lede' }, 'Four assistants on a short leash. They read, research and suggest. Nothing they suggest happens until you approve it, and they never send anything.'))),
    head, tabsBox, body);

  const updaters = [];
  const paintHead = () => {
    const info = agentsInfo();
    const [tone, text] = statusLine(info);
    const waiting = pendingActions().length;
    fill(head,
      el('span', { class: 'ag-stat' }, el('span', { class: `badge is-${tone}`, dataset: { agentsState: info.connected ? (info.master ? 'on' : 'off') : 'not-connected' } }, el('span', { class: 'badge-dot', 'aria-hidden': 'true' }), text)),
      el('span', { class: 'ag-stat ag-spend' },
        el('span', { class: 'muted' }, 'This month'),
        el('span', { class: 'tnum', dataset: { spend: '' } }, `${usd(info.spent)} of ${usd(info.cap)}`),
        meter(info.spent, info.cap)),
      el('a', { class: `ag-stat ag-waiting${waiting ? ' is-on' : ''}`, href: '#agents/approvals', dataset: { waiting: String(waiting) } }, 'Waiting for you: ', el('b', { class: 'tnum' }, num(waiting)), icon('arrow', 13)));
    fill(tabsBox, el('nav', { class: 'tabs ag-tabs', 'aria-label': 'Agents sections' },
      TABS.map(([id, label]) => el('a', { class: `tab${tab === id ? ' is-active' : ''}`, href: id ? `#agents/${id}` : '#agents', 'aria-current': tab === id ? 'page' : null },
        label, id === 'approvals' && waiting ? el('span', { class: 'count' }, num(waiting)) : null))));
  };
  updaters.push(paintHead);

  if (tab === 'approvals') body.append(approvalsView(updaters));
  else if (tab === 'runs') body.append(runId ? runDetail(runId, updaters) : runsView(updaters));
  else if (tab === 'ask' || tab === 'doer') {
    body.append(el('div', { class: 'ag-grid' },
      el('div', { class: 'ag-main' }, gate(updaters), agentSection(AGENT[tab], updaters, { focus: true })),
      el('aside', { class: 'ag-aside' }, rulesPanel())));
  } else {
    body.append(el('div', { class: 'ag-grid' },
      el('div', { class: 'ag-main' }, gate(updaters), AGENTS.map((a) => agentSection(a, updaters))),
      el('aside', { class: 'ag-aside' }, rulesPanel())));
    if (parts[0] === 'research') setTimeout(() => root.querySelector('[data-agent-section="researcher"]')?.scrollIntoView({ block: 'start' }), 60);
  }

  const paint = () => updaters.forEach((u) => { try { u(); } catch (e) { setTimeout(() => { throw e; }, 0); } });
  paint();
  root.onState = paint;
  if (tab === 'ask') setTimeout(() => root.querySelector('.ag-ask-input')?.focus(), 80);
  if (tab === 'doer') setTimeout(() => root.querySelector('.ag-doer-input')?.focus(), 80);
  return root;
}

/** One calm explanation when the agents cannot run, with the way to turn them on. */
function gate(updaters) {
  const box = el('div', { class: 'ag-gate' });
  updaters.push(() => {
    const info = agentsInfo();
    if (info.connected && info.master) { clear(box); box.hidden = true; return; }
    box.hidden = false;
    if (!info.reachable) {
      const again = el('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, icon('refresh', 14), 'Check again');
      again.addEventListener('click', () => busy(again, () => agentStatus()));
      fill(box, el('div', { class: 'callout is-warn', dataset: { gate: 'unreachable' } }, icon('alert', 16), el('div', { class: 'stack tight' },
        el('strong', {}, 'The agents service is not reachable right now.'),
        el('span', {}, 'Nothing is lost. Approvals and the run log still work; the agents themselves come back when the service does.'),
        el('div', { class: 'row' }, again))));
    } else if (!info.connected) {
      fill(box, el('div', { class: 'callout', dataset: { gate: 'not-connected' } }, icon('lock', 16), el('div', { class: 'stack tight' },
        el('strong', {}, 'The agents are not connected yet.'),
        el('span', {}, 'They need the Anthropic API key in Supabase (Edge Functions, Secrets, ANTHROPIC_API_KEY). Once it is there they work from here, within the budget you set in Settings.'),
        el('div', { class: 'row' }, el('a', { class: 'btn btn-ghost btn-sm', href: '#settings' }, icon('settings', 14), 'Open Settings')))));
    } else {
      const on = el('button', { type: 'button', class: 'btn btn-primary btn-sm', dataset: { act: 'agents-on' } }, 'Turn agents on');
      on.addEventListener('click', () => busy(on, async () => {
        try { await saveSettings({ agents_enabled: true }); toast('Agents on'); agentStatus(); } catch (e) { toast(e.message, 'bad'); }
      }));
      fill(box, el('div', { class: 'callout', dataset: { gate: 'off' } }, icon('agents', 16), el('div', { class: 'stack tight' },
        el('strong', {}, 'The agents are switched off.'),
        el('span', {}, 'None of them can run until you turn them on. Each one also has its own switch.'),
        el('div', { class: 'row' }, on, el('a', { class: 'btn btn-ghost btn-sm', href: '#settings' }, 'Agent settings')))));
    }
  });
  return box;
}

/** One agent as an open section: what it does, what it never does, usage, switch, control. */
function agentSection(def, updaters, { focus = false } = {}) {
  const sw = settingSwitch(def.col, def.name);
  const usage = el('p', { class: 'ag-usage small muted' });
  const ctrlBox = el('div', { class: 'ag-ctrl' });
  const offBox = el('p', { class: 'ag-off small muted' });
  const control = buildControl(def.k);
  ctrlBox.append(control.node);
  const node = el('section', { class: `section ag-agent${focus ? ' is-focus' : ''}`, dataset: { agentSection: def.k }, 'aria-labelledby': `ag-h-${def.k}` },
    el('div', { class: 'section-head' },
      el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, def.eyebrow),
        el('h2', { class: 'h2', id: `ag-h-${def.k}` }, def.name)),
      sw),
    el('div', { class: 'ag-terms' },
      el('p', { class: 'ag-does' }, def.does),
      el('p', { class: 'ag-never' }, el('span', { class: 'ag-never-k' }, 'Never'), def.never),
      usage),
    offBox, ctrlBox);
  updaters.push(() => {
    const info = agentsInfo();
    sw.update();
    const last = state.agent_runs.find((r) => r.agent === def.k);
    usage.textContent = '';
    usage.append(
      el('span', { class: 'tnum' }, info.reachable ? `${num(info.runsToday(def.k))} of ${num(info.limit(def.k))} runs today` : `Up to ${num(info.limit(def.k))} runs a day`),
      el('span', { 'aria-hidden': 'true' }, ' · '),
      last ? el('span', {}, `last run ${timeAgo(last.at)}, `, el('span', { class: 'tnum' }, usd(last.cost_usd))) : el('span', {}, 'not run yet'));
    const ready = info.ready(def.k);
    ctrlBox.hidden = !ready;
    offBox.hidden = ready || !info.connected || !info.master;
    offBox.textContent = 'Switched off. Use the switch above to turn it on.';
    if (ready) control.update();
  });
  return node;
}

function buildControl(k) {
  if (k === 'researcher') return researcherControl();
  if (k === 'briefing') return briefingControl();
  if (k === 'ask') return askPanel({ costLabel: usd });
  return doerControl();
}

/* ---------------------------------------------------------------- researcher */
function researcherControl() {
  const search = el('input', { class: 'input', type: 'search', name: 'research-q', placeholder: 'Find a lead to research', 'aria-label': 'Pick a lead to research', autocomplete: 'off', value: ui.researchQ });
  const results = el('ul', { class: 'ag-pick', 'aria-label': 'Matching leads' });
  const chosen = el('div', { class: 'ag-chosen' });
  let chosenKey = '';
  search.addEventListener('input', () => { ui.researchQ = search.value; drawResults(); });

  const pickLead = (id) => { ui.research = id; ui.researchQ = ''; search.value = ''; drawResults(); drawChosen(true); history.replaceState(null, '', `#agents/research/${id}`); };

  function drawResults() {
    const q = ui.researchQ.trim().toLowerCase();
    if (!q) { clear(results); results.hidden = true; return; }
    const hits = state.leads.filter((l) => !l.archived && [l.business, l.contact_name, l.suburb].some((x) => String(x || '').toLowerCase().includes(q))).slice(0, 6);
    results.hidden = false;
    fill(results, hits.length ? hits.map((l) => el('li', {},
      el('button', { type: 'button', class: 'ag-pick-btn', dataset: { lead: l.id }, onClick: () => pickLead(l.id) },
        el('span', { class: 'ag-pick-name' }, leadName(l)),
        el('span', { class: 'small muted' }, [l.suburb, l.website ? hostOf(safeUrl(l.website) || `https://${l.website}`) : 'no website'].filter(Boolean).join(' · ')),
        latestResearch(l.id) ? el('span', { class: 'small faint' }, 'researched') : null)))
      : el('li', { class: 'small muted ag-pick-none' }, 'No lead matches that.'));
  }

  function drawChosen(force = false) {
    const l = ui.research ? leadById(ui.research) : null;
    const r = l ? latestResearch(l.id) : null;
    const key = l ? [l.id, r?.run_id, r?.at, isResearching(l.id), l.hook, l.pain, l.status, l.number_source_url].join('|') : '';
    if (!force && key === chosenKey) return;
    chosenKey = key;
    if (!ui.research) { clear(chosen); return; }
    if (!l) { fill(chosen, el('p', { class: 'small muted' }, 'That lead is not in the hub any more.')); return; }
    const go1 = el('button', { type: 'button', class: `btn ${r ? 'btn-ghost' : 'btn-primary'} btn-sm`, dataset: { act: 'research' }, disabled: isResearching(l.id) || !canResearch(l) || null },
      icon(r ? 'refresh' : 'search', 14), isResearching(l.id) ? 'Researching…' : r ? 'Research again' : `Research ${leadName(l)}`);
    go1.addEventListener('click', () => runResearch(l.id));
    fill(chosen,
      el('div', { class: 'ag-chosen-head' },
        el('div', { class: 'stack tight' },
          el('a', { class: 'ag-chosen-name', href: `#leads/${l.id}` }, leadName(l)),
          el('span', { class: 'small muted' }, [l.contact_name, l.suburb, l.industry].filter(Boolean).join(' · ') || ' ')),
        el('div', { class: 'row' }, go1, el('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Clear the chosen lead', onClick: () => { ui.research = null; drawChosen(true); history.replaceState(null, '', '#agents'); } }, icon('x', 15)))),
      !canResearch(l) ? el('p', { class: 'small muted' }, 'Nothing to look up yet: add their website, or at least the business name and suburb.') : null,
      isResearching(l.id) ? el('p', { class: 'small muted ag-working' }, 'Reading their pages. This takes up to a minute.') : null,
      r ? researchCard(l, r) : !isResearching(l.id) && canResearch(l) ? el('p', { class: 'small muted' }, 'It reads their own website and listing, then reports only what it saw. It writes nothing to the lead.') : null);
  }

  drawResults();
  const node = el('div', { class: 'ag-research', dataset: { agent: 'researcher' } },
    el('label', { class: 'search ag-research-search' }, icon('search', 16), search), results, chosen);
  return { node, update: () => { drawResults(); drawChosen(); } };
}

/* ---------------------------------------------------------------- briefing */
function briefingControl() {
  const node = el('div', { class: 'ag-brief-wrap', dataset: { agent: 'briefing' } });
  let key = null;
  return {
    node,
    update: () => {
      const b = todaysBriefing();
      const k = `${b?.run_id}|${b?.at}|${briefBusy}`;
      if (k === key) return;
      key = k;
      fill(node, briefingPanel());
    }
  };
}

/* ---------------------------------------------------------------- doer */
function doerControl() {
  const box = el('textarea', { class: 'input ag-doer-input', name: 'instruction', rows: 3, maxlength: '600', placeholder: 'e.g. Set a follow-up for Friday for everyone who went quiet after my last text', 'aria-label': 'Tell it what you want set up, in plain words' });
  box.value = doerDraft;
  const count = el('span', { class: 'small faint tnum ag-count' });
  const drawCount = () => { count.textContent = `${box.value.length}/600`; };
  box.addEventListener('input', () => { doerDraft = box.value; drawCount(); });
  const chips = el('div', { class: 'ag-chips', role: 'group', 'aria-label': 'Examples' },
    DOER_EXAMPLES.map((t) => el('button', { type: 'button', class: 'chip', onClick: () => { box.value = t; doerDraft = t; drawCount(); box.focus(); } }, t)));
  const send = el('button', { type: 'submit', class: 'btn btn-primary btn-sm', dataset: { act: 'doer' } }, 'Suggest changes');
  const form = el('form', { class: 'ag-doer-form', novalidate: true }, el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Tell it what you want set up, in plain words'), box), chips,
    el('div', { class: 'row' }, el('span', { class: 'small muted' }, 'It only suggests. You approve each change.'), el('span', { class: 'spacer' }), count, send));
  const out = el('div', { class: 'ag-doer-out', 'aria-live': 'polite' });
  let key = null;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const instruction = box.value.trim();
    if (!instruction) { box.focus(); return; }
    busy(send, async () => {
      doerBusy = true; draw(true);
      const res = await agentRun('doer', { instruction });
      doerBusy = false;
      if (!res.ok) {
        doerLast = { error: res.message, at: new Date().toISOString() };
        toast(res.message, 'bad');
      } else {
        const o = unwrap(res);
        doerLast = { run_id: res.run_id, note: o.note, dropped: Number(res.dropped ?? o.dropped ?? 0) || 0, actions: arr(res.actions ?? o.actions), at: new Date().toISOString(), instruction };
        box.value = ''; doerDraft = ''; drawCount();
      }
      agentStatus();
      draw(true);
    });
  });

  function draw(force = false) {
    const mine = doerLast?.run_id ? state.agent_actions.filter((a) => a.run_id === doerLast.run_id) : [];
    const list = mine.length ? mine : arr(doerLast?.actions).filter((a) => a && a.id);
    const k = `${doerBusy}|${doerLast?.at}|${list.map((a) => `${a.id}:${a.status}`).join(',')}`;
    if (!force && k === key) return;
    key = k;
    if (doerBusy) { fill(out, el('p', { class: 'small muted ag-working' }, 'Reading your hub and working out the changes…')); return; }
    if (!doerLast) { clear(out); return; }
    if (doerLast.error) { fill(out, el('p', { class: 'callout is-warn' }, icon('alert', 15), el('span', {}, doerLast.error))); return; }
    const proposed = list.filter((a) => a.status === 'proposed' || !a.status);
    const decided = list.filter((a) => a.status && a.status !== 'proposed');
    fill(out,
      str(doerLast.note) ? el('div', { class: 'ag-note', dataset: { doerNote: '' } }, el('p', { class: 'ag-rc-label' }, 'Its note'), el('p', {}, doerLast.note.trim())) : null,
      doerLast.dropped ? el('p', { class: 'small muted', dataset: { dropped: String(doerLast.dropped) } }, `${plural(doerLast.dropped, 'suggestion')} broke the rules and ${doerLast.dropped === 1 ? 'was' : 'were'} dropped before reaching you.`) : null,
      !list.length ? el('p', { class: 'small muted' }, 'No changes suggested.') : null,
      proposed.length ? proposalGroup(doerLast.run_id, proposed.map((a) => ({ status: 'proposed', ...a })), { showHead: false }) : null,
      decided.length ? el('ul', { class: 'ag-decided-list' }, decided.map(actionCard)) : null);
  }

  drawCount();
  const node = el('div', { class: 'ag-doer', dataset: { agent: 'doer' } }, form, out);
  return { node, update: () => draw() };
}

/* ---------------------------------------------------------------- approvals */
function approvalsView(updaters) {
  const node = el('div', { class: 'ag-approvals' });
  let key = null;
  updaters.push(() => {
    const k = state.agent_actions.map((a) => `${a.id}:${a.status}`).join(',') + state.agent_runs.length + state.leads.length;
    if (k === key) return;
    key = k;
    const pending = pendingActions();
    const decided = state.agent_actions.filter((a) => a.status !== 'proposed')
      .sort((a, b) => String(b.decided_at || b.created_at).localeCompare(String(a.decided_at || a.created_at)));
    const groups = new Map();
    pending.forEach((a) => { const g = a.run_id || 'none'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(a); });
    fill(node,
      pending.length
        ? el('div', { class: 'stack loose' },
          el('p', { class: 'small muted' }, 'Newest first. Approving makes exactly the change shown, with your own access, and nothing else. Rejecting changes nothing.'),
          [...groups.entries()].map(([runId, list]) => proposalGroup(runId === 'none' ? null : runId, list)))
        : emptyState({ icon: 'check', title: 'Nothing waiting for you', text: 'When the Doer suggests changes they wait here until you approve or reject each one.', action: el('a', { class: 'btn btn-ghost btn-sm', href: '#agents/doer' }, 'Tell the Doer what to set up') }),
      decided.length ? el('details', { class: 'ag-decided-wrap' },
        el('summary', {}, `Decided (${num(decided.length)})`),
        el('ul', { class: 'ag-decided-list' }, decided.slice(0, 100).map(actionCard))) : null);
  });
  return node;
}

/* ---------------------------------------------------------------- run log */
function runsView(updaters) {
  const chips = el('div', { class: 'toolbar ag-run-chips', role: 'group', 'aria-label': 'Filter by agent' });
  const table = el('div', { class: 'table-wrap ag-runs' });
  const totals = el('p', { class: 'small muted tnum' });
  const node = el('div', { class: 'stack' }, el('div', { class: 'row' }, chips, el('span', { class: 'spacer' }), totals), table);
  const draw = () => {
    const all = state.agent_runs;
    fill(chips, [['all', 'All'], ...AGENTS.map((a) => [a.k, a.name])].map(([k, label]) => el('button', {
      type: 'button', class: `chip${ui.runFilter === k ? ' is-active' : ''}`, 'aria-pressed': String(ui.runFilter === k), dataset: { filter: k },
      onClick: () => { ui.runFilter = k; draw(); }
    }, label, el('span', { class: 'count' }, ` ${num(k === 'all' ? all.length : all.filter((r) => r.agent === k).length)}`))));
    const rows = ui.runFilter === 'all' ? all : all.filter((r) => r.agent === ui.runFilter);
    totals.textContent = rows.length ? `${plural(rows.length, 'run')} · ${usd(rows.reduce((t, r) => t + (Number(r.cost_usd) || 0), 0))}` : '';
    if (!rows.length) {
      fill(table, emptyState({ icon: 'list', title: 'No runs yet', text: 'Every run is logged here: what it was asked, what came back, what it read and what it cost, including runs that failed or hit a limit.' }));
      return;
    }
    fill(table, el('table', { class: 'table' },
      el('thead', {}, el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Agent'), el('th', {}, 'Status'), el('th', {}, 'Asked'), el('th', { class: 'num' }, 'Cost'), el('th', { class: 'num' }, 'Time'))),
      el('tbody', {}, rows.map((r) => el('tr', { class: 'is-click', dataset: { run: r.id }, onClick: (e) => { if (!e.target.closest('a')) go(`#agents/runs/${r.id}`); } },
        el('td', { class: 'nowrap' }, el('a', { href: `#agents/runs/${r.id}` }, dateTime(r.at))),
        el('td', { class: 'nowrap' }, AGENT[r.agent]?.name || r.agent),
        el('td', {}, runBadge(r.status)),
        el('td', { class: 'ag-asked' }, short(askedText(r))),
        el('td', { class: 'num nowrap' }, usd(r.cost_usd)),
        el('td', { class: 'num nowrap' }, dur(r.duration_ms)))))));
  };
  let key = null;
  updaters.push(() => { const k = `${state.agent_runs.length}|${state.agent_runs[0]?.id}|${state.agent_runs[0]?.status}`; if (k !== key) { key = k; draw(); } });
  return node;
}

function runDetail(id, updaters) {
  const node = el('div', { class: 'ag-run' });
  let key = null;
  updaters.push(() => {
    const r = state.agent_runs.find((x) => x.id === id);
    const k = r ? `${r.id}|${r.status}` : 'none';
    if (k === key) return;
    key = k;
    if (!r) {
      fill(node, el('a', { class: 'card-link', href: '#agents/runs' }, icon('chevron-left', 14), 'Run log'),
        emptyState({ icon: 'list', title: 'That run is not in the log', text: 'The log keeps the latest 200 runs.' }));
      return;
    }
    const sources = sourcesOf(r.sources);
    const out = unwrap(r.output);
    const cell = (label, value) => el('div', { class: 'ag-run-cell' }, el('span', { class: 'kpi-label' }, label), el('span', { class: 'tnum' }, value));
    fill(node,
      el('a', { class: 'card-link', href: '#agents/runs' }, icon('chevron-left', 14), 'Run log'),
      el('div', { class: 'ag-run-head' },
        el('div', { class: 'stack tight' },
          el('p', { class: 'eyebrow' }, `${AGENT[r.agent]?.name || r.agent} · ${dateTime(r.at)}`),
          el('h2', { class: 'h2' }, short(askedText(r), 140))),
        runBadge(r.status)),
      el('div', { class: 'ag-run-cells' },
        cell('Cost', usd(r.cost_usd)), cell('Time', dur(r.duration_ms)),
        cell('Tokens in', num(r.input_tokens)), cell('Tokens out', num(r.output_tokens)),
        cell('Searches', num(r.searches)), cell('Model', r.model || '–')),
      str(r.error) ? el('p', { class: 'callout is-warn' }, icon('alert', 15), el('span', {}, r.error)) : null,
      el('section', { class: 'ag-run-sec' }, el('p', { class: 'ag-rc-label' }, 'What it was asked'), readable(r.input)),
      el('section', { class: 'ag-run-sec' }, el('p', { class: 'ag-rc-label' }, 'What came back'),
        r.agent === 'researcher' && r.status === 'ok' && r.lead_id && leadById(r.lead_id)
          ? researchCard(leadById(r.lead_id), { out, sources, at: r.at, cost: r.cost_usd })
          : r.agent === 'briefing' && r.status === 'ok' ? briefingBody({ out, at: r.at }) : readable(r.output)),
      el('section', { class: 'ag-run-sec' }, el('p', { class: 'ag-rc-label' }, 'Pages it read'),
        sources.length ? el('ul', { class: 'ag-run-sources' }, sources.map((u) => el('li', {}, extLink(u, u)))) : el('p', { class: 'small muted' }, 'None.')),
      (() => {
        const acts = state.agent_actions.filter((a) => a.run_id === r.id);
        return acts.length ? el('section', { class: 'ag-run-sec' }, el('p', { class: 'ag-rc-label' }, 'What it suggested'),
          el('ul', { class: 'ag-decided-list' }, acts.map((a) => (a.status === 'proposed' ? el('li', { class: 'ag-decided' }, el('span', { class: 'ag-decided-what' }, el('span', { class: 'small faint' }, KIND[a.kind]?.[0] || a.kind), el('span', {}, a.summary)), el('a', { class: 'small ag-open', href: '#agents/approvals' }, 'Waiting for you', icon('arrow', 12))) : actionCard(a))))) : null;
      })());
  });
  return node;
}

/* ---------------------------------------------------------------- rules */
export function rulesPanel() {
  const info = agentsInfo();
  const rule = (title, text) => el('li', {}, el('strong', {}, title), el('span', {}, text));
  return el('section', { class: 'ag-rules', 'aria-labelledby': 'ag-rules-h', dataset: { rules: '' } },
    el('p', { class: 'eyebrow' }, 'Fixed, not settings'),
    el('h2', { class: 'h2', id: 'ag-rules-h' }, 'The rules'),
    el('ol', {},
      rule('They never send.', 'No agent can send a text, an email or an invoice. A drafted reply waits in your inbox reply box for you to read.'),
      rule('Nothing changes without you.', 'An agent can only suggest. A change happens when you press Approve, made with your own access.'),
      rule('Only nine kinds of change.', 'A lead’s status, its follow-up date or personal line, a note, a new task, a new deal, a deal’s stage or next step, a reply draft, a draft invoice.'),
      rule('Never allowed.', 'Sending, deleting, paying, changing settings, marking someone do not contact, or closing a deal as won or lost. Those stay yours.'),
      rule('Contact details stay here.', 'Phone numbers and email addresses are never sent to the AI.'),
      rule('Spending is capped.', `${usd(info.cap)} a month for all four, then they stop until next month. Daily limits: Researcher ${info.limit('researcher')}, Briefing ${info.limit('briefing')}, Ask ${info.limit('ask')}, Doer ${info.limit('doer')}.`),
      rule('Everything is logged.', 'Every run, what it was asked, what it said, what it read and what it cost, including failed runs.')),
    el('a', { class: 'card-link', href: '#agents/runs' }, 'Open the run log', icon('arrow', 14)));
}
