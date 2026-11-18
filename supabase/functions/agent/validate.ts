// Pure rules for the agent function: limits, cost maths, text scrubbing, date windows,
// and the allowlist validator for proposed actions. No Deno APIs, so Node can unit-test it.
import { localParts, startOfLocalDay } from "../_shared/time.ts";

export const AGENTS = ["researcher", "briefing", "ask", "doer"] as const;
export type AgentName = typeof AGENTS[number];

/** Runs per local day, per agent. */
export const DAILY_LIMITS: Record<AgentName, number> = { researcher: 40, briefing: 4, ask: 150, doer: 30 };
export const MAX_TOKENS: Record<AgentName, number> = { researcher: 6000, briefing: 4000, ask: 3000, doer: 6000 };

export const SONNET = "claude-sonnet-5-5";
export const HAIKU = "claude-haiku-5-5";

// US$ per million tokens [input, output]; cache reads at 10% of input; web search $0.01 each.
const PRICE: Record<string, [number, number]> = { haiku: [0.10, 0.50], sonnet: [2, 10], opus: [5, 25] };
export const SEARCH_PRICE = 0.01;

export type Usage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
};

export type Totals = { input: number; cacheWrite: number; cacheRead: number; output: number; searches: number };

export function emptyTotals(): Totals {
  return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, searches: 0 };
}

/** Adds one response's usage to running totals (several calls when a turn is resumed). */
export function addUsage(t: Totals, u: Usage | null | undefined): Totals {
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    input: t.input + n(u?.input_tokens),
    cacheWrite: t.cacheWrite + n(u?.cache_creation_input_tokens),
    cacheRead: t.cacheRead + n(u?.cache_read_input_tokens),
    output: t.output + n(u?.output_tokens),
    searches: t.searches + n(u?.server_tool_use?.web_search_requests),
  };
}

function priceKey(model: string): string {
  return model.includes("haiku") ? "haiku" : model.includes("opus") ? "opus" : "sonnet";
}

/** US dollars for the totals at list price (cache writes billed as input, close enough for logging). */
export function costOf(model: string, t: Totals): number {
  const [pin, pout] = PRICE[priceKey(model)];
  const tokens = ((t.input + t.cacheWrite) * pin + t.cacheRead * pin * 0.1 + t.output * pout) / 1_000_000;
  return Math.round((tokens + t.searches * SEARCH_PRICE) * 1_000_000) / 1_000_000;
}

/** All input tokens, for the run log. */
export function inputTokens(t: Totals): number {
  return t.input + t.cacheWrite + t.cacheRead;
}

// ------------------------------------------------------------------ dates and windows

