// The lead scout (agent 'scout'): searches the web for local businesses that fit the owner's brief and
// puts each verified one in the review queue (public.lead_candidates) with a hub approval card
// (agent_actions 'lead.add'). Deno module; the pure rules are in scout-rules.ts.
//
// ─── GUARANTEES (in code) ─────────────────────────────────────────────────────────────────
//  1. It never creates a lead by itself and never contacts anyone. A lead is made only by
//     decideCandidate(... 'approve'), called by a person: the hub button, a signed email link that
//     the owner presses on a confirmation page (POST, single use, 7 days), or the chat.
//  2. Only what public pages show: the number must be on a page the run read, and the page text
//     (the scout's own fetch result, or our own GET of it) must show that number; observations must
//     cite pages it read; the business name must appear on the page. Otherwise the candidate is dropped.
//  3. No duplicates: phone, website host and fuzzy name + suburb against leads, clients, suppressions
//     and every earlier candidate (rejected ones included). Suppressed numbers never come back.
//  4. Money: its own monthly cap (settings.scout_monthly_cap_usd) AND the global agent cap, checked
//     before any model call; searches and fetches per batch are capped.
// ────────────────────────────────────────────────────────────────────────────────────────────
import Anthropic from "npm:@anthropic-ai/sdk@0";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { HAIKU, SONNET, type Totals, addUsage, costOf, dayWindowStart, emptyTotals, extractJson, inputTokens, localDate, monthStartUtc } from "./validate.ts";
import {
  BATCH_SIZE, type Candidate, type Known, type LinkRow, SCOUT_SCHEMA, SCOUT_SYSTEM, auPhone, businessOnPage, checkCandidate, checkLink,
  duplicateOf, nameOnPage, normUrl, numberOnPage, ownHost, saysNoContact, scoutRequest, signLink,
} from "./scout-rules.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
// deno-lint-ignore no-explicit-any
type Msg = any;

export const SCOUT_MODEL = SONNET; // chosen after measuring Haiku vs Sonnet (README, scout section)
export const DECIDE_PAGE = "https://wise-ai.au/decide.html";
export const HUB = "https://wise-ai.au/os/";
const SEARCH_CAP = 5;              // web searches per batch ($0.01 each)
const FETCH_CAP = 8;               // page fetches per batch
const MODEL_DEADLINE_MS = 110_000; // no model call starts after this (the function stops at 150 s)
const DAY_RUN_LIMIT = 8;           // scout batches per local day (schedule + on demand)

const must = <T>(res: { data: T | null; error: { message: string } | null }): T => {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
};

export type ScoutCtx = { db: SupabaseClient; settings: Row; tz: string; now: Date; started: number };
export type ScoutOpts = { trigger: "manual" | "schedule" | "chat"; count: number; brief?: string | null; memberId?: string | null; model?: string; notify?: boolean };

// ------------------------------------------------------------------ budget

async function spend(db: SupabaseClient, now: Date): Promise<{ all: number; scout: number }> {
  const rows = must<Row[]>(await db.from("agent_runs").select("agent, cost_usd").gte("at", monthStartUtc(now)));
  let all = 0, scout = 0;
  for (const r of rows) { const c = Number(r.cost_usd || 0); all += c; if (r.agent === "scout") scout += c; }
  return { all, scout };
}

/** Why a scout run may not start now (budget, daily runs), or null. */
export async function scoutBlocked(ctx: ScoutCtx): Promise<string | null> {
  const s = await spend(ctx.db, ctx.now);
  const scoutCap = Number(ctx.settings.scout_monthly_cap_usd ?? 10);
  const cap = Number(ctx.settings.agent_monthly_cap_usd ?? 0);
  if (!(scoutCap > 0) || s.scout >= scoutCap) return "scout_cap_reached";
  if (!(cap > 0) || s.all >= cap) return "cap_reached";
  const runs = must<Row[]>(await ctx.db.from("agent_runs").select("status").eq("agent", "scout").gte("at", dayWindowStart(ctx.now, ctx.tz)));
  if (runs.filter((r) => r.status !== "capped").length >= DAY_RUN_LIMIT) return "daily_limit";
  return null;
}

