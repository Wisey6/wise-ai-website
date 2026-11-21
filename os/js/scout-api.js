// Lead scout client helpers: the `agent` function's scout doors, for the Scout page and Today.
//   scout_status      settings, this month's spend and cap, last run, how many are waiting
//   scout_candidates  the review queue (status proposed | approved | rejected | expired | all)
//   scout_decide      approve (adds a lead, nothing else) or reject (skip), one or many
//   scout_settings    read, or save a patch of the scout's own settings
//   {agent:'scout'}   look for businesses now (costs money; owner only in the hub)
// Nothing here sends anything to a business: approving only adds a row to Leads.
// Every call resolves (never throws) to the body with `ok`, plus `message` when it failed.
// Imports api.js with the same ?v= stamp as every other module so there is one `state`.
import { fn, state } from './api.js?v=20261119b';

/** Plain-English text for each failure code. */
export const SCOUT_ERRORS = {
  network: 'Cannot reach the hub. Check your connection.',
  unauthorized: 'Your session has expired. Lock and unlock, then try again.',
  bad_request: 'The hub did not accept that. Check the values and try again.',
  owner_only: 'Only the owner can change that.',
  disabled: 'The agents are switched off in Settings, under Agents.',
  ai_not_configured: 'The AI model is not connected yet. See Settings, under Connections.',
  cap_reached: 'This month’s agent budget is used up. Raise it in Settings to keep going.',
  scout_cap_reached: 'The scout’s budget for this month is used up. Raise it below to run it again.',
  daily_limit: 'The scout has run as often as it can today. It resets at midnight.',
  no_brief: 'Write a brief first, so the scout knows what to look for.',
  ai_error: 'The scout hit a problem and stopped. Nothing was charged beyond what it used. Try again in a few minutes.',
  already_decided: 'That one was already decided.',
  not_found: 'That business is no longer in the queue.',
  duplicate: 'That business is already in Leads, so nothing was added.',
  suppressed: 'That number opted out of contact, so it was not added.',
  server_error: 'Something went wrong. Try again in a minute.'
};
export const scoutMessage = (r) => (r && (SCOUT_ERRORS[r.error] || r.detail || r.message)) || SCOUT_ERRORS.server_error;

async function call(body) {
  const { status, data } = await fn('agent', body);
  const res = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  // A batch decision answers 200 with a result per id even when some failed.
  if (status === 200 && (res.ok === true || Array.isArray(res.results))) return res;
  const error = res.error || (status === 0 ? 'network' : status === 401 ? 'unauthorized' : status === 403 ? 'disabled' : 'server_error');
  const out = { ...res, ok: false, error };
  out.message = scoutMessage(out);
  return out;
}

/** {ok, settings, spent_usd, cap_usd, runs_this_month, last_run:{at,status,kept}|null, waiting, schedule_now} */
export const scoutStatus = () => call({ action: 'scout_status' });

/** {ok, items[], next_before}. status defaults to 'proposed'. */
export function scoutCandidates({ status = 'proposed', limit = 50, before, run_id: runId } = {}) {
  const body = { action: 'scout_candidates', status, limit };
  if (before) body.before = before;
  if (runId) body.run_id = runId;
  return call(body);
}

/**
 * Approve or skip one or many. One id → {ok, status, lead_id?, hash?, business, change_id?};
 * several → {ok, results[], approved, rejected}. `reason` is kept for skips (it teaches the scout).
 */
export function scoutDecide(ids, decision, reason) {
  const list = [].concat(ids).filter(Boolean);
  const body = { action: 'scout_decide', decision };
  if (list.length === 1) body.candidate_id = list[0]; else body.candidate_ids = list;
  if (reason) body.reason = String(reason).slice(0, 300);
  return call(body);
}

/** Read (no patch) or save a patch. → {ok, settings, can_change_cap}. */
export const scoutSettings = (patch) => call(patch ? { action: 'scout_settings', patch } : { action: 'scout_settings' });

/** Look for businesses now. → {ok, run_id, kept, found, dropped[], candidate_ids[], cost_usd, searches, fetches} */
export const scoutRun = ({ count = 5 } = {}) => call({ agent: 'scout', count });

/* ------------------------------------------------------------ what Today and the sidebar count */
// Each candidate waiting for review has a hub card in agent_actions (kind 'lead.add'), which
// realtime keeps live in state.agent_actions. Counting those needs no extra call.
export const SCOUT_KIND = 'lead.add';
export const scoutWaiting = () => (state.agent_actions || []).filter((a) => a.kind === SCOUT_KIND && a.status === 'proposed').length;
/** A short fingerprint of the waiting cards, so the Scout page knows when the scout found more. */
export const scoutStamp = () => (state.agent_actions || []).filter((a) => a.kind === SCOUT_KIND).map((a) => `${a.id}:${a.status}`).join(',');
/** The latest scout run in the run log (has its cost), or null. */
export const lastScoutRun = () => (state.agent_runs || []).find((r) => r.agent === 'scout') || null;