export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Today's date (YYYY-MM-DD) in the zone. */
export function localDate(now: Date, timeZone: string): string {
  const l = localParts(now, timeZone);
  return `${l.year}-${String(l.month).padStart(2, "0")}-${String(l.day).padStart(2, "0")}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** ISO instant of local midnight: daily limits and the briefing cache count from here. */
export function dayWindowStart(now: Date, timeZone: string): string {
  return startOfLocalDay(now, timeZone || "Australia/Brisbane").toISOString();
}

/** ISO instant of the start of the calendar month in UTC: the monthly budget counts from here. */
export function monthStartUtc(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** True when another run would go over the agent's daily limit. */
export function overDailyLimit(agent: AgentName, runsToday: number): boolean {
  return runsToday >= DAILY_LIMITS[agent];
}

/** True when the month's spend has reached the cap (a cap of 0 blocks everything). */
export function overBudget(spent: number, cap: number): boolean {
  return !(cap > 0) || spent >= cap;
}

// ------------------------------------------------------------------ text scrubbing

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi;
const DOMAIN = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|au|nz|io|co|biz|info|app|dev|me|site|online|store|xyz)(?:\.[a-z]{2})?\b(?:\/[^\s<>"')\]]*)?/gi;
const PHONEISH = /\+?\(?\d[\d\s().-]{5,}\d/g;

/**
 * Removes email addresses, links and phone-like digit runs (8+ digits) from free text,
 * collapses whitespace and cuts to `max` characters. Used on every string that goes to a model.
 */
export function scrubText(v: unknown, max = 200): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  s = s.replace(EMAIL, "[email]");
  s = s.replace(URL_RE, "[link]");
  s = s.replace(DOMAIN, "[link]");
  s = s.replace(PHONEISH, (m) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(m.trim())) return m; // an ISO date, not a number
    return m.replace(/\D/g, "").length >= 8 ? "[number]" : m;
  });
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** True when the string still looks like it holds an email, a link or a phone number. */
export function hasContactDetails(s: string): boolean {
  if (new RegExp(EMAIL.source, "i").test(s)) return true;
  if (/https?:\/\/|www\./i.test(s)) return true;
  for (const m of s.match(PHONEISH) ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(m.trim()) && m.replace(/\D/g, "").length >= 8) return true;
  }
  return false;
}

/** The last three digits of a phone number, or '' (the researcher only ever sees these). */
export function lastThree(phone: unknown): string {
  const d = String(phone ?? "").replace(/\D/g, "");
  return d.length >= 6 ? d.slice(-3) : "";
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

// ------------------------------------------------------------------ request input checks

export type Turn = { role: "user" | "assistant"; text: string };

/**
 * Checks and normalises ask history: ≤10 turns, each text ≤2,000 chars, roles user/assistant.
 * Returns null when the history breaks a rule (→ 400). Leading assistant turns are dropped and
 * consecutive turns from the same side are merged so the messages alternate.
 */
export function normaliseHistory(history: unknown): Turn[] | null {
  if (history === undefined || history === null) return [];
  if (!Array.isArray(history) || history.length > 10) return null;
  const out: Turn[] = [];
  for (const h of history) {
    if (!h || typeof h !== "object") return null;
    const role = (h as Record<string, unknown>).role;
    const text = (h as Record<string, unknown>).text;
    if ((role !== "user" && role !== "assistant") || typeof text !== "string" || text.length > 2000) return null;
    const clean = scrubText(text, 2000);
    if (!clean) continue;
    if (!out.length && role === "assistant") continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.text = `${last.text}\n\n${clean}`;
    else out.push({ role, text: clean });
  }
  return out;
}

// ------------------------------------------------------------------ output checks

export type Linked = { text: string; hash: string };

/** Keeps only items with text and a hash the snapshot provided; at most `max`. */
export function filterLinked(items: unknown, allowed: Set<string>, max: number, textKey = "text"): { kept: Linked[]; dropped: number } {
  const kept: Linked[] = [];
  let dropped = 0;
  for (const it of Array.isArray(items) ? items : []) {
    const r = (it ?? {}) as Record<string, unknown>;
    const text = typeof r[textKey] === "string" ? (r[textKey] as string).trim() : "";
    const hash = typeof r.hash === "string" ? r.hash.trim() : "";
    if (!text || text.length > 400 || !allowed.has(hash) || kept.length >= max) { dropped++; continue; }
    kept.push({ text, hash });
  }
  return { kept, dropped };
}

/** Normalises a URL for comparing what the model cites with what it fetched. */
export function normUrl(u: unknown): string {
  try {
    const x = new URL(String(u));
    x.hash = "";
    const s = `${x.protocol}//${x.host.toLowerCase().replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}${x.search}`;
    return s;
  } catch {
    return "";
  }
}