// ------------------------------------------------------------------ what is already known

async function loadKnown(db: SupabaseClient): Promise<{ known: Known; names: string[] }> {
  const [leads, clients, supp, cands] = await Promise.all([
    db.from("leads").select("business, suburb, phone, website").limit(20000),
    db.from("clients").select("name, suburb, phone, website").limit(5000),
    db.from("suppressions").select("phone").limit(50000),
    db.from("lead_candidates").select("business, suburb, phone, website_host, status").limit(20000),
  ]);
  const known: Known = { phones: new Set(), hosts: new Set(), names: [], suppressed: new Set() };
  const names: string[] = [];
  const addPhone = (p: unknown) => { const x = auPhone(p); if (x) known.phones.add(x.e164); else if (typeof p === "string" && p) known.phones.add(p); };
  for (const l of must<Row[]>(leads)) {
    addPhone(l.phone); const h = ownHost(l.website); if (h) known.hosts.add(h);
    if (l.business) { known.names.push({ business: l.business, suburb: l.suburb, what: "a lead" }); names.push(`${l.business}${l.suburb ? ` (${l.suburb})` : ""}`); }
  }
  for (const c of must<Row[]>(clients)) {
    addPhone(c.phone); const h = ownHost(c.website); if (h) known.hosts.add(h);
    if (c.name) { known.names.push({ business: c.name, suburb: c.suburb, what: "a client" }); names.push(`${c.name}${c.suburb ? ` (${c.suburb})` : ""}`); }
  }
  for (const s of must<Row[]>(supp)) { addPhone(s.phone); known.suppressed.add(String(s.phone)); }
  for (const c of must<Row[]>(cands)) {
    known.phones.add(String(c.phone)); if (c.website_host) known.hosts.add(c.website_host);
    known.names.push({ business: c.business, suburb: c.suburb, what: `an earlier suggestion, ${c.status}` });
    names.push(`${c.business}${c.suburb ? ` (${c.suburb})` : ""}`);
  }
  return { known, names: names.slice(-150) };
}

// ------------------------------------------------------------------ reading what the scout read

/** Every URL the run read (fetched pages and search results) and the text of fetched pages. */
export function readPages(content: Msg[]): { urls: Set<string>; text: Map<string, string>; searches: number; fetches: number } {
  const urls = new Set<string>();
  const text = new Map<string, string>();
  let searches = 0, fetches = 0;
  const asked: Record<string, string> = {};
  const walk = (b: Msg) => {
    if (!b || typeof b !== "object") return;
    if (b.type === "server_tool_use") {
      if (b.name === "web_search") searches++;
      if (b.name === "web_fetch") { fetches++; asked[b.id] = String(b.input?.url ?? ""); }
    }
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) if (r?.url) urls.add(normUrl(r.url));
    }
    if (b.type === "web_fetch_tool_result") {
      const c = b.content ?? {};
      if (c.type === "web_fetch_result") {
        const url = String(c.url ?? asked[b.tool_use_id] ?? "");
        const doc = c.content ?? {};
        const data = doc?.source?.type === "text" ? String(doc.source.data ?? "") : typeof doc?.source?.data === "string" && doc.source.media_type?.startsWith("text") ? doc.source.data : "";
        for (const u of [url, asked[b.tool_use_id]]) {
          const n = normUrl(u);
          if (!n) continue;
          urls.add(n);
          if (data) text.set(n, (text.get(n) ?? "") + "\n" + data);
        }
      }
    }
  };
  for (const b of content) walk(b);
  urls.delete("");
  return { urls, text, searches, fetches };
}

