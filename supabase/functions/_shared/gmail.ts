// The signed-in person's OWN Google account (Gmail, and their calendar): sign-in, the token
// cache, error mapping, recipient checks, and the hub actions on the `gdrive` function
// (mail_status, mail_connect_url, mail_disconnect, mail_send, mail_discard). The assistant's
// tools (agent/mail.ts) use the same client.
//
// No Deno globals and no remote imports at module level: Node unit-tests it
// (supabase/tests/mail.test.mjs). Web Crypto + fetch only.
//
// RULES THIS FILE ENFORCES
//  - One connection per team member (private.gmail_connection, keyed by member id). Every
//    action uses the CALLER's own connection: nobody can read or send from anyone else's mailbox.
//  - Scopes: gmail.readonly (read), gmail.compose (drafts and sending a draft), calendar.events
//    (their own calendar). Nothing that labels, archives, trashes or deletes received mail.
//  - Sending is only `mail_send`, called by the hub when the PERSON presses Send. It sends only a
//    draft the assistant made for that same person (a public.mail_drafts row), re-checks the
//    recipients against opted-out leads at send time, and allows 30 sends per person per day.
//  - The only Gmail delete in the system is `mail_discard`: the assistant's own unsent draft.
import * as G from "./gdrive.ts";
import { startOfLocalDay } from "./time.ts";

export const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
export const CALENDAR = "https://www.googleapis.com/calendar/v3";
export const SCOPE_READ = "https://www.googleapis.com/auth/gmail.readonly";
export const SCOPE_COMPOSE = "https://www.googleapis.com/auth/gmail.compose";
export const SCOPE_CALENDAR = "https://www.googleapis.com/auth/calendar.events";
export const SCOPES = `${SCOPE_READ} ${SCOPE_COMPOSE} ${SCOPE_CALENDAR} openid email`;
export const DAILY_SENDS = 30;
export const MAX_RECIPIENTS = 10;
const MAX_RETRY_S = 8;
export const configured = G.configured;

type Row = Record<string, unknown>;
// deno-lint-ignore no-explicit-any
type Db = any;
type Fetch = typeof fetch;
const enc1 = encodeURIComponent;

/* ------------------------------------------------------------------ errors */
export class MailError extends Error {
  code: string; status: number;
  constructor(code: string, status?: number, message?: string) { super(message || code); this.code = code; this.status = status ?? mailStatusFor(code); }
}
export const MAIL_MESSAGES: Record<string, string> = {
  not_configured: "Google sign-in is not set up for the hub yet.",
  not_connected: "Your email is not connected yet. Connect it in Settings, under Your sign-in.",
  reconnect_needed: "Google needs you to sign in to your email again. Reconnect it in Settings, under Your sign-in.",
  mail_api_off: "The Gmail API is not switched on in Google Cloud yet.",
  calendar_api_off: "The Google Calendar API is not switched on in Google Cloud yet.",
  scope_missing: "Google did not give the hub that permission. Reconnect in Settings and tick every box on the Google screen.",
  busy: "Google is busy right now. Try again in a minute.",
  not_found: "That draft is no longer here.",
  gone: "That draft is no longer in Gmail. It was sent or deleted there.",
  already_sent: "That email was already sent.",
  discarded: "That draft was discarded.",
  sending: "That email is being sent.",
  blocked: "One of the recipients has opted out, so the hub will not send to them.",
  too_many: `An email from the hub can go to at most ${MAX_RECIPIENTS} people.`,
  no_recipients: "That draft has nobody to send to. Add a recipient in Gmail first.",
  daily_limit: `You have sent ${DAILY_SENDS} emails from the hub today, the daily limit. It resets at midnight.`,
  in_use: "That Google account is already connected by another team member.",
  bad_request: "That request was not understood.",
  mail_error: "Google did not answer as expected. Try again in a minute.",
};
export function mailStatusFor(code: string): number {
  return ({
    unauthorized: 401, bad_request: 400, not_found: 404, gone: 410, not_configured: 409, not_connected: 409, reconnect_needed: 409,
    mail_api_off: 409, calendar_api_off: 409, scope_missing: 403, blocked: 409, too_many: 400, no_recipients: 400,
    already_sent: 409, discarded: 409, sending: 409, in_use: 409, daily_limit: 429, busy: 503, mail_error: 502,
  } as Record<string, number>)[code] ?? 500;
}
/**
 * Google API status + error body → our code. A switched-off API answers 403 with reason
 * accessNotConfigured (details SERVICE_DISABLED): that is mail_api_off / calendar_api_off.
 */