/** Host of a URL without a leading www., or ''. */
export function hostOf(u: unknown): string {
  try {
    const raw = String(u ?? "").trim();
    if (!raw) return "";
    const x = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return x.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export type Research = {
  observations: { text: string; source_url: string }[];
  hooks: string[];
  pain: string;
  opted_out: boolean;
  opted_out_evidence: string;
  number_published: "yes" | "no" | "unknown";
  number_evidence_url: string;
  could_not_read: string;
};

const GREETING = /^(hi|hey|hello|g'?day|dear|good (morning|afternoon|evening))\b/i;

/**
 * Enforces the researcher's rules on its output: every observation must cite a page that was
 * actually read (`readUrls`, normalised), at most 5; hooks ≤140 chars, no greeting, at most 3,
 * and none at all when no observation survives; evidence URLs must be pages that were read.
 */
export function cleanResearch(raw: unknown, readUrls: Set<string>): { result: Research; dropped: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  let dropped = 0;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const observations: Research["observations"] = [];
  for (const o of Array.isArray(r.observations) ? r.observations : []) {
    const text = str((o as Record<string, unknown>)?.text, 400);
    const url = str((o as Record<string, unknown>)?.source_url, 1000);
    if (!text || !readUrls.has(normUrl(url)) || observations.length >= 5) { dropped++; continue; }
    observations.push({ text, source_url: url });
  }
  const hooks: string[] = [];
  for (const h of Array.isArray(r.hooks) ? r.hooks : []) {
    const t = typeof h === "string" ? h.trim() : "";
    if (!t || t.length > 140 || GREETING.test(t) || !observations.length || hooks.length >= 3) { dropped++; continue; }
    hooks.push(t);
  }
  const np = r.number_published === "yes" || r.number_published === "no" ? r.number_published : "unknown";
  const evidence = str(r.number_evidence_url, 1000);
  const evidenceOk = evidence && readUrls.has(normUrl(evidence));
  return {
    result: {
      observations,
      hooks,
      pain: observations.length ? str(r.pain, 300) : "",
      opted_out: r.opted_out === true,
      opted_out_evidence: str(r.opted_out_evidence, 400),
      number_published: np === "yes" && !evidenceOk ? "unknown" : np,
      number_evidence_url: evidenceOk ? evidence : "",
      could_not_read: str(r.could_not_read, 400) || (observations.length ? "" : "Nothing specific could be confirmed from their pages."),
    },
    dropped,
  };
}

/** Pulls the JSON object out of model text (whole text, else the last {...} block). */
export function extractJson(text: string): unknown {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* fall through */ } }
  const end = t.lastIndexOf("}");
  for (let start = t.lastIndexOf("{", end); start >= 0; start = t.lastIndexOf("{", start - 1)) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch { /* keep widening */ }
  }
  return undefined;
}

// ------------------------------------------------------------------ doer allowlist

export const ACTION_KINDS = [
  "lead.set_status", "lead.set_followup", "lead.set_hook", "note.add",
  "task.create", "deal.create", "deal.update", "message.draft", "invoice.draft",
] as const;
export const LEAD_STATUSES = ["new", "queued", "contacted", "replied", "interested", "booked", "won", "lost"];
export const OPEN_DEAL_STAGES = ["qualified", "proposal", "negotiation"];
export const MAX_ACTIONS = 20;

export type ActionCtx = {
  today: string;                                                       // local YYYY-MM-DD
  leads: Map<string, { status: string; suppressed: boolean }>;          // every lead an action names
  clients: Set<string>;
  projects: Set<string>;
  deals: Map<string, { stage: string }>;
};

export type Proposal = { kind: string; payload: Record<string, unknown>; summary: string; reason: string };
export type Rejection = { index: number; kind: string; why: string };