/** Our own GET of a public page (for numbers the scout saw only in search results). Text only, 8 s, 1.5 MB. */
async function getPage(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; WiseAI-LeadCheck/1.0; +https://wise-ai.au)", accept: "text/html,text/plain" }, redirect: "follow", signal: AbortSignal.timeout(8000) });
    if (!r.ok || !/text|html/i.test(r.headers.get("content-type") ?? "")) return null;
    const buf = new Uint8Array(await r.arrayBuffer()).slice(0, 1_500_000);
    const html = new TextDecoder().decode(buf);
    // tel: links count as published numbers.
    const tels = [...html.matchAll(/href=["']tel:([^"']+)["']/gi)].map((m) => m[1]).join(" ");
    return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ") + " " + tels;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ the run

function client(timeout: number) {
  return new Anthropic({ maxRetries: 1, timeout });
}

function scoutTools(model: string, basic: boolean): Row[] {
  if (basic || model === HAIKU) {
    return [
      { type: "web_search_20250305", name: "web_search", max_uses: SEARCH_CAP, user_location: { type: "approximate", city: "Brisbane", region: "Queensland", country: "AU", timezone: "Australia/Brisbane" } },
      { type: "web_fetch_20250910", name: "web_fetch", max_uses: FETCH_CAP, max_content_tokens: 6000 },
    ];
  }
  return [
    { type: "web_search_20260209", name: "web_search", max_uses: SEARCH_CAP, user_location: { type: "approximate", city: "Brisbane", region: "Queensland", country: "AU", timezone: "Australia/Brisbane" } },
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: FETCH_CAP, max_content_tokens: 6000 },
  ];
}

export type ScoutResult = {
  ok: boolean; error?: string; run_id: string | null; model: string; cost_usd: number;
  found: number; kept: number; dropped: { business: string; why: string }[]; candidate_ids: string[];
  searches: number; fetches: number; emailed?: boolean;
};

async function logRun(db: SupabaseClient, r: Row): Promise<string | null> {
  const { data, error } = await db.from("agent_runs").insert({ agent: "scout", ...r }).select("id").single();
  if (error) { console.error("scout run insert", error.message); return null; }
  return String(data.id);
}