export function googleErrorCode(status: number, body: unknown, api: "gmail" | "calendar" = "gmail"): string {
  const err = (body as { error?: { errors?: { reason?: string }[]; status?: string; message?: string; details?: { reason?: string }[] } })?.error;
  const reasons = [err?.errors?.[0]?.reason, err?.status, ...(err?.details ?? []).map((d) => d?.reason), err?.message].map((x) => String(x ?? "")).join(" ");
  if (status === 401) return "unauthorized";
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used in project|is disabled/i.test(reasons)) return api === "calendar" ? "calendar_api_off" : "mail_api_off";
  if (status === 429 || /rateLimitExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED|quotaExceeded/i.test(reasons)) return "busy";
  if (status === 403 && /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(reasons)) return "scope_missing";
  if (status === 404 || status === 410) return "not_found";
  if (status === 400) return "bad_request";
  if (status >= 500) return "busy";
  return "mail_error";
}

/* ------------------------------------------------------------------ addresses */
// Deliberately strict: no quotes, spaces, angle brackets, commas or control characters, so an
// address can never break a MIME header or a database filter.
export const ADDR_RE = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}$/;
export type Addr = { name: string | null; address: string };
/** One recipient: "a@b.com" or "Name <a@b.com>". Null when it is not a usable address. */
export function parseAddress(raw: unknown): Addr | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!s || s.length > 320) return null;
  const m = /^(.*?)<\s*([^<>\s]+)\s*>$/.exec(s);
  const address = (m ? m[2] : s).trim().replace(/^mailto:/i, "");
  if (!ADDR_RE.test(address)) return null;
  const name = m ? m[1].replace(/["\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || null : null;
  return { name, address: address.toLowerCase() };
}
/** Split a To/Cc header ("A <a@x>, b@y, "Last, First" <c@z>") into addresses. Unusable parts are dropped. */
export function parseAddressList(header: unknown): Addr[] {
  if (typeof header !== "string" || !header.trim()) return [];
  const parts: string[] = [];
  let cur = "", quoted = false, angle = false;
  for (const ch of header) {
    if (ch === '"' && !angle) quoted = !quoted;
    if (ch === "<" && !quoted) angle = true;
    if (ch === ">" && !quoted) angle = false;
    if ((ch === "," || ch === ";") && !quoted && !angle) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  const out: Addr[] = [];
  for (const p of parts) { const a = parseAddress(p); if (a && !out.some((x) => x.address === a.address)) out.push(a); }
  return out;
}

/**
 * Recipients the hub must not email: an address that belongs to a lead who opted out (status
 * dnc), or to a lead whose number is on the suppression list. (Suppressions are kept by phone
 * number, so an email address is matched through the lead.) Returns [] when all may be emailed.
 */
export async function blockedRecipients(db: Db, addresses: string[]): Promise<{ address: string; why: string }[]> {
  const list = [...new Set(addresses.map((a) => a.toLowerCase()).filter((a) => ADDR_RE.test(a)))];
  if (!list.length) return [];
  const esc = (a: string) => a.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  const { data: leads, error } = await db.from("leads").select("id, business, email, status, phone").or(list.map((a) => `email.ilike.${esc(a)}`).join(",")).limit(50);
  if (error) throw new Error(`leads lookup: ${error.message}`);
  const rows = (leads ?? []) as Row[];
  const phones = [...new Set(rows.map((r) => r.phone).filter((p) => typeof p === "string" && p))] as string[];
  let suppressed = new Set<string>();
  if (phones.length) {
    const { data: sup, error: sErr } = await db.from("suppressions").select("phone").in("phone", phones);
    if (sErr) throw new Error(`suppressions lookup: ${sErr.message}`);
    suppressed = new Set(((sup ?? []) as Row[]).map((r) => String(r.phone)));
  }
  const out: { address: string; why: string }[] = [];
  for (const a of list) {
    const hit = rows.filter((r) => String(r.email ?? "").toLowerCase() === a);
    if (hit.some((r) => r.status === "dnc")) out.push({ address: a, why: "opted out (do not contact)" });
    else if (hit.some((r) => typeof r.phone === "string" && suppressed.has(r.phone))) out.push({ address: a, why: "on the opt-out list" });
  }
  return out;
}

/* ------------------------------------------------------------------ connection + client */
export type MailConn = {
  member_id: string; email: string | null; refresh_token: string; access_token: string | null; access_expires_at: string | null;
  scope: string | null; connected_at: string; needs_reconnect: boolean; last_error: string | null;
};
export async function loadMailConn(db: Db, memberId: string): Promise<MailConn | null> {
  const { data, error } = await db.rpc("gmail_get", { p_member: memberId });
  if (error) throw new Error(`gmail_get: ${error.message}`);
  return (data as MailConn) ?? null;
}
async function saveMailConn(db: Db, memberId: string, patch: Row) {
  const { error } = await db.rpc("gmail_save", { p_member: memberId, p: patch });
  if (error) throw new Error(`gmail_save: ${error.message}`);
}
export const hasScope = (conn: { scope?: string | null } | null | undefined, scope: string) => String(conn?.scope ?? "").split(/\s+/).includes(scope);

/** One request's Google client for one person: cached access token, refresh on expiry or 401 (once), wait once on a rate limit. */
export function googleClient(o: { db: Db; env: G.Env; conn: MailConn; fetchImpl?: Fetch; sleep?: (ms: number) => Promise<void> }) {
  const f = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const conn = o.conn;
  let token = conn.access_token && conn.access_expires_at && Date.parse(conn.access_expires_at) - Date.now() > 120_000 ? conn.access_token : null;
  async function refresh() {
    try {
      const t = await G.tokenCall(o.env, { grant_type: "refresh_token", refresh_token: conn.refresh_token }, f);
      token = String(t.access_token);
      const exp = new Date(Date.now() + Math.max(60, Number(t.expires_in) || 3600) * 1000).toISOString();
      await saveMailConn(o.db, conn.member_id, { access_token: token, access_expires_at: exp, refresh_token: typeof t.refresh_token === "string" ? t.refresh_token : "", needs_reconnect: false, last_error: null });
      return token;
    } catch (e) {
      if (e instanceof G.DriveError) {
        if (e.code === "reconnect_needed") await saveMailConn(o.db, conn.member_id, { needs_reconnect: true, access_token: null, last_error: e.message }).catch(() => {});
        throw new MailError(e.code === "ms_error" ? "mail_error" : e.code);
      }
      throw e;
    }
  }
  async function call(method: string, url: string, body?: unknown, api: "gmail" | "calendar" = "gmail"): Promise<Row> {
    if (conn.needs_reconnect) throw new MailError("reconnect_needed");
    if (!token) await refresh();
    let refreshed = false, waited = false;
    for (;;) {
      let res: Response;
      try {
        res = await f(url, {
          method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000),
        });
      } catch { throw new MailError("busy"); }
      if (res.ok) return res.status === 204 ? {} : await res.json().catch(() => ({})) as Row;
      if (res.status === 401 && !refreshed) { refreshed = true; await refresh(); continue; }
      const data = await res.json().catch(() => ({})) as Row;
      const code = googleErrorCode(res.status, data, api);
      if (code === "busy") {
        const h = res.headers.get("retry-after");
        const wait = h ? G.retryAfterSeconds(h) : 1 + Math.random();
        if (!waited && wait <= MAX_RETRY_S) { waited = true; await sleep(wait * 1000); continue; }
        throw new MailError("busy");
      }
      if (code === "unauthorized") {
        await saveMailConn(o.db, conn.member_id, { needs_reconnect: true, access_token: null, last_error: "google 401 after refresh" }).catch(() => {});
        throw new MailError("reconnect_needed");
      }
      throw new MailError(code, undefined, String((data.error as Row | undefined)?.message ?? res.status).slice(0, 200));
    }
  }
  return { call, refresh };
}
export type GoogleClient = ReturnType<typeof googleClient>;

/** The caller's own client, or a failure code (not_configured | not_connected | reconnect_needed). */
export async function openMail(o: { db: Db; env: G.Env; memberId: string; fetchImpl?: Fetch }): Promise<{ g: GoogleClient; conn: MailConn } | { error: string }> {
  if (!G.configured(o.env)) return { error: "not_configured" };
  const conn = await loadMailConn(o.db, o.memberId);
  if (!conn) return { error: "not_connected" };
  if (conn.needs_reconnect) return { error: "reconnect_needed" };
  return { g: googleClient({ db: o.db, env: o.env, conn, fetchImpl: o.fetchImpl }), conn };
}

/** Opening the draft in Gmail. The compose= value is the draft's message id (not documented by Google; the plain Drafts folder is the fallback). */
export function gmailDraftUrl(email: string | null | undefined, messageId: string | null | undefined): string {
  const who = email && ADDR_RE.test(email) ? `?authuser=${enc1(email)}` : "";
  const id = messageId && /^[A-Za-z0-9]{6,64}$/.test(messageId) ? `?compose=${messageId}` : "";
  return `https://mail.google.com/mail/u/${who}#drafts${id}`;
}

/* ------------------------------------------------------------------ sign-in URL */
export function mailAuthorizeUrl(o: { clientId: string; redirectUri: string; state: string; challenge: string; hint?: string | null }) {
  // No include_granted_scopes: this token carries only the mail and calendar scopes, never Drive.
  const q = new URLSearchParams({
    client_id: o.clientId, redirect_uri: o.redirectUri, response_type: "code", scope: SCOPES,
    access_type: "offline", prompt: "consent", state: o.state, code_challenge: o.challenge, code_challenge_method: "S256",
  });
  if (o.hint && ADDR_RE.test(o.hint)) q.set("login_hint", o.hint);
  return `${G.AUTH_URL}?${q}`;
}

/* ------------------------------------------------------------------ hub actions */
export type MailCtx = { db: Db; env: G.Env; member: G.Member; fetchImpl?: Fetch; now?: Date };
export type Result = { status: number; body: Row };
const ok = (body: Row): Result => ({ status: 200, body: { ok: true, ...body } });
export const mailFail = (code: string, extra: Row = {}): Result =>
  ({ status: mailStatusFor(code), body: { ok: false, error: code, message: MAIL_MESSAGES[code] ?? "Something went wrong.", ...extra } });

export const MAIL_ACTIONS = ["mail_status", "mail_connect_url", "mail_disconnect", "mail_send", "mail_discard"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRAFT_COLS = "id, member_id, chat_id, gmail_draft_id, gmail_draft_message_id, thread_id, is_reply, to_addrs, cc_addrs, subject, status, created_at, updated_at, sent_at, gmail_message_id, discarded_at";

/** The shape the hub gets for one draft row (no Gmail ids except the one the Edit link needs). */
export function draftView(r: Row, email: string | null = null): Row {
  return {
    id: r.id, chat_id: r.chat_id ?? null, to: r.to_addrs ?? [], cc: r.cc_addrs ?? [], subject: r.subject ?? "", is_reply: Boolean(r.is_reply),
    status: r.status, created_at: r.created_at, sent_at: r.sent_at ?? null, discarded_at: r.discarded_at ?? null,
    gmail_url: gmailDraftUrl(email, r.gmail_draft_message_id as string | null),
  };
}

/** Run one mail action for the signed-in member (always their own mailbox). */
export async function runMailAction(ctx: MailCtx, body: Row): Promise<Result> {
  const action = String(body.action ?? "");
  const me = ctx.member.member_id;
  try {
    if (action === "mail_status") {
      if (!G.configured(ctx.env)) return ok({ configured: false, connected: false });
      const conn = await loadMailConn(ctx.db, me);
      return ok({
        configured: true, connected: Boolean(conn), needs_reconnect: Boolean(conn?.needs_reconnect), email: conn?.email ?? null,
        connected_at: conn?.connected_at ?? null, can_read: hasScope(conn, SCOPE_READ), can_draft: hasScope(conn, SCOPE_COMPOSE),
        can_calendar: hasScope(conn, SCOPE_CALENDAR),
      });
    }
    if (action === "mail_connect_url") {
      if (!G.configured(ctx.env)) return mailFail("not_configured");
      const secret = await G.secretFor(ctx.env, "state");
      const nonce = G.newNonce();
      const state = await G.signPurposeState(me, nonce, secret, "gmail");
      const url = mailAuthorizeUrl({ clientId: ctx.env("GOOGLE_CLIENT_ID")!, redirectUri: G.functionUrl(ctx.env), state, challenge: await G.pkceChallenge(await G.pkceVerifier(secret, nonce)) });
      return ok({ url, expires_in: G.STATE_TTL_S, scopes: SCOPES.split(" ") });
    }
    if (action === "mail_disconnect") {
      const conn = await loadMailConn(ctx.db, me);
      let revoked = false;
      if (conn?.refresh_token) {
        // Google revokes every scope the account gave this Google project. When this same Google
        // account is also the business Drive connection, revoking would cut Drive off too, so then
        // only the hub forgets the mailbox.
        const drive = await G.loadConn(ctx.db).catch(() => null);
        const sameAsDrive = Boolean(drive?.account_email && conn.email && drive.account_email.toLowerCase() === conn.email.toLowerCase());
        if (!sameAsDrive) {
          await (ctx.fetchImpl ?? fetch)(`https://oauth2.googleapis.com/revoke?token=${enc1(conn.refresh_token)}`, { method: "POST", signal: AbortSignal.timeout(8000) }).catch(() => {});
          revoked = true;
        }
      }
      const { error } = await ctx.db.rpc("gmail_clear", { p_member: me });
      if (error) throw new Error(error.message);
      return ok({ connected: false, revoked_at_google: revoked });
    }
    if (action === "mail_send" || action === "mail_discard") {
      if (!UUID.test(String(body.draft_id ?? ""))) return mailFail("bad_request");
      // Only a draft the assistant made for THIS person: anything else is "not found".
      const { data: row, error } = await ctx.db.from("mail_drafts").select(DRAFT_COLS).eq("id", body.draft_id).eq("member_id", me).maybeSingle();
      if (error) throw new Error(error.message);
      if (!row) return mailFail("not_found");
      if (row.status === "sent") return mailFail("already_sent", { draft: draftView(row) });
      if (row.status === "discarded") return mailFail("discarded", { draft: draftView(row) });
      if (row.status === "sending") return mailFail("sending", { draft: draftView(row) });
      const open = await openMail({ db: ctx.db, env: ctx.env, memberId: me, fetchImpl: ctx.fetchImpl });
      if ("error" in open) return mailFail(open.error);
      return action === "mail_send" ? await sendDraft(ctx, row, open) : await discardDraft(ctx, row, open);
    }
    return mailFail("bad_request");
  } catch (e) {
    if (e instanceof MailError) return mailFail(e.code);
    throw e;
  }
}

async function markDraft(ctx: MailCtx, id: string, patch: Row, onlyIfStatus?: string): Promise<Row | null> {
  let q = ctx.db.from("mail_drafts").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).eq("member_id", ctx.member.member_id);
  if (onlyIfStatus) q = q.eq("status", onlyIfStatus);
  const { data, error } = await q.select(DRAFT_COLS);
  if (error) throw new Error(error.message);
  return (data as Row[] | null)?.[0] ?? null;
}

async function sendDraft(ctx: MailCtx, row: Row, open: { g: GoogleClient; conn: MailConn }): Promise<Result> {
  const email = open.conn.email;
  if (!hasScope(open.conn, SCOPE_COMPOSE)) return mailFail("scope_missing");
  // 30 a day per person (local day of the hub).
  const { data: settings } = await ctx.db.from("settings").select("timezone").eq("id", 1).maybeSingle();
  const tz = String(settings?.timezone || "Australia/Brisbane");
  const dayStart = startOfLocalDay(ctx.now ?? new Date(), tz).toISOString();
  const { data: today, error: cErr } = await ctx.db.from("mail_drafts").select("id").eq("member_id", ctx.member.member_id).in("status", ["sent", "sending"]).gte("sent_at", dayStart);
  if (cErr) throw new Error(cErr.message);
  if (((today as Row[] | null) ?? []).length >= DAILY_SENDS) return mailFail("daily_limit", { limit: DAILY_SENDS });
  // What is in Gmail NOW (the person may have changed it there with Edit in Gmail).
  let draft: Row;
  try {
    draft = await open.g.call("GET", `${GMAIL}/drafts/${enc1(String(row.gmail_draft_id))}?format=metadata&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Bcc&metadataHeaders=Subject`);
  } catch (e) {
    if (e instanceof MailError && e.code === "not_found") {
      const r = await markDraft(ctx, String(row.id), { status: "discarded", discarded_at: new Date().toISOString() }, "draft");
      return mailFail("gone", { draft: draftView(r ?? row, email) });
    }
    throw e;
  }
  const headers = (((draft.message as Row | undefined)?.payload as Row | undefined)?.headers ?? []) as { name: string; value: string }[];
  const h = (n: string) => headers.filter((x) => String(x.name).toLowerCase() === n.toLowerCase()).map((x) => x.value).join(", ");
  const to = parseAddressList(h("To")), cc = parseAddressList(h("Cc")), bcc = parseAddressList(h("Bcc"));
  const all = [...to, ...cc, ...bcc].map((a) => a.address);
  if (!all.length) return mailFail("no_recipients");
  if (all.length > MAX_RECIPIENTS) return mailFail("too_many");
  const blocked = await blockedRecipients(ctx.db, all);
  if (blocked.length) {
    return mailFail("blocked", { blocked, message: `Not sent: ${blocked.map((b) => `${b.address} has ${b.why}`).join("; ")}. Remove them from the draft first.` });
  }
  // Claim the row so a double press cannot send twice.
  const claimed = await markDraft(ctx, String(row.id), { status: "sending", sent_at: new Date().toISOString() }, "draft");
  if (!claimed) return mailFail("sending");
  let sent: Row;
  try {
    sent = await open.g.call("POST", `${GMAIL}/drafts/send`, { id: row.gmail_draft_id });
  } catch (e) {
    await markDraft(ctx, String(row.id), { status: "draft", sent_at: null }, "sending").catch(() => {});
    if (e instanceof MailError && e.code === "not_found") {
      const r = await markDraft(ctx, String(row.id), { status: "discarded", discarded_at: new Date().toISOString() }, "draft");
      return mailFail("gone", { draft: draftView(r ?? row, email) });
    }
    throw e;
  }
  const subject = h("Subject").slice(0, 300);
  const done = await markDraft(ctx, String(row.id), {
    status: "sent", sent_at: new Date().toISOString(), gmail_message_id: typeof sent.id === "string" ? sent.id : null,
    to_addrs: to.map((a) => a.address), cc_addrs: [...cc, ...bcc].map((a) => a.address), ...(subject ? { subject } : {}),
  }, "sending");
  return ok({ draft: draftView(done ?? { ...row, status: "sent" }, email) });
}

async function discardDraft(ctx: MailCtx, row: Row, open: { g: GoogleClient; conn: MailConn }): Promise<Result> {
  try {
    await open.g.call("DELETE", `${GMAIL}/drafts/${enc1(String(row.gmail_draft_id))}`);
  } catch (e) {
    if (!(e instanceof MailError && e.code === "not_found")) throw e;   // already gone from Gmail: just mark it
  }
  const r = await markDraft(ctx, String(row.id), { status: "discarded", discarded_at: new Date().toISOString() }, "draft");
  if (!r) return mailFail("sending");
  return ok({ draft: draftView(r, open.conn.email) });
}

/* ------------------------------------------------------------------ the sign-in callback */
export const backToMail = (result: string) => `${G.HUB}?mail=${encodeURIComponent(result)}#settings`;

/** Google's redirect for the shared redirect URI: a Gmail state goes to the mail sign-in, everything else to Drive's. */
export async function routeCallback(o: { db: Db; env: G.Env; params: URLSearchParams; fetchImpl?: Fetch }): Promise<string> {
  let purpose: string | null = null;
  try { purpose = await G.statePurpose(o.params.get("state"), await G.secretFor(o.env, "state")); } catch { purpose = null; }
  return purpose === "gmail" ? await handleMailCallback(o) : await G.handleCallback(o);
}

export async function handleMailCallback(o: { db: Db; env: G.Env; params: URLSearchParams; fetchImpl?: Fetch }): Promise<string> {
  const { db, env, params } = o;
  const f = o.fetchImpl ?? fetch;
  try {
    const secret = await G.secretFor(env, "state");
    if ((await G.statePurpose(params.get("state"), secret)) !== "gmail") return backToMail("bad_state");
    const st = await G.verifyState(params.get("state"), secret);
    if (!st.ok) return backToMail(st.error === "expired" ? "expired" : "bad_state");
    if (!G.configured(env)) return backToMail("not_configured");
    const { data: fresh, error: nErr } = await db.rpc("onedrive_use_nonce", { p_nonce: st.nonce });
    if (nErr || fresh !== true) return backToMail("bad_state");
    const err = params.get("error");
    if (err) return backToMail(err === "access_denied" ? "denied" : err === "org_internal" ? "not_in_org" : "error");
    const code = params.get("code");
    if (!code || code.length > 4000) return backToMail("error");
    const { data: m } = await db.from("team_members").select("id, active").eq("id", st.member).maybeSingle();
    if (!m || !m.active) return backToMail("bad_state");
    const t = await G.tokenCall(env, { grant_type: "authorization_code", code, redirect_uri: G.functionUrl(env), code_verifier: await G.pkceVerifier(secret, st.nonce) }, f);
    if (typeof t.refresh_token !== "string") return backToMail("no_refresh");
    const scope = String(t.scope ?? "");
    if (!scope.split(" ").includes(SCOPE_READ)) return backToMail("scope_missing");
    const access = String(t.access_token);
    // The mailbox's address, from Gmail itself (also proves the Gmail API is switched on).
    const res = await f(`${GMAIL}/profile`, { headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(15000) });
    const prof = await res.json().catch(() => ({})) as Row;
    if (!res.ok) {
      const c = googleErrorCode(res.status, prof);
      return backToMail(c === "mail_api_off" ? "api_off" : c === "busy" ? "busy" : "error");
    }
    const email = typeof prof.emailAddress === "string" ? prof.emailAddress.toLowerCase() : null;
    if (!email) return backToMail("error");
    const { data: taken } = await db.rpc("gmail_email_in_use", { p_email: email, p_except: st.member });
    if (taken === true) return backToMail("in_use");
    await saveMailConn(db, st.member, {
      refresh_token: t.refresh_token, access_token: access, scope, email,
      access_expires_at: new Date(Date.now() + Math.max(60, Number(t.expires_in) || 3600) * 1000).toISOString(),
      connected_at: new Date().toISOString(),
    });
    return backToMail(scope.split(" ").includes(SCOPE_COMPOSE) ? "connected" : "connected_read_only");
  } catch (e) {
    console.error("gmail callback", (e as Error).message);
    return backToMail(e instanceof G.DriveError && e.code === "busy" ? "busy" : "error");
  }
}