function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.length <= max ? t : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function present(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

/** Validates one action. Returns the clean payload (only allowlisted keys) or the reason it fails. */
function checkAction(kind: string, p: Record<string, unknown>, ctx: ActionCtx): Record<string, unknown> | string {
  const lead = (id: unknown, opts: { contactable?: boolean } = {}) => {
    if (!isUuid(id)) return "unknown lead";
    const l = ctx.leads.get(id);
    if (!l) return "unknown lead";
    if (l.status === "dnc") return "lead is do-not-contact";
    if (opts.contactable && l.suppressed) return "lead is suppressed";
    return null;
  };
  const client = (id: unknown) => (isUuid(id) && ctx.clients.has(id) ? null : "unknown client");
  const dateIn = (v: unknown, days: number) => isIsoDate(v) && v >= ctx.today && v <= addDays(ctx.today, days);

  switch (kind) {
    case "lead.set_status": {
      const e = lead(p.lead_id); if (e) return e;
      if (!LEAD_STATUSES.includes(String(p.status))) return "status not allowed";
      return { lead_id: p.lead_id, status: p.status };
    }
    case "lead.set_followup": {
      const e = lead(p.lead_id); if (e) return e;
      if (!dateIn(p.date, 90)) return "date must be today to 90 days out";
      return { lead_id: p.lead_id, date: p.date };
    }
    case "lead.set_hook": {
      const e = lead(p.lead_id); if (e) return e;
      const hook = text(p.hook, 160); if (!hook) return "hook empty or over 160 characters";
      return { lead_id: p.lead_id, hook };
    }
    case "note.add": {
      const t = text(p.text, 500); if (!t) return "note empty or over 500 characters";
      const hasLead = present(p.lead_id), hasClient = present(p.client_id);
      if (hasLead === hasClient) return "needs exactly one of lead_id or client_id";
      if (hasLead) { const e = lead(p.lead_id); if (e) return e; return { lead_id: p.lead_id, text: t }; }
      const e = client(p.client_id); if (e) return e;
      return { client_id: p.client_id, text: t };
    }
    case "task.create": {
      const title = text(p.title, 200); if (!title) return "title empty or over 200 characters";
      const out: Record<string, unknown> = { title };
      if (present(p.client_id)) { const e = client(p.client_id); if (e) return e; out.client_id = p.client_id; }
      if (present(p.project_id)) { if (!isUuid(p.project_id) || !ctx.projects.has(p.project_id)) return "unknown project"; out.project_id = p.project_id; }
      if (present(p.due_on)) { if (!dateIn(p.due_on, 365)) return "bad due date"; out.due_on = p.due_on; }
      if (present(p.priority)) { if (!["low", "medium", "high"].includes(String(p.priority))) return "bad priority"; out.priority = p.priority; }
      return out;
    }
    case "deal.create": {
      const title = text(p.title, 200); if (!title) return "title empty or over 200 characters";
      const out: Record<string, unknown> = { title };
      if (present(p.lead_id) && present(p.client_id)) return "deal names both a lead and a client";
      if (present(p.lead_id)) { const e = lead(p.lead_id); if (e) return e; out.lead_id = p.lead_id; }
      if (present(p.client_id)) { const e = client(p.client_id); if (e) return e; out.client_id = p.client_id; }
      for (const k of ["value", "monthly_value"]) {
        if (!present(p[k])) continue;
        const n = num(p[k]); if (n === null || n < 0 || n > 1_000_000) return `bad ${k}`;
        out[k] = n;
      }
      if (present(p.next_step)) { const t = text(p.next_step, 200); if (!t) return "next step over 200 characters"; out.next_step = t; }
      return out;
    }
    case "deal.update": {
      if (!isUuid(p.deal_id) || !ctx.deals.has(p.deal_id)) return "unknown deal";
      if (!OPEN_DEAL_STAGES.includes(ctx.deals.get(p.deal_id)!.stage)) return "deal is closed";
      const out: Record<string, unknown> = { deal_id: p.deal_id };
      if (present(p.stage)) { if (!OPEN_DEAL_STAGES.includes(String(p.stage))) return "stage not allowed (closing a deal is the operator's call)"; out.stage = p.stage; }
      if (present(p.next_step)) { const t = text(p.next_step, 200); if (!t) return "next step over 200 characters"; out.next_step = t; }
      if (present(p.next_step_on)) { if (!dateIn(p.next_step_on, 365)) return "bad next step date"; out.next_step_on = p.next_step_on; }
      if (present(p.probability)) {
        const n = num(p.probability); if (n === null || !Number.isInteger(n) || n < 0 || n > 100) return "probability must be 0-100";
        out.probability = n;
      }
      if (Object.keys(out).length === 1) return "nothing to change";
      return out;
    }
    case "message.draft": {
      const e = lead(p.lead_id, { contactable: true }); if (e) return e;
      const body = text(p.body, 600); if (!body) return "draft empty or over 600 characters";
      return { lead_id: p.lead_id, body };
    }
    case "invoice.draft": {
      const e = client(p.client_id); if (e) return e;
      const description = text(p.description, 200); if (!description) return "description empty or over 200 characters";
      const amount = num(p.amount); if (amount === null || !(amount > 0) || amount > 50_000) return "amount must be over 0 and at most 50,000";
      if (p.kind !== "one_off" && p.kind !== "retainer") return "kind must be one_off or retainer";
      return { client_id: p.client_id, description, amount, kind: p.kind };
    }
    default:
      return "kind not allowed";
  }
}

/**
 * Runs every proposed action through the allowlist. Anything that fails a rule, names an id
 * that does not exist, touches a do-not-contact lead, or comes after the 20th is dropped.
 */
export function validateActions(raw: unknown, ctx: ActionCtx): { valid: Proposal[]; rejected: Rejection[] } {
  const valid: Proposal[] = [];
  const rejected: Rejection[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(raw) ? raw : [];
  list.forEach((a, index) => {
    const r = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
    const kind = typeof r.kind === "string" ? r.kind : "";
    const reject = (why: string) => rejected.push({ index, kind, why });
    if (index >= MAX_ACTIONS) return reject("more than 20 actions");
    if (!(ACTION_KINDS as readonly string[]).includes(kind)) return reject("kind not allowed");
    const payload = r.payload && typeof r.payload === "object" && !Array.isArray(r.payload) ? r.payload as Record<string, unknown> : null;
    if (!payload) return reject("payload missing");
    const summary = text(r.summary, 200);
    if (!summary) return reject("summary empty or over 200 characters");
    const reason = typeof r.reason === "string" ? r.reason.trim().slice(0, 400) : "";
    const out = checkAction(kind, payload, ctx);
    if (typeof out === "string") return reject(out);
    const key = `${kind}:${JSON.stringify(out)}`;
    if (seen.has(key)) return reject("duplicate");
    seen.add(key);
    valid.push({ kind, payload: out, summary, reason });
  });
  return { valid, rejected };
}

/** Turns the model's actions ({kind, payload_json, summary, reason}) into {kind, payload, …}; bad JSON → null payload. */
export function decodeActions(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((a) => {
    if (!a || typeof a !== "object") return a;
    const r = a as Record<string, unknown>;
    let payload: unknown = r.payload;
    if (typeof r.payload_json === "string") {
      try { payload = JSON.parse(r.payload_json); } catch { payload = null; }
    }
    return { kind: r.kind, payload, summary: r.summary, reason: r.reason };
  });
}

/** Every lead/client/project/deal id the proposed actions mention (to look up before validating). */
export function referencedIds(raw: unknown): { leads: string[]; clients: string[]; projects: string[]; deals: string[] } {
  const sets = { leads: new Set<string>(), clients: new Set<string>(), projects: new Set<string>(), deals: new Set<string>() };
  for (const a of Array.isArray(raw) ? raw.slice(0, MAX_ACTIONS) : []) {
    const p = (a as Record<string, unknown>)?.payload as Record<string, unknown> | undefined;
    if (!p || typeof p !== "object") continue;
    if (isUuid(p.lead_id)) sets.leads.add(p.lead_id);
    if (isUuid(p.client_id)) sets.clients.add(p.client_id);
    if (isUuid(p.project_id)) sets.projects.add(p.project_id);
    if (isUuid(p.deal_id)) sets.deals.add(p.deal_id);
  }
  return { leads: [...sets.leads], clients: [...sets.clients], projects: [...sets.projects], deals: [...sets.deals] };
}