export async function runScout(ctx: ScoutCtx, o: ScoutOpts): Promise<ScoutResult> {
  const { db, settings } = ctx;
  const count = Math.max(1, Math.min(BATCH_SIZE + 4, Math.round(o.count || 5)));
  const model = o.model === HAIKU ? HAIKU : SCOUT_MODEL;
  const brief = String(o.brief || settings.scout_brief || "").trim();
  const base = { input: { trigger: o.trigger, count, brief_override: Boolean(o.brief), model } };
  const empty = (error: string, status = "capped"): Promise<ScoutResult> => logRun(db, { status, error, ...base, duration_ms: Date.now() - ctx.started })
    .then((id) => ({ ok: false, error, run_id: id, model, cost_usd: 0, found: 0, kept: 0, dropped: [], candidate_ids: [], searches: 0, fetches: 0 }));
  if (!brief) return empty("no_brief", "empty");
  const blocked = await scoutBlocked(ctx);
  if (blocked) return empty(blocked);

  // Old suggestions nobody decided on expire (their hub cards go too).
  const expired = must<Row[]>(await db.from("lead_candidates").update({ status: "expired", decided_via: "system", decided_at: new Date().toISOString() })
    .eq("status", "proposed").lt("expires_at", new Date().toISOString()).select("action_id"));
  const expiredActions = expired.map((e) => e.action_id).filter(Boolean);
  if (expiredActions.length) await db.from("agent_actions").update({ status: "rejected", result: "Expired", decided_at: new Date().toISOString() }).in("id", expiredActions).eq("status", "proposed");

  const { known, names } = await loadKnown(db);
  const rejected = must<Row[]>(await db.from("lead_candidates").select("industry, suburb, reject_reason").eq("status", "rejected")
    .not("reject_reason", "is", null).neq("reject_reason", "test").order("decided_at", { ascending: false }).limit(30))
    .map((r) => ({ industry: r.industry, suburb: r.suburb, reason: String(r.reject_reason).slice(0, 200) }));
  const runId = await logRun(db, { status: "error", error: "running", ...base });

  const user = { role: "user", content: scoutRequest({ brief, count, known: names, rejected, today: localDate(ctx.now, ctx.tz) }) };
  let totals: Totals = emptyTotals();
  let content: Msg[] = [];
  let usedModel = model;
  let structured = true, basic = false;
  let res: Msg = null;
  const params = () => ({
    model, max_tokens: 12000, tools: scoutTools(model, basic),
    system: structured ? SCOUT_SYSTEM : `${SCOUT_SYSTEM}\nReply with one JSON object: {"candidates": [...], "notes": "..."} and nothing else.`,
    output_config: structured ? { effort: "low", format: { type: "json_schema", schema: SCOUT_SCHEMA } } : { effort: "low" },
    messages: content.length ? [user, { role: "assistant", content }] : [user],
  });
  const update = (r: Row) => runId ? db.from("agent_runs").update({ ...r, duration_ms: Date.now() - ctx.started }).eq("id", runId) : Promise.resolve();
  try {
    for (let i = 0; i < 6; i++) {
      const left = MODEL_DEADLINE_MS - (Date.now() - ctx.started);
      if (i > 0 && left < 15_000) break;
      try {
        // deno-lint-ignore no-explicit-any
        res = await client(Math.max(20_000, left + 15_000)).messages.create(params() as any);
      } catch (e) {
        if (e instanceof Anthropic.BadRequestError && structured && /format|output|schema|structured/i.test(e.message)) { structured = false; i--; continue; }
        if (e instanceof Anthropic.BadRequestError && !basic && /web_(search|fetch)_2026|tool type|not supported/i.test(e.message)) { basic = true; i--; continue; }
        throw e;
      }
      totals = addUsage(totals, res.usage);
      usedModel = String(res.model ?? model);
      content = [...content, ...res.content];
      await update({ model: usedModel, input_tokens: inputTokens(totals), output_tokens: totals.output, searches: totals.searches, cost_usd: costOf(usedModel, totals) });
      if (res.stop_reason !== "pause_turn") break;
    }
  } catch (e) {
    const cost = costOf(usedModel, totals);
    await update({ status: "error", error: `ai_error: ${(e as Error).message}`.slice(0, 500), cost_usd: cost });
    return { ok: false, error: "ai_error", run_id: runId, model: usedModel, cost_usd: cost, found: 0, kept: 0, dropped: [], candidate_ids: [], searches: totals.searches, fetches: 0 };
  }

  const read = readPages(content);
  if (!totals.searches && read.searches) totals = { ...totals, searches: read.searches };
  let lastTool = -1;
  content.forEach((b, i) => { if (!["text", "thinking", "redacted_thinking"].includes(b.type)) lastTool = i; });
  const tail = content.slice(lastTool + 1).filter((b) => b.type === "text").map((b) => b.text).join("") || content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const out = extractJson(tail) as Row | undefined;
  const raw = Array.isArray(out?.candidates) ? out!.candidates : [];

  // Check each candidate: shape and sources, duplicates, then the page itself.
  const dropped: { business: string; why: string }[] = [];
  const keep: Candidate[] = [];
  const batchKnown: Known = { ...known, phones: new Set(known.phones), hosts: new Set(known.hosts), names: [...known.names] };
  const pages = new Map<string, string | null>();
  for (const r of raw.slice(0, count + 4)) {
    const name = String(r?.business ?? "?").slice(0, 80);
    const chk = checkCandidate(r, read.urls);
    if (!chk.ok) { dropped.push({ business: name, why: chk.why }); continue; }
    const c = chk.c;
    const dup = duplicateOf(c, batchKnown);
    if (dup) { dropped.push({ business: name, why: dup }); continue; }
    const key = normUrl(c.number_source_url);
    let page = read.text.get(key) ?? null;
    if (!page || !numberOnPage(page, auPhone(c.phone)!)) {
      if (!pages.has(key)) pages.set(key, await getPage(c.number_source_url));
      page = pages.get(key) ?? page;
    }
    if (!page) { dropped.push({ business: name, why: "could not open the page that shows the number" }); continue; }
    if (!numberOnPage(page, auPhone(c.phone)!)) { dropped.push({ business: name, why: "number not on the cited page" }); continue; }
    if (saysNoContact(page)) { dropped.push({ business: name, why: "page says no unsolicited contact" }); continue; }
    if (!businessOnPage(page, c.business)) { dropped.push({ business: name, why: "business name not on the cited page" }); continue; }
    c.contact_first_name = nameOnPage(page, c.contact_first_name);
    keep.push(c);
    batchKnown.phones.add(c.phone);
    if (c.website_host) batchKnown.hosts.add(c.website_host);
    batchKnown.names.push({ business: c.business, suburb: c.suburb, what: "this batch" });
    if (keep.length >= count) break;
  }

  // Into the queue, each with a hub approval card.
  const ids: string[] = [];
  for (const c of keep) {
    const ins = await db.from("lead_candidates").insert({ ...c, run_id: runId }).select("id").single();
    if (ins.error) { dropped.push({ business: c.business, why: `could not save (${ins.error.code ?? "db"})` }); continue; }
    const id = String(ins.data.id);
    ids.push(id);
    const act = await db.from("agent_actions").insert({
      run_id: runId, kind: "lead.add", status: "proposed",
      payload: { candidate_id: id, business: c.business, suburb: c.suburb, industry: c.industry, score: c.score, hook: c.hook, phone_kind: c.phone_kind },
      summary: `New lead: ${c.business}${c.suburb ? `, ${c.suburb}` : ""} (fit ${c.score}/100)`.slice(0, 200),
      reason: [c.score_reason, c.observations[0]?.text].filter(Boolean).join(" · ").slice(0, 400) || null,
    }).select("id").single();
    if (!act.error) await db.from("lead_candidates").update({ action_id: act.data.id }).eq("id", id);
  }
  const cost = costOf(usedModel, totals);
  await update({
    status: keep.length ? "ok" : "empty", error: null, model: usedModel, input_tokens: inputTokens(totals), output_tokens: totals.output,
    searches: totals.searches, cost_usd: cost,
    output: { found: raw.length, kept: ids.length, candidate_ids: ids, dropped, searches: read.searches, fetches: read.fetches, structured, basic_tools: basic, notes: String(out?.notes ?? "").slice(0, 500), stop: res?.stop_reason ?? null },
    sources: [...read.urls].slice(0, 60).map((url) => ({ kind: "read", url })),
  });
  return { ok: true, run_id: runId, model: usedModel, cost_usd: cost, found: raw.length, kept: ids.length, dropped, candidate_ids: ids, searches: totals.searches, fetches: read.fetches };
}

// ------------------------------------------------------------------ decisions (one path for hub, email and chat)

export type Decision = { ok: true; status: string; lead_id?: string; hash?: string; business: string; draft_proposed?: boolean } | { ok: false; error: string; status?: string; business?: string; lead_id?: string };

export async function decideCandidate(db: SupabaseClient, id: string, decision: "approve" | "reject", by: { memberId: string | null; via: "hub" | "email" | "chat" }, reason?: string | null): Promise<Decision> {
  const now = new Date().toISOString();
  const claim = must<Row[]>(await db.from("lead_candidates").update({
    status: decision === "approve" ? "approved" : "rejected", decided_at: now, decided_by: by.memberId, decided_via: by.via,
    ...(decision === "reject" ? { reject_reason: reason ? String(reason).replace(/\s+/g, " ").trim().slice(0, 300) || null : null } : {}),
  }).eq("id", id).eq("status", "proposed").select("*"));
  if (!claim.length) {
    const cur = must<Row | null>(await db.from("lead_candidates").select("status, business, lead_id").eq("id", id).maybeSingle());
    return cur ? { ok: false, error: "already_decided", status: cur.status, business: cur.business, lead_id: cur.lead_id ?? undefined } : { ok: false, error: "not_found" };
  }
  const c = claim[0];
  const closeCard = (status: string, result: string) => c.action_id
    ? db.from("agent_actions").update({ status, result, decided_at: now }).eq("id", c.action_id).eq("status", "proposed") : Promise.resolve();
  if (decision === "reject") {
    await closeCard("rejected", reason ? `Skipped: ${String(reason).slice(0, 200)}` : "Skipped");
    return { ok: true, status: "rejected", business: c.business };
  }
  const undo = async (why: string, leadId?: string) => {
    await db.from("lead_candidates").update({ status: "rejected", reject_reason: why, decided_via: "system", lead_id: leadId ?? null }).eq("id", id);
    await closeCard("failed", why);
  };
  // The same checks as any new lead: never a suppressed number, never a second copy of a lead.
  const sup = must<Row | null>(await db.from("suppressions").select("phone").eq("phone", c.phone).maybeSingle());
  if (sup) { await undo("suppressed: this number opted out"); return { ok: false, error: "suppressed", business: c.business }; }
  const existing = must<Row[]>(await db.from("leads").select("id, business, suburb, website, phone").or(`phone.eq.${c.phone}${c.website_host ? `,website.ilike.%${c.website_host}%` : ""}`).limit(5));
  if (existing.length) { await undo("already a lead", existing[0].id); return { ok: false, error: "duplicate", business: c.business, lead_id: existing[0].id }; }
  const obs = (c.observations ?? []) as { text: string; source_url: string }[];
  const notes = [
    `${localDate(new Date(), "Australia/Brisbane")}: found by the lead scout${c.score ? ` (fit ${c.score}/100${c.score_reason ? `: ${c.score_reason}` : ""})` : ""}.`,
    ...obs.map((o) => `- ${o.text} (${o.source_url})`),
    c.value_reasoning ? `Value estimate: ${c.value_reasoning}` : "",
    `Number published at: ${c.number_source_url}`,
  ].filter(Boolean).join("\n");
  const ins = await db.from("leads").insert({
    business: c.business, contact_name: c.contact_first_name, phone: c.phone, website: c.website, suburb: c.suburb, industry: c.industry,
    source: "scout", number_source_url: c.number_source_url, status: "new", hook: c.hook, pain: c.pain, est_monthly_value: c.est_monthly_value,
    owner_id: by.memberId, notes,
  }).select("id").single();
  if (ins.error) {
    if (ins.error.code === "23505") { await undo("already a lead (same phone)"); return { ok: false, error: "duplicate", business: c.business }; }
    await db.from("lead_candidates").update({ status: "proposed", decided_at: null, decided_by: null, decided_via: null }).eq("id", id);
    throw new Error(ins.error.message);
  }
  const leadId = String(ins.data.id);
  await db.from("lead_candidates").update({ lead_id: leadId }).eq("id", id);
  await closeCard("applied", "Lead added");
  await db.from("events").insert({ kind: "scout", lead_id: leadId, summary: `Lead scout: ${c.business} approved (${by.via})`.slice(0, 500) });
  // The next step, still behind a person: a first text as a DRAFT proposal (mobiles only; sms-send's rules apply when sent).
  let draft = false;
  if (c.phone_kind === "mobile" && c.first_text) {
    const d = await db.from("agent_actions").insert({
      run_id: c.run_id, kind: "message.draft", status: "proposed", payload: { lead_id: leadId, body: String(c.first_text).slice(0, 600) },
      summary: `First text for ${c.business} (a draft; nothing is sent)`.slice(0, 200), reason: c.hook ? `From the scout's hook: ${c.hook}` : null,
    });
    draft = !d.error;
  }
  return { ok: true, status: "approved", lead_id: leadId, hash: `#leads/${leadId}`, business: c.business, draft_proposed: draft };
}

// ------------------------------------------------------------------ email links and the digest

let linkKey: string | null = null;
async function key(db: SupabaseClient): Promise<string> {
  if (linkKey) return linkKey;
  const { data, error } = await db.rpc("scout_secret", { p_name: "scout_link_key" });
  if (error || !data) throw new Error("scout link key missing");
  linkKey = String(data);
  return linkKey;
}

export async function makeLink(db: SupabaseClient, action: "approve" | "skip" | "approve_all", memberId: string, target: { candidate?: string; run?: string; ids?: string[] }): Promise<string> {
  const { data, error } = await db.rpc("scout_link_create", { p_action: action, p_candidate: target.candidate ?? null, p_run: target.run ?? null, p_member: memberId, p_ids: target.ids ?? null });
  if (error) throw new Error(error.message);
  const token = await signLink(await key(db), { id: String(data), action, candidate_id: target.candidate ?? null, run_id: target.run ?? null, member_id: memberId });
  return `${DECIDE_PAGE}#${token}`;
}

/** What a link does, for the confirmation page (it does not use the link). */
export async function linkPeek(db: SupabaseClient, token: string): Promise<Row> {
  const id = token.split(".")[0];
  const { data } = /^[0-9a-f-]{36}$/i.test(id) ? await db.rpc("scout_link_get", { p_id: id }) : { data: null };
  const row = data as LinkRow & { candidate_ids?: string[] | null } | null;
  const bad = await checkLink(await key(db), token, row);
  if (bad && bad !== "used") return { ok: false, error: bad };
  const ids = row!.action === "approve_all" ? (row!.candidate_ids ?? []) : [row!.candidate_id];
  const items = must<Row[]>(await db.from("lead_candidates").select("id, business, suburb, industry, score, hook, status, lead_id").in("id", ids.filter(Boolean)));
  return { ok: true, action: row!.action, used: Boolean(row!.used_at), expires_at: row!.expires_at, items: items.map((i) => ({ ...i, open: i.lead_id ? `${HUB}#leads/${i.lead_id}` : null })), hub: `${HUB}#agents/approvals` };
}

/** Uses a link once (POST from the confirmation page's button). */
export async function linkApply(db: SupabaseClient, token: string, reason?: string | null): Promise<Row> {
  const id = token.split(".")[0];
  const { data } = /^[0-9a-f-]{36}$/i.test(id) ? await db.rpc("scout_link_get", { p_id: id }) : { data: null };
  const row = data as LinkRow & { candidate_ids?: string[] | null } | null;
  const bad = await checkLink(await key(db), token, row);
  if (bad) return { ok: false, error: bad };
  const used = must<Row | null>(await db.rpc("scout_link_use", { p_id: id }));
  if (!used) return { ok: false, error: "used" };
  const by = { memberId: row!.member_id, via: "email" as const };
  const ids = row!.action === "approve_all" ? (row!.candidate_ids ?? []) : [String(row!.candidate_id)];
  const results: Row[] = [];
  for (const cid of ids) {
    const d = await decideCandidate(db, cid, row!.action === "skip" ? "reject" : "approve", by, row!.action === "skip" ? reason : null);
    results.push({ ...d, open: "lead_id" in d && d.lead_id ? `${HUB}#leads/${d.lead_id}` : null });
  }
  await db.rpc("scout_link_result", { p_id: id, p_result: { at: new Date().toISOString(), results: results.map((r) => ({ ok: r.ok, status: r.status ?? r.error })) } });
  return { ok: true, action: row!.action, results, hub: `${HUB}#agents/approvals` };
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));

/** Emails the owner the candidates (Resend, the PIN-reset sender) with Approve / Skip links. */
export async function sendDigest(db: SupabaseClient, candidateIds: string[], headline: string): Promise<{ sent: boolean; why?: string }> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) return { sent: false, why: "email_not_configured" };
  const { data: owner } = await db.rpc("scout_owner_contact");
  const to = owner?.email ? String(owner.email) : "";
  if (!to || !owner?.member_id) return { sent: false, why: "no_owner_email" };
  const cands = must<Row[]>(await db.from("lead_candidates").select("*").in("id", candidateIds).eq("status", "proposed").order("score", { ascending: false }));
  if (!cands.length) return { sent: false, why: "nothing_to_send" };
  const member = String(owner.member_id);
  const rows: string[] = [], lines: string[] = [];
  for (const c of cands) {
    const [yes, no] = await Promise.all([makeLink(db, "approve", member, { candidate: c.id }), makeLink(db, "skip", member, { candidate: c.id })]);
    const why = [c.score_reason, (c.observations ?? [])[0]?.text].filter(Boolean).join(" ");
    rows.push(`<tr><td style="padding:14px 0;border-top:1px solid #e6e6e6">
<div style="font-size:16px;font-weight:600">${esc(c.business)}</div>
<div style="color:#666;font-size:13px">${esc([c.suburb, c.industry, c.phone_kind === "mobile" ? "mobile listed" : "office number listed"].filter(Boolean).join(" · "))} · fit ${esc(c.score)}/100</div>
<div style="margin:6px 0;font-size:14px">${esc(why)}</div>
${c.hook ? `<div style="margin:6px 0;font-size:14px;color:#333">Hook: <em>${esc(c.hook)}</em></div>` : ""}
${c.est_monthly_value ? `<div style="font-size:13px;color:#666">Worth to them: about $${esc(Number(c.est_monthly_value).toLocaleString("en-AU"))}/month</div>` : ""}
<div style="margin-top:8px"><a href="${esc(yes)}" style="background:#111;color:#fff;padding:7px 14px;border-radius:6px;text-decoration:none;font-size:14px">Approve</a>
&nbsp; <a href="${esc(no)}" style="color:#111;padding:7px 10px;font-size:14px">Skip</a></div></td></tr>`);
    lines.push(`${c.business} (${[c.suburb, c.industry].filter(Boolean).join(", ")}), fit ${c.score}/100\n  ${why}\n  Hook: ${c.hook ?? "-"}\n  Approve: ${yes}\n  Skip: ${no}`);
  }
  const all = await makeLink(db, "approve_all", member, { ids: cands.map((c) => c.id), run: cands[0].run_id ?? undefined });
  const hub = `${HUB}#agents/approvals`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:560px;color:#111">
<p style="font-size:15px">${esc(headline)}</p>
<p style="font-size:13px;color:#666">Approving only adds the business to Leads. Nothing is sent to anyone. Each link opens a page with a button; links work once and last 7 days.</p>
<table style="width:100%;border-collapse:collapse">${rows.join("")}</table>
<p style="margin-top:18px"><a href="${esc(all)}" style="color:#111;font-weight:600">Approve all ${cands.length}</a> &nbsp;·&nbsp; <a href="${esc(hub)}" style="color:#111">Open in the hub</a></p></div>`;
  const text = `${headline}\n\nApproving only adds the business to Leads. Nothing is sent to anyone.\n\n${lines.join("\n\n")}\n\nApprove all ${cands.length}: ${all}\nOpen in the hub: ${hub}\n`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Wise AI OS <dailybrief@wise-ai.au>", to: [to], subject: `Lead scout: ${cands.length} new ${cands.length === 1 ? "business" : "businesses"} to review`, html, text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) { console.error("digest failed", res.status); return { sent: false, why: `resend_${res.status}` }; }
    return { sent: true };
  } catch (e) {
    console.error("digest error", (e as Error).message);
    return { sent: false, why: "send_error" };
  }
}

// ------------------------------------------------------------------ the schedule

export { scheduleDue, batchesFor } from "./scout-rules.ts";
