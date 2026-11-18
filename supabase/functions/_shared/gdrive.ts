// Google Drive (the business's Google Workspace account) through the Drive API v3: sign-in, the
// token cache, the Drive calls, a signed file proxy for previews, and every action the hub's Files
// page uses. Same contract as onedrive.ts (`runAction(ctx, body)`, same item shape, same errors),
// so the page and the chat assistant can use either provider.
//
// No Deno globals and no remote imports at module level: Node unit-tests it
// (supabase/tests/gdrive.test.mjs). Web Crypto + fetch only.
//
// RULES THIS FILE ENFORCES
//  - Nothing is ever deleted or trashed. There is no delete or trash call in this file, and
//    `trashed` is never written.
//  - Only the connected account's My Drive and the shared drives it belongs to. Files merely
//    "shared with me" are dropped. Tokens are never returned.
//  - Moves stay inside one drive (My Drive, or one shared drive).
//  - Every move, rename and new folder is logged in public.file_changes (provider 'gdrive').
//  - Google is contacted only when an action (or a preview the person opened) asks for it.

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const API = "https://www.googleapis.com/drive/v3";
// drive: full Drive access (a "restricted" scope; no Google verification is needed when the app's
// audience is Internal to the Workspace organisation). openid email profile: the account's name.
export const SCOPES = "https://www.googleapis.com/auth/drive openid email profile";
export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const STATE_TTL_S = 600;
export const FILE_TTL_S = 3600;
export const MAX_PROXY_BYTES = 40 * 1024 * 1024;
export const LINK_KINDS = ["client", "project", "deal", "lead"] as const;
export const LINK_TABLES: Record<string, string> = { client: "clients", project: "projects", deal: "deals", lead: "leads" };
export const SHARED = "shared"; // the virtual "Shared drives" folder
const PAGE = 200;
const MAX_PAGES = 5;
const MAX_RETRY_S = 8;
const FILE_FIELDS = "id,name,mimeType,size,modifiedTime,createdTime,lastModifyingUser(displayName),webViewLink,parents,driveId,ownedByMe,hasThumbnail,thumbnailLink,trashed,capabilities(canRename,canMoveItemWithinDrive,canAddChildren,canDownload),shortcutDetails(targetId,targetMimeType)";

type Row = Record<string, unknown>;
// deno-lint-ignore no-explicit-any
type Db = any;
type Fetch = typeof fetch;
export type Env = (k: string) => string | undefined;

/* ------------------------------------------------------------------ encoding + signing */
const enc = new TextEncoder();
export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function hmac256(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}
function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** Signing keys: GDRIVE_STATE_SECRET if set, else derived from the service-role key (one label per use). */
export async function secretFor(env: Env, use: "state" | "file"): Promise<string> {
  const own = env("GDRIVE_STATE_SECRET");
  const base = own && own.length >= 32 ? own : env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!base) throw new Error("no signing secret");
  return b64url(await hmac256(base, `wiseos/gdrive-${use}/v1`));
}
async function signJson(obj: Row, secret: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(obj)));
  return `${payload}.${b64url(await hmac256(secret, payload))}`;
}
async function readSigned(token: unknown, secret: string, max = 2000): Promise<Row | null> {
  if (typeof token !== "string" || token.length > max) return null;
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  if (!safeEqual(b64url(await hmac256(secret, payload)), sig)) return null;
  try { return JSON.parse(new TextDecoder().decode(b64urlDecode(payload))); } catch { return null; }
}

export const newNonce = () => b64url(crypto.getRandomValues(new Uint8Array(24)));

export async function signState(member: string, nonce: string, secret: string, nowS = Math.floor(Date.now() / 1000)) {
  return signJson({ m: member, n: nonce, e: nowS + STATE_TTL_S }, secret);
}
export type StateCheck = { ok: true; member: string; nonce: string } | { ok: false; error: "bad_state" | "expired" };
export async function verifyState(state: unknown, secret: string, nowS = Math.floor(Date.now() / 1000)): Promise<StateCheck> {
  const p = await readSigned(state, secret, 600);
  if (!p || !isUuid(p.m) || typeof p.n !== "string" || p.n.length < 16 || typeof p.e !== "number") return { ok: false, error: "bad_state" };
  if (nowS > p.e) return { ok: false, error: "expired" };
  if (p.e - nowS > STATE_TTL_S + 5) return { ok: false, error: "bad_state" };
  return { ok: true, member: p.m, nonce: p.n };
}
export async function pkceVerifier(secret: string, nonce: string) { return b64url(await hmac256(secret, `pkce:${nonce}`)); }
export async function pkceChallenge(v: string) { return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(v)))); }

export function authorizeUrl(o: { clientId: string; redirectUri: string; state: string; challenge: string; hint?: string | null }) {
  const q = new URLSearchParams({
    client_id: o.clientId, redirect_uri: o.redirectUri, response_type: "code", scope: SCOPES,
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state: o.state,
    code_challenge: o.challenge, code_challenge_method: "S256",
  });
  if (o.hint) q.set("login_hint", o.hint);
  return `${AUTH_URL}?${q}`;
}

/** File proxy token: {i: file id, k: 't' thumbnail | 'c' content inline | 'd' download | 'p' Google file as PDF, u?: thumbnail URL, e}. */
export async function signFile(secret: string, f: { i: string; k: "t" | "c" | "d" | "p"; u?: string; n?: string }, nowS = Math.floor(Date.now() / 1000)) {
  return signJson({ ...f, e: nowS + FILE_TTL_S }, secret);
}
export async function verifyFile(token: unknown, secret: string, nowS = Math.floor(Date.now() / 1000)) {
  const p = await readSigned(token, secret, 3000);
  if (!p || typeof p.i !== "string" || !["t", "c", "d", "p"].includes(String(p.k)) || typeof p.e !== "number") return null;
  if (nowS > p.e || p.e - nowS > FILE_TTL_S + 5) return null;
  if (p.k === "t" && !safeThumbUrl(p.u)) return null;
  return p as { i: string; k: "t" | "c" | "d" | "p"; u?: string; n?: string; e: number };
}
/** Thumbnails come from Google's content hosts only. */
export function safeThumbUrl(u: unknown): boolean {
  if (typeof u !== "string") return false;
  try { const x = new URL(u); return x.protocol === "https:" && /(^|\.)googleusercontent\.com$|(^|\.)google\.com$/.test(x.hostname); } catch { return false; }
}
/** Google thumbnail links end in =s220 (or similar): ask for another size. */
export function thumbAt(link: string, px: number): string {
  return /=s\d+(-[a-z0-9-]+)?$/i.test(link) ? link.replace(/=s\d+(-[a-z0-9-]+)?$/i, `=s${px}`) : link;
}

/* ------------------------------------------------------------------ errors */
export class DriveError extends Error {
  code: string; status: number; retryAfter?: number;
  constructor(code: string, status: number, message?: string, retryAfter?: number) { super(message || code); this.code = code; this.status = status; this.retryAfter = retryAfter; }
}
export const MESSAGES: Record<string, string> = {
  not_configured: "Google Drive is not set up yet. The Google app details still need to be added.",
  not_connected: "Google Drive is not connected yet.",
  reconnect_needed: "Google needs you to sign in to Google Drive again.",
  busy: "Google Drive is busy right now. Try again in a minute.",
  not_found: "That file or folder is no longer in Google Drive. It may have been moved or removed there.",
  name_taken: "Something with that name is already in that folder.",
  bad_name: "That name cannot be used.",
  changed_since: "That item has changed since, so undoing would overwrite a newer change.",
  already_undone: "That change was already undone.",
  not_undoable: "A new folder cannot be removed from here. Remove it in Google Drive if you do not need it.",
  outside_drive: "That item is not in this Google Drive.",
  bad_move: "A folder cannot be moved into itself.",
  cross_drive: "Moving between My Drive and a shared drive, or between shared drives, is done in Google Drive itself.",
  forbidden: "Google Drive did not allow that change.",
  too_large: "That file is too large to preview here. Open it in Google Drive.",
  unsupported: "That kind of file has no text to read.",
  owner_only: "Only the owner can connect or disconnect Google Drive.",
  bad_request: "That request was not understood.",
  ms_error: "Google did not answer as expected. Try again in a minute.",
};
export function statusFor(code: string): number {
  return ({
    unauthorized: 401, owner_only: 403, outside_drive: 403, forbidden: 403, not_found: 404, bad_request: 400, bad_name: 400,
    bad_move: 400, cross_drive: 400, not_undoable: 400, not_configured: 409, not_connected: 409, reconnect_needed: 409,
    name_taken: 409, changed_since: 409, already_undone: 409, too_large: 413, unsupported: 415, busy: 503, ms_error: 502,
  } as Record<string, number>)[code] ?? 500;
}
/** Drive API status + error body → our code. 403 rate limits are "busy", like 429. */
export function apiErrorCode(status: number, body: unknown): string {
  const err = (body as { error?: { errors?: { reason?: string }[]; status?: string } })?.error;
  const reason = String(err?.errors?.[0]?.reason ?? err?.status ?? "");
  if (status === 401) return "unauthorized";
  if (status === 429 || /rateLimitExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED/i.test(reason)) return "busy";
  if (status === 404) return "not_found";
  if (status === 403 && /exportSizeLimitExceeded/i.test(reason)) return "too_large";
  if (status === 403) return "forbidden";
  if (status === 400 && /cannotMoveTrashedItem|invalid/i.test(reason)) return "bad_request";
  if (status >= 500) return "busy";
  return "ms_error";
}
/** Token endpoint error → reconnect_needed | not_configured | busy | ms_error. */
export function tokenErrorCode(status: number, body: unknown): string {
  const e = String((body as { error?: unknown })?.error ?? "");
  if (["invalid_grant", "admin_policy_enforced", "invalid_rapt", "org_internal"].includes(e)) return "reconnect_needed";
  if (e === "invalid_client" || e === "unauthorized_client" || e === "deleted_client") return "not_configured";
  if (status === 429 || status >= 500) return "busy";
  return "ms_error";
}
export function retryAfterSeconds(h: string | null, nowMs = Date.now()): number {
  if (!h) return 2;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(0, n);
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - nowMs) / 1000)) : 2;
}

/* ------------------------------------------------------------------ names, queries */
export function cleanName(raw: unknown): { ok: true; name: string } | { ok: false; error: "bad_name" } {
  if (typeof raw !== "string") return { ok: false, error: "bad_name" };
  const name = raw.normalize("NFC").trim();
  if (!name || name.length > 250 || /[\u0000-\u001f]/.test(name) || name.includes("/") || name === "." || name === "..") return { ok: false, error: "bad_name" };
  return { ok: true, name };
}
/** A value inside a Drive query string literal: backslash and single quote escaped. */
export const qv = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
export function searchQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200);
  if (!s) return null;
  return `(name contains '${qv(s)}' or fullText contains '${qv(s)}') and trashed = false`;
}
const ID = /^[A-Za-z0-9_-]{1,200}$/;
export const itemId = (v: unknown) => (typeof v === "string" && (ID.test(v)) ? v : null);

/* ------------------------------------------------------------------ item shape */
export type Item = {
  id: string; name: string; folder: boolean; child_count: number | null; size: number | null; mime: string | null;
  kind: string; ext: string; badge?: string; modified: string | null; created: string | null; modified_by: string | null;
  web_url: string | null; parent_id: string | null; parent_path: string | null; is_root: boolean;
  thumb: { small?: string; medium?: string; large?: string } | null; drive_id: string | null;
  can_rename: boolean; can_move: boolean; thumb_link?: string | null;
};
const GOOGLE_KINDS: Record<string, [string, string]> = {
  "application/vnd.google-apps.document": ["gdoc", "DOC"],
  "application/vnd.google-apps.spreadsheet": ["gsheet", "SHEET"],
  "application/vnd.google-apps.presentation": ["gslide", "SLIDE"],
  "application/vnd.google-apps.form": ["gform", "FORM"],
  "application/vnd.google-apps.drawing": ["gdraw", "DRAW"],
  "application/vnd.google-apps.shortcut": ["shortcut", "LINK"],
};
const OFFICE: Record<string, string> = { doc: "word", docx: "word", odt: "word", rtf: "word", xls: "excel", xlsx: "excel", csv: "excel", ods: "excel", ppt: "powerpoint", pptx: "powerpoint", odp: "powerpoint" };
export function kindOf(name: string, mime: string | null): string {
  if (mime === FOLDER_MIME) return "folder";
  if (mime && GOOGLE_KINDS[mime]) return GOOGLE_KINDS[mime][0];
  const ext = (name.match(/\.([a-z0-9]{1,8})$/i)?.[1] || "").toLowerCase();
  if (OFFICE[ext]) return OFFICE[ext];
  if (ext === "pdf" || mime === "application/pdf") return "pdf";
  if (/^image\//.test(mime || "")) return "image";
  if (/^video\//.test(mime || "")) return "video";
  if (/^audio\//.test(mime || "")) return "audio";
  if (/^text\//.test(mime || "")) return "text";
  if (/^(zip|7z|rar|tar|gz)$/.test(ext)) return "archive";
  return "file";
}
export const isGoogleDoc = (k: string) => k === "gdoc" || k === "gsheet" || k === "gslide" || k === "gdraw";

/**
 * Drive file → item. `opts.rootId` marks My Drive's root; `opts.strict` (search results) drops
 * files that are only "shared with me" (not in My Drive and not in a shared drive).
 * Thumbnails are filled in later (they need signing), from `thumb_link`.
 */
export function shapeFile(raw: Row | null | undefined, opts: { rootId?: string | null; strict?: boolean; driveName?: string | null } = {}): Item | null {
  if (!raw || typeof raw.id !== "string") return null;
  if (raw.trashed === true) return null;
  const driveId = typeof raw.driveId === "string" ? raw.driveId : null;
  const parents = Array.isArray(raw.parents) ? raw.parents as string[] : [];
  // "Shared with me" only: not in a shared drive, not owned, and no parent folder this account can see.
  if (opts.strict && !driveId && raw.ownedByMe !== true && parents.length === 0) return null;
  const mime = typeof raw.mimeType === "string" ? raw.mimeType : null;
  const isRoot = (opts.rootId && raw.id === opts.rootId) || (driveId !== null && raw.id === driveId);
  const name = isRoot ? (driveId ? opts.driveName || String(raw.name ?? "Shared drive") : "My Drive") : String(raw.name ?? "");
  const kind = kindOf(name, mime);
  const caps = (raw.capabilities || {}) as Row;
  const size = raw.size !== undefined && raw.size !== null && Number.isFinite(Number(raw.size)) ? Number(raw.size) : null;
  return {
    id: raw.id, name, folder: kind === "folder", child_count: null, size: kind === "folder" ? null : size, mime, kind,
    ext: (name.match(/\.([a-z0-9]{1,8})$/i)?.[1] || "").toLowerCase(),
    ...(mime && GOOGLE_KINDS[mime] ? { badge: GOOGLE_KINDS[mime][1] } : {}),
    modified: typeof raw.modifiedTime === "string" ? raw.modifiedTime : null,
    created: typeof raw.createdTime === "string" ? raw.createdTime : null,
    modified_by: ((raw.lastModifyingUser as Row | undefined)?.displayName as string) ?? null,
    web_url: typeof raw.webViewLink === "string" && /^https:\/\//.test(raw.webViewLink) ? raw.webViewLink : null,
    parent_id: isRoot ? (driveId ? SHARED : null) : parents[0] ?? null,
    parent_path: null, is_root: Boolean(isRoot), thumb: null, drive_id: driveId,
    can_rename: caps.canRename !== false && !isRoot, can_move: caps.canMoveItemWithinDrive !== false && !isRoot,
    thumb_link: raw.hasThumbnail !== false && typeof raw.thumbnailLink === "string" ? raw.thumbnailLink : null,
  };
}
/** The virtual folder that holds the shared drives. */
export const sharedFolder = (count: number): Item => ({
  id: SHARED, name: "Shared drives", folder: true, child_count: count, size: null, mime: null, kind: "folder", ext: "",
  modified: null, created: null, modified_by: null, web_url: "https://drive.google.com/drive/shared-drives", parent_id: null,
  parent_path: null, is_root: false, thumb: null, drive_id: null, can_rename: false, can_move: false,
});
export function sortItems(items: Item[]): Item[] {
  const coll = new Intl.Collator("en-AU", { numeric: true, sensitivity: "base" });
  return [...items].sort((a, b) => (a.folder === b.folder ? coll.compare(a.name, b.name) : a.folder ? -1 : 1));
}

/* ------------------------------------------------------------------ undo */
export type Change = { op: string; item_id: string; before: Row | null; after: Row | null; undone_at?: string | null };
export function undoPlan(change: Change, current: Item | null): { ok: true; patch: { parent_id?: string; from?: string; name?: string } } | { ok: false; error: string } {
  if (change.undone_at) return { ok: false, error: "already_undone" };
  if (change.op === "create_folder") return { ok: false, error: "not_undoable" };
  if (!current) return { ok: false, error: "not_found" };
  const before = change.before || {}, after = change.after || {};
  if (change.op === "move") {
    if (!before.parent_id || current.parent_id !== after.parent_id || current.name !== after.name) return { ok: false, error: "changed_since" };
    return { ok: true, patch: { parent_id: String(before.parent_id), from: String(after.parent_id) } };
  }
  if (change.op === "rename") {
    if (!before.name || current.name !== after.name || (after.parent_id && current.parent_id !== after.parent_id)) return { ok: false, error: "changed_since" };
    return { ok: true, patch: { name: String(before.name) } };
  }
  return { ok: false, error: "bad_request" };
}

/* ------------------------------------------------------------------ connection + tokens */
export type Conn = {
  refresh_token: string; access_token: string | null; access_expires_at: string | null; root_id: string | null;
  account_name: string | null; account_email?: string | null; connected_by: string | null; connected_at: string;
  needs_reconnect: boolean; last_error: string | null;
};
export const configured = (env: Env) => Boolean(env("GOOGLE_CLIENT_ID") && env("GOOGLE_CLIENT_SECRET"));
export const functionUrl = (env: Env) => `${(env("PUBLIC_FUNCTIONS_URL") ?? "https://adfgtlhryyyrqbbgbfmx.supabase.co/functions/v1").replace(/\/+$/, "")}/gdrive`;
export async function loadConn(db: Db): Promise<Conn | null> {
  const { data, error } = await db.rpc("gdrive_get");
  if (error) throw new Error(`gdrive_get: ${error.message}`);
  return (data as Conn) ?? null;
}
async function saveConn(db: Db, patch: Row) {
  const { error } = await db.rpc("gdrive_save", { p: patch });
  if (error) throw new Error(`gdrive_save: ${error.message}`);
}

export async function tokenCall(env: Env, form: Record<string, string>, f: Fetch = fetch): Promise<Row> {
  const body = new URLSearchParams({ client_id: env("GOOGLE_CLIENT_ID") ?? "", client_secret: env("GOOGLE_CLIENT_SECRET") ?? "", ...form });
  let res: Response;
  try {
    res = await f(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(15000) });
  } catch { throw new DriveError("busy", 503); }
  const data = await res.json().catch(() => ({})) as Row;
  if (!res.ok || typeof data.access_token !== "string") {
    const code = tokenErrorCode(res.status, data);
    throw new DriveError(code, statusFor(code), String(data.error ?? res.status));
  }
  return data;
}

/** One request's Drive client: cached access token, refresh on expiry or 401 (once), wait once on 429/403-rate-limit. */
export function driveClient(o: { db: Db; env: Env; conn: Conn; fetchImpl?: Fetch; sleep?: (ms: number) => Promise<void> }) {
  const f = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const conn = o.conn;
  let token = conn.access_token && conn.access_expires_at && Date.parse(conn.access_expires_at) - Date.now() > 120_000 ? conn.access_token : null;
  async function refresh() {
    try {
      const t = await tokenCall(o.env, { grant_type: "refresh_token", refresh_token: conn.refresh_token }, f);
      token = String(t.access_token);
      const exp = new Date(Date.now() + Math.max(60, Number(t.expires_in) || 3600) * 1000).toISOString();
      // Google normally keeps the same refresh token; keep a new one if it sends one.
      await saveConn(o.db, { access_token: token, access_expires_at: exp, refresh_token: typeof t.refresh_token === "string" ? t.refresh_token : "", needs_reconnect: false, last_error: null });
      return token;
    } catch (e) {
      if (e instanceof DriveError && e.code === "reconnect_needed") await saveConn(o.db, { needs_reconnect: true, access_token: null, last_error: e.message }).catch(() => {});
      throw e;
    }
  }
  /** Raw response (for streaming); throws DriveError on failure. */
  async function raw(method: string, url: string, body?: unknown): Promise<Response> {
    if (conn.needs_reconnect) throw new DriveError("reconnect_needed", 409);
    if (!token) await refresh();
    let refreshed = false, waited = false;
    for (;;) {
      let res: Response;
      try {
        res = await f(url.startsWith("https://") ? url : `${API}${url}`, {
          method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000),
        });
      } catch { throw new DriveError("busy", 503); }
      if (res.ok) return res;
      if (res.status === 401 && !refreshed) { refreshed = true; await refresh(); continue; }
      const data = await res.json().catch(() => ({})) as Row;
      const code = apiErrorCode(res.status, data);
      if (code === "busy") {
        const wait = res.headers.get("retry-after") ? retryAfterSeconds(res.headers.get("retry-after")) : 1 + Math.random();
        if (!waited && wait <= MAX_RETRY_S) { waited = true; await sleep(wait * 1000); continue; }
        throw new DriveError("busy", 503, "rate limited", Math.ceil(wait));
      }
      if (code === "unauthorized") {
        await saveConn(o.db, { needs_reconnect: true, access_token: null, last_error: "drive 401 after refresh" }).catch(() => {});
        throw new DriveError("reconnect_needed", 409);
      }
      throw new DriveError(code, statusFor(code), String((data.error as Row | undefined)?.message ?? res.status).slice(0, 200));
    }
  }
  async function call(method: string, url: string, body?: unknown): Promise<Row> {
    const res = await raw(method, url, body);
    if (res.status === 204) return {};
    return await res.json().catch(() => ({})) as Row;
  }
  return { call, raw, refresh };
}
export type Drive = ReturnType<typeof driveClient>;

/* ------------------------------------------------------------------ Drive calls (exported for reuse) */
const ALL = "supportsAllDrives=true";
const enc1 = encodeURIComponent;

export async function getFile(d: Drive, id: string): Promise<Row> {
  return await d.call("GET", `/files/${enc1(id)}?${ALL}&fields=${enc1(FILE_FIELDS)}`);
}
export async function driveName(d: Drive, driveId: string): Promise<string | null> {
  try { return String((await d.call("GET", `/drives/${enc1(driveId)}?fields=name`)).name ?? "") || null; } catch { return null; }
}
export async function sharedDrives(d: Drive): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  let token = "";
  for (let i = 0; i < 3; i++) {
    const r = await d.call("GET", `/drives?pageSize=100&fields=${enc1("nextPageToken,drives(id,name)")}${token ? `&pageToken=${enc1(token)}` : ""}`);
    for (const x of (r.drives as Row[]) || []) out.push({ id: String(x.id), name: String(x.name) });
    if (typeof r.nextPageToken !== "string") break;
    token = r.nextPageToken;
  }
  return out;
}
export async function listChildren(d: Drive, folderId: string, opts: { rootId?: string | null; cursor?: string | null; foldersOnly?: boolean } = {}) {
  const items: Item[] = [];
  let token = opts.cursor || "";
  let next: string | null = null;
  const q = `'${qv(folderId)}' in parents and trashed = false${opts.foldersOnly ? ` and mimeType = '${FOLDER_MIME}'` : ""}`;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await d.call("GET", `/files?${ALL}&includeItemsFromAllDrives=true&pageSize=${PAGE}&orderBy=${enc1("folder,name_natural")}&q=${enc1(q)}&fields=${enc1(`nextPageToken,files(${FILE_FIELDS})`)}${token ? `&pageToken=${enc1(token)}` : ""}`);
    for (const f of (r.files as Row[]) || []) { const it = shapeFile(f, { rootId: opts.rootId }); if (it) items.push(it); }
    next = typeof r.nextPageToken === "string" ? r.nextPageToken : null;
    if (!next) break;
    token = next;
  }
  return { items: sortItems(items), cursor: next };
}
export async function searchDrive(d: Drive, q: string, rootId: string | null, pages = 1) {
  const items: Item[] = [];
  let token = "";
  for (let i = 0; i < pages; i++) {
    const r = await d.call("GET", `/files?${ALL}&includeItemsFromAllDrives=true&corpora=allDrives&pageSize=100&q=${enc1(q)}&fields=${enc1(`nextPageToken,files(${FILE_FIELDS})`)}${token ? `&pageToken=${enc1(token)}` : ""}`);
    for (const f of (r.files as Row[]) || []) { const it = shapeFile(f, { rootId, strict: true }); if (it && !it.is_root) items.push(it); }
    if (typeof r.nextPageToken !== "string") break;
    token = r.nextPageToken;
  }
  return items;
}

/* ------------------------------------------------------------------ the business folder */
// Parent ids, cached for five minutes per warm function instance (folders rarely move).
const parentCache = new Map<string, { p: string | null; at: number }>();
const PARENT_TTL = 5 * 60_000;
async function parentOf(d: Drive, id: string): Promise<string | null> {
  const hit = parentCache.get(id);
  if (hit && Date.now() - hit.at < PARENT_TTL) return hit.p;
  const raw = await d.call("GET", `/files/${enc1(id)}?${ALL}&fields=${enc1("id,parents")}`);
  const p = Array.isArray(raw.parents) && raw.parents.length ? String(raw.parents[0]) : null;
  parentCache.set(id, { p, at: Date.now() });
  return p;
}
/** Remember parents already known from a listing or search (saves calls in isInside). */
export function rememberParents(items: { id: string; parent_id: string | null }[]) {
  const now = Date.now();
  for (const it of items) if (it.parent_id && it.parent_id !== SHARED) parentCache.set(it.id, { p: it.parent_id, at: now });
}
/**
 * Every folder inside `homeId` (any depth), found level by level with a handful of queries and
 * cached for five minutes. Drive has no "anywhere under this folder" search, so this is how
 * "inside the business folder" is answered quickly. Stops at 5,000 folders.
 */
const treeCache = new Map<string, { set: Set<string>; at: number }>();
export async function foldersUnder(d: Drive, homeId: string): Promise<Set<string>> {
  const hit = treeCache.get(homeId);
  if (hit && Date.now() - hit.at < PARENT_TTL) return hit.set;
  const set = new Set<string>([homeId]);
  let frontier = [homeId];
  for (let depth = 0; frontier.length && depth < 30 && set.size < 5000; depth++) {
    const next: string[] = [];
    for (let i = 0; i < frontier.length; i += 40) {
      const batch = frontier.slice(i, i + 40);
      const q = `(${batch.map((id) => `'${qv(id)}' in parents`).join(" or ")}) and mimeType = '${FOLDER_MIME}' and trashed = false`;
      let token = "";
      for (let pg = 0; pg < 10; pg++) {
        const r = await d.call("GET", `/files?${ALL}&includeItemsFromAllDrives=true&corpora=allDrives&pageSize=1000&q=${enc1(q)}&fields=${enc1("nextPageToken,files(id,parents)")}${token ? `&pageToken=${enc1(token)}` : ""}`);
        for (const f of (r.files as Row[]) || []) {
          const id = String(f.id);
          if (!set.has(id)) { set.add(id); next.push(id); }
          const p = Array.isArray(f.parents) && f.parents.length ? String(f.parents[0]) : null;
          parentCache.set(id, { p, at: Date.now() });
        }
        if (typeof r.nextPageToken !== "string") break;
        token = r.nextPageToken;
      }
    }
    frontier = next;
  }
  treeCache.set(homeId, { set, at: Date.now() });
  return set;
}
/**
 * Is `itemId` the folder `homeId` or somewhere inside it? Uses the cached folder tree under the
 * home folder plus one parent lookup (cached). `drive` is optional: without it a client is opened.
 */
export async function isInside(ctx: Ctx, itemId: string, homeId: string, drive?: Drive): Promise<boolean> {
  if (!itemId || !homeId) return false;
  if (itemId === homeId) return true;
  let d = drive;
  if (!d) { const o = await openDrive(ctx); if ("body" in o) return false; d = o.d; }
  try {
    const tree = await foldersUnder(d, homeId);
    if (tree.has(itemId)) return true;
    const p = await parentOf(d, itemId);
    return p !== null && tree.has(p);
  } catch { return false; }
}
/** The business folder from settings (null = the whole drive). */
export async function homeFolder(db: Db): Promise<{ id: string; name: string | null } | null> {
  try {
    const { data } = await db.from("settings").select("files_home_id, files_home_name").eq("id", 1).maybeSingle();
    return data?.files_home_id ? { id: String(data.files_home_id), name: data.files_home_name ?? null } : null;
  } catch { return null; }
}

/* ------------------------------------------------------------------ document text (for the assistant) */
export const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|xml|html?|ya?ml)$/i;
/** Read at most `max` bytes of a response body. */
async function readCapped(res: Response, max: number): Promise<{ bytes: Uint8Array; cut: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), cut: false };
  const parts: Uint8Array[] = [];
  let n = 0, cut = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (n + value.length > max) { parts.push(value.slice(0, max - n)); n = max; cut = true; await reader.cancel().catch(() => {}); break; }
    parts.push(value); n += value.length;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return { bytes: out, cut };
}
export type TextResult =
  | { ok: true; item: { id: string; name: string; kind: string; web_url: string | null }; format: string; text: string; truncated: boolean }
  | { ok: false; error: string; unsupported?: string; item?: { id: string; name: string; kind: string; web_url: string | null } };
/**
 * Plain text of one file, for summarising: Google Docs and Slides (exported as text), Google
 * Sheets (exported as CSV: the first sheet only), and text, CSV and Markdown files. PDFs and other
 * binary files come back as { ok:false, error:'unsupported', unsupported:'pdf' | kind }.
 * Downloads stop at 10 MB; text is cut at `maxChars` (default 20,000).
 */
export async function readText(ctx: Ctx, id: string, maxChars = 20000, drive?: Drive): Promise<TextResult> {
  let d = drive;
  if (!d) { const o = await openDrive(ctx); if ("body" in o) return { ok: false, error: String(o.body.error) }; d = o.d; }
  if (!itemId(id)) return { ok: false, error: "bad_request" };
  const raw = await getFile(d, id);
  const it = shapeFile(raw, { strict: true });
  if (!it) return { ok: false, error: "outside_drive" };
  const item = { id: it.id, name: it.name, kind: it.kind, web_url: it.web_url };
  let url: string | null = null, format = "text";
  if (it.kind === "gdoc" || it.kind === "gslide") url = `/files/${enc1(id)}/export?mimeType=text%2Fplain`;
  else if (it.kind === "gsheet") { url = `/files/${enc1(id)}/export?mimeType=text%2Fcsv`; format = "csv (first sheet)"; }
  else if (!it.folder && (/^text\//.test(it.mime || "") || it.mime === "application/json" || TEXT_EXT.test(it.name))) {
    if ((it.size || 0) > MAX_TEXT_BYTES) return { ok: false, error: "too_large", item };
    url = `/files/${enc1(id)}?alt=media&${ALL}`;
    if (/\.csv$/i.test(it.name) || it.mime === "text/csv") format = "csv";
  }
  if (!url) return { ok: false, error: "unsupported", unsupported: it.kind === "pdf" ? "pdf" : it.folder ? "folder" : it.kind, item };
  try {
    const res = await d.raw("GET", url);
    const { bytes, cut } = await readCapped(res, MAX_TEXT_BYTES);
    let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const max = Math.max(200, Math.min(Number(maxChars) || 20000, 200000));
    const truncated = cut || text.length > max;
    if (text.length > max) text = text.slice(0, max);
    return { ok: true, item, format, text, truncated };
  } catch (e) {
    if (e instanceof DriveError) return { ok: false, error: e.code, item };
    throw e;
  }
}
/** Breadcrumbs: My Drive / … or Shared drives / <drive> / … (at most 15 levels). */
export async function pathTo(d: Drive, id: string | null, rootId: string | null) {
  const out: { id: string; name: string }[] = [];
  let cur = id;
  for (let i = 0; cur && i < 15; i++) {
    if (cur === SHARED) { out.unshift({ id: SHARED, name: "Shared drives" }); break; }
    const raw = await getFile(d, cur);
    const dId = typeof raw.driveId === "string" ? raw.driveId : null;
    const it = shapeFile(raw, { rootId, driveName: dId && raw.id === dId ? await driveName(d, dId) : null });
    if (!it) break;
    out.unshift({ id: it.id, name: it.name });
    if (it.is_root) { if (it.drive_id) out.unshift({ id: SHARED, name: "Shared drives" }); break; }
    cur = it.parent_id;
  }
  return out;
}
export async function patchFile(d: Drive, id: string, patch: { parent_id?: string; from?: string | null; name?: string }) {
  const qs = [ALL, `fields=${enc1(FILE_FIELDS)}`];
  if (patch.parent_id) { qs.push(`addParents=${enc1(patch.parent_id)}`); if (patch.from) qs.push(`removeParents=${enc1(patch.from)}`); }
  return await d.call("PATCH", `/files/${enc1(id)}?${qs.join("&")}`, patch.name ? { name: patch.name } : {});
}
export async function makeFolder(d: Drive, parentId: string, name: string) {
  return await d.call("POST", `/files?${ALL}&fields=${enc1(FILE_FIELDS)}`, { name, mimeType: FOLDER_MIME, parents: [parentId] });
}
async function nameTaken(d: Drive, parentId: string, name: string, exceptId?: string) {
  const q = `'${qv(parentId)}' in parents and name = '${qv(name)}' and trashed = false`;
  const r = await d.call("GET", `/files?${ALL}&includeItemsFromAllDrives=true&pageSize=5&q=${enc1(q)}&fields=${enc1("files(id)")}`);
  return ((r.files as Row[]) || []).some((f) => f.id !== exceptId);
}

/* ------------------------------------------------------------------ actions */
export type Member = { member_id: string; name: string; role: string };
export type Ctx = { db: Db; env: Env; member: Member; source?: "hub" | "assistant"; chatId?: string | null; fetchImpl?: Fetch };
export type Result = { status: number; body: Row };
const ok = (body: Row): Result => ({ status: 200, body: { ok: true, provider: "gdrive", ...body } });
export const fail = (code: string, extra: Row = {}): Result =>
  ({ status: statusFor(code), body: { ok: false, provider: "gdrive", error: code, message: MESSAGES[code] ?? "Something went wrong.", ...extra } });
const str = (v: unknown, max = 300) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

async function ownerName(db: Db) {
  const { data } = await db.from("team_members").select("name").eq("role", "owner").eq("active", true).order("sort").limit(1).maybeSingle();
  return data?.name ?? null;
}
async function memberName(db: Db, id: string | null) {
  if (!id) return null;
  const { data } = await db.from("team_members").select("name").eq("id", id).maybeSingle();
  return data?.name ?? null;
}

/** Sign the thumbnail and preview addresses on items (they go through this function, 1 hour). */
async function signItems(env: Env, items: Item[], { big = false } = {}): Promise<Item[]> {
  const secret = await secretFor(env, "file");
  const base = functionUrl(env);
  const out: Item[] = [];
  for (const it of items) {
    const { thumb_link, ...rest } = it;
    if (thumb_link && safeThumbUrl(thumb_link)) {
      const t = async (px: number) => `${base}?f=${await signFile(secret, { i: it.id, k: "t", u: thumbAt(thumb_link, px) })}`;
      rest.thumb = big ? { small: await t(96), medium: await t(400), large: await t(1200) } : { small: await t(96), large: await t(480) };
    }
    out.push(rest as Item);
  }
  return out;
}
async function fileUrls(env: Env, it: Item) {
  const secret = await secretFor(env, "file");
  const base = functionUrl(env);
  const u = async (k: "c" | "d" | "p") => `${base}?f=${await signFile(secret, { i: it.id, k, n: it.name.slice(0, 120) })}`;
  const preview = isGoogleDoc(it.kind) ? await u("p") : it.kind === "image" || it.kind === "pdf" || it.kind === "video" || it.kind === "audio" ? await u("c") : null;
  const download = !it.folder && !isGoogleDoc(it.kind) && it.kind !== "shortcut" && it.kind !== "gform" ? await u("d") : null;
  return { preview, download };
}

async function status(ctx: Ctx): Promise<Result> {
  const isOwner = ctx.member.role === "owner";
  if (!configured(ctx.env)) return ok({ configured: false, connected: false, can_connect: isOwner, owner_name: await ownerName(ctx.db) });
  const conn = await loadConn(ctx.db);
  return ok({
    configured: true, connected: Boolean(conn), needs_reconnect: Boolean(conn?.needs_reconnect), can_connect: isOwner,
    owner_name: await ownerName(ctx.db), home: await homeFolder(ctx.db),
    account: conn ? { name: conn.account_name, email: conn.account_email ?? null, connected_at: conn.connected_at, connected_by: await memberName(ctx.db, conn.connected_by), root_id: conn.root_id } : null,
  });
}

export async function openDrive(ctx: Ctx): Promise<{ d: Drive; conn: Conn } | Result> {
  if (!configured(ctx.env)) return fail("not_configured");
  const conn = await loadConn(ctx.db);
  if (!conn) return fail("not_connected");
  if (conn.needs_reconnect) return fail("reconnect_needed");
  return { d: driveClient({ db: ctx.db, env: ctx.env, conn, fetchImpl: ctx.fetchImpl }), conn };
}
async function logChange(ctx: Ctx, row: Row) {
  const { data, error } = await ctx.db.from("file_changes").insert({
    ...row, provider: "gdrive", member_id: ctx.member.member_id, source: ctx.source ?? "hub", chat_id: isUuid(ctx.chatId) ? ctx.chatId : null,
  }).select("*").single();
  if (error) { console.error("file_changes insert failed", error.message); return null; }
  return data;
}

/** Run one action. Same actions and shapes as onedrive.ts. */
export async function runAction(ctx: Ctx, body: Row): Promise<Result> {
  const action = String(body.action ?? "");
  try {
    if (action === "status") return await status(ctx);
    if (action === "connect_url") {
      if (ctx.member.role !== "owner") return fail("owner_only");
      if (!configured(ctx.env)) return fail("not_configured");
      const secret = await secretFor(ctx.env, "state");
      const nonce = newNonce();
      const state = await signState(ctx.member.member_id, nonce, secret);
      return ok({ url: authorizeUrl({ clientId: ctx.env("GOOGLE_CLIENT_ID")!, redirectUri: functionUrl(ctx.env), state, challenge: await pkceChallenge(await pkceVerifier(secret, nonce)) }), expires_in: STATE_TTL_S });
    }
    if (action === "disconnect") {
      if (ctx.member.role !== "owner") return fail("owner_only");
      const conn = await loadConn(ctx.db);
      // Revoke at Google too (best effort), so the hub's access ends there as well.
      if (conn?.refresh_token) await (ctx.fetchImpl ?? fetch)(`https://oauth2.googleapis.com/revoke?token=${enc1(conn.refresh_token)}`, { method: "POST", signal: AbortSignal.timeout(8000) }).catch(() => {});
      const { error } = await ctx.db.rpc("gdrive_clear");
      if (error) throw new Error(error.message);
      return ok({ connected: false });
    }
    if (!["list", "folders", "search", "read_text", "item", "move", "rename", "create_folder", "undo", "link", "unlink"].includes(action)) return fail("bad_request");
    const open = await openDrive(ctx);
    if ("body" in open) return open;
    const { d, conn } = open;
    const rootId = conn.root_id;
    const resolve = (v: unknown) => (v === "root" || v === undefined || v === null || v === "" ? rootId : v === SHARED ? SHARED : itemId(v));
    const get = async (id: string, strict = false) => {
      if (id === SHARED) return sharedFolder(0);
      const raw = await getFile(d, id);
      const dId = typeof raw.driveId === "string" ? raw.driveId : null;
      return shapeFile(raw, { rootId, strict, driveName: dId && raw.id === dId ? await driveName(d, dId) : null });
    };

    if (action === "list" || action === "folders") {
      const id = resolve(body.item_id);
      if (!id) return fail("bad_request");
      if (id === SHARED) {
        const drives = await sharedDrives(d);
        const items = drives.map((x) => ({ ...sharedFolder(0), id: x.id, name: x.name, is_root: true, drive_id: x.id, parent_id: SHARED, web_url: `https://drive.google.com/drive/folders/${x.id}` }));
        return ok({ folder: sharedFolder(drives.length), items: sortItems(items), cursor: null, path: [{ id: SHARED, name: "Shared drives" }] });
      }
      const [folder, listing] = await Promise.all([get(id), listChildren(d, id, { rootId, cursor: str(body.cursor, 2000), foldersOnly: action === "folders" })]);
      if (!folder) return fail("outside_drive");
      if (!folder.folder) return fail("bad_request", { message: "That is a file, not a folder." });
      let items = listing.items;
      if (folder.id === rootId && !body.cursor) {
        const drives = await sharedDrives(d).catch(() => []);
        if (drives.length) items = [...items, sharedFolder(drives.length)];
      }
      const path = body.with_path || action === "folders" ? await pathTo(d, folder.id, rootId) : null;
      return ok({ folder: (await signItems(ctx.env, [folder]))[0], items: await signItems(ctx.env, sortItems(items)), cursor: listing.cursor, path });
    }

    if (action === "search") {
      const q = searchQuery(body.q);
      if (!q) return fail("bad_request");
      // Drive cannot search "anywhere under a folder", so search the drive and keep what is inside it.
      const within = body.within === undefined || body.within === null || body.within === "" ? null : resolve(body.within);
      let items: Item[];
      if (within && within !== rootId) {
        // Search directly inside every folder of the business folder's tree, 40 folders a query.
        const ids = [...await foldersUnder(d, within)];
        items = [];
        for (let i = 0; i < ids.length && items.length < 200; i += 40) {
          const parents = ids.slice(i, i + 40).map((id) => `'${qv(id)}' in parents`).join(" or ");
          items.push(...await searchDrive(d, `${q} and (${parents})`, rootId));
        }
      } else items = await searchDrive(d, q, rootId);
      return ok({ q: String(body.q).trim(), within, items: await signItems(ctx.env, items) });
    }

    if (action === "read_text") {
      const r = await readText(ctx, String(body.id ?? ""), Number(body.max_chars) || 20000, d);
      return r.ok ? ok(r as unknown as Row) : fail(r.error, { ...(r.unsupported ? { unsupported: r.unsupported } : {}), ...(r.item ? { item: r.item } : {}),
        ...(r.error === "unsupported" ? { message: r.unsupported === "pdf" ? "Reading PDFs is not available yet. Open it to read it." : "That kind of file has no text to read." } : {}) });
    }

    if (action === "item") {
      const id = itemId(body.id);
      if (!id) return fail("bad_request");
      const it = await get(id, true);
      if (!it) return fail("outside_drive");
      const [signed] = await signItems(ctx.env, [it], { big: true });
      const urls = it.folder ? { preview: null, download: null } : await fileUrls(ctx.env, it);
      const path = body.with_path ? await pathTo(d, it.parent_id, rootId) : null;
      const { data: links } = await ctx.db.from("file_links").select("*").eq("item_id", it.id).order("created_at");
      return ok({ item: signed, download_url: urls.download, preview_url: urls.preview, path, links: links ?? [] });
    }

    if (action === "move") {
      const id = itemId(body.id), parent = resolve(body.parent_id);
      if (!id || !parent) return fail("bad_request");
      if (id === parent) return fail("bad_move");
      if (parent === SHARED) return fail("cross_drive");
      const [cur, dest] = await Promise.all([get(id), get(parent)]);
      if (!cur || !dest) return fail("outside_drive");
      if (!dest.folder) return fail("bad_request", { message: "You can only move things into a folder." });
      if (cur.is_root) return fail("bad_request");
      if ((cur.drive_id || null) !== (dest.drive_id || null)) return fail("cross_drive");
      if (!cur.can_move) return fail("forbidden");
      if (cur.parent_id === dest.id) return ok({ item: cur, change: null, unchanged: true });
      if (cur.folder && (await pathTo(d, dest.id, rootId)).some((p) => p.id === cur.id)) return fail("bad_move");
      const fromName = cur.parent_id ? ((await get(cur.parent_id))?.name ?? "My Drive") : "My Drive";
      const moved = shapeFile(await patchFile(d, id, { parent_id: dest.id, from: cur.parent_id }), { rootId });
      const change = await logChange(ctx, {
        item_id: id, op: "move",
        before: { parent_id: cur.parent_id, parent_name: fromName, name: cur.name },
        after: { parent_id: dest.id, parent_name: dest.name, name: moved?.name ?? cur.name },
        summary: `Moved ${cur.name} from ${fromName} to ${dest.name}`,
      });
      return ok({ item: moved ? (await signItems(ctx.env, [moved]))[0] : null, change });
    }

    if (action === "rename") {
      const id = itemId(body.id);
      const nm = cleanName(body.name);
      if (!id) return fail("bad_request");
      if (!nm.ok) return fail("bad_name");
      const cur = await get(id);
      if (!cur) return fail("outside_drive");
      if (cur.is_root) return fail("bad_request");
      if (!cur.can_rename) return fail("forbidden");
      if (cur.name === nm.name) return ok({ item: cur, change: null, unchanged: true });
      if (cur.parent_id && await nameTaken(d, cur.parent_id, nm.name, cur.id)) return fail("name_taken");
      const renamed = shapeFile(await patchFile(d, id, { name: nm.name }), { rootId });
      const change = await logChange(ctx, {
        item_id: id, op: "rename", before: { name: cur.name, parent_id: cur.parent_id },
        after: { name: renamed?.name ?? nm.name, parent_id: cur.parent_id }, summary: `Renamed ${cur.name} to ${renamed?.name ?? nm.name}`,
      });
      await ctx.db.from("file_links").update({ name: renamed?.name ?? nm.name }).eq("item_id", id);
      return ok({ item: renamed ? (await signItems(ctx.env, [renamed]))[0] : null, change });
    }

    if (action === "create_folder") {
      const parent = resolve(body.parent_id);
      const nm = cleanName(body.name);
      if (!parent || parent === SHARED) return fail("bad_request");
      if (!nm.ok) return fail("bad_name");
      const dest = await get(parent);
      if (!dest) return fail("outside_drive");
      if (!dest.folder) return fail("bad_request");
      if (await nameTaken(d, dest.id, nm.name)) return fail("name_taken");
      const made = shapeFile(await makeFolder(d, dest.id, nm.name), { rootId });
      if (!made) return fail("ms_error");
      const change = await logChange(ctx, {
        item_id: made.id, op: "create_folder", before: null,
        after: { name: made.name, parent_id: dest.id, parent_name: dest.name }, summary: `Made a folder ${made.name} in ${dest.name}`,
      });
      return ok({ item: made, change });
    }

    if (action === "undo") {
      if (!isUuid(body.change_id)) return fail("bad_request");
      const { data: ch, error } = await ctx.db.from("file_changes").select("*").eq("id", body.change_id).maybeSingle();
      if (error) throw new Error(error.message);
      if (!ch || (ch.provider && ch.provider !== "gdrive")) return fail("not_found", { message: "That change is not in the log." });
      let current: Item | null = null;
      if (ch.op !== "create_folder" && !ch.undone_at) {
        try { current = await get(ch.item_id); } catch (e) { if (!(e instanceof DriveError && e.code === "not_found")) throw e; }
      }
      const plan = undoPlan(ch, current);
      if (!plan.ok) return fail(plan.error);
      const item = shapeFile(await patchFile(d, ch.item_id, plan.patch), { rootId });
      const { data: done } = await ctx.db.from("file_changes").update({ undone_at: new Date().toISOString(), undone_by: ctx.member.member_id })
        .eq("id", ch.id).is("undone_at", null).select("*").maybeSingle();
      if (plan.patch.name) await ctx.db.from("file_links").update({ name: plan.patch.name }).eq("item_id", ch.item_id);
      return ok({ item, change: done ?? ch });
    }

    if (action === "link") {
      const id = itemId(body.item_id);
      const kind = String(body.kind ?? "");
      if (!id || !(LINK_KINDS as readonly string[]).includes(kind) || !isUuid(body.record_id)) return fail("bad_request");
      const { data: rec } = await ctx.db.from(LINK_TABLES[kind]).select("id").eq("id", body.record_id).maybeSingle();
      if (!rec) return fail("not_found", { message: `That ${kind} is not in the hub.` });
      const it = await get(id, true);
      if (!it) return fail("outside_drive");
      const row = { item_id: it.id, name: it.name, web_url: it.web_url, mime: it.mime, is_folder: it.folder, kind, record_id: body.record_id, created_by: ctx.member.member_id, provider: "gdrive" };
      const { data, error } = await ctx.db.from("file_links").upsert(row, { onConflict: "item_id,kind,record_id" }).select("*").single();
      if (error) throw new Error(error.message);
      return ok({ link: data });
    }

    if (action === "unlink") {
      if (!isUuid(body.link_id)) return fail("bad_request");
      // Removes the hub's link only. The file in Google Drive is untouched.
      const { error } = await ctx.db.from("file_links").delete().eq("id", body.link_id);
      if (error) throw new Error(error.message);
      return ok({ unlinked: body.link_id });
    }
    return fail("bad_request");
  } catch (e) {
    if (e instanceof DriveError) return fail(e.code, e.retryAfter ? { retry_after_s: e.retryAfter } : {});
    throw e;
  }
}

/* ------------------------------------------------------------------ the signed file proxy (GET ?f=) */
const INLINE_OK = /^(image\/(png|jpe?g|gif|webp|bmp|avif|heic|heif)|application\/pdf|video\/|audio\/)/i;
/**
 * Stream one file's thumbnail, content or PDF export with the server's token. The signed token
 * (1 hour) names the file and what to send; nothing else is reachable. Images are never served
 * as SVG/HTML (no script can run from this address).
 */
export async function handleFile(o: { db: Db; env: Env; token: string | null; fetchImpl?: Fetch }): Promise<{ status: number; headers: Record<string, string>; body: BodyInit | null }> {
  const plain = (status: number, text: string) => ({ status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, body: text });
  try {
    if (!configured(o.env)) return plain(404, "Not found");
    const t = await verifyFile(o.token, await secretFor(o.env, "file"));
    if (!t) return plain(403, "This preview link has expired. Open the file again.");
    const conn = await loadConn(o.db);
    if (!conn || conn.needs_reconnect) return plain(409, "Google Drive needs signing in again.");
    const d = driveClient({ db: o.db, env: o.env, conn, fetchImpl: o.fetchImpl });
    let res: Response;
    if (t.k === "t") res = await d.raw("GET", t.u!);
    else if (t.k === "p") res = await d.raw("GET", `/files/${enc1(t.i)}/export?mimeType=application%2Fpdf`);
    else res = await d.raw("GET", `/files/${enc1(t.i)}?alt=media&${ALL}`);
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_PROXY_BYTES && t.k !== "d") return plain(413, MESSAGES.too_large);
    let type = res.headers.get("content-type") || "application/octet-stream";
    if (t.k === "p") type = "application/pdf";
    const inline = t.k !== "d" && INLINE_OK.test(type);
    if (!inline && t.k !== "d") type = "application/octet-stream";
    const name = (t.n || "file").replace(/["\\\r\n]/g, "");
    return {
      status: 200, body: res.body,
      headers: {
        "content-type": type, "cache-control": "private, max-age=3000", "x-content-type-options": "nosniff",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(t.k === "p" ? `${name}.pdf` : name)}`,
        // PDFs are left to the browser's viewer (a sandboxed document cannot show one).
        ...(type === "application/pdf" ? {} : { "content-security-policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; sandbox" }),
        ...(len ? { "content-length": String(len) } : {}),
      },
    };
  } catch (e) {
    if (e instanceof DriveError) return plain(e.status, MESSAGES[e.code] ?? "Could not open that file.");
    console.error("gdrive file", (e as Error).message);
    return plain(500, "Could not open that file.");
  }
}

/* ------------------------------------------------------------------ OAuth callback */
export const HUB = "https://wise-ai.au/os/";
export const backTo = (result: string) => `${HUB}?drive=${encodeURIComponent(result)}#files`;

export async function handleCallback(o: { db: Db; env: Env; params: URLSearchParams; fetchImpl?: Fetch }): Promise<string> {
  const { db, env, params } = o;
  const f = o.fetchImpl ?? fetch;
  try {
    const secret = await secretFor(env, "state");
    const st = await verifyState(params.get("state"), secret);
    if (!st.ok) return backTo(st.error === "expired" ? "expired" : "bad_state");
    if (!configured(env)) return backTo("not_configured");
    const { data: fresh, error: nErr } = await db.rpc("onedrive_use_nonce", { p_nonce: st.nonce });
    if (nErr || fresh !== true) return backTo("bad_state");
    const err = params.get("error");
    if (err) return backTo(err === "access_denied" ? "denied" : err === "org_internal" ? "not_in_org" : "error");
    const code = params.get("code");
    if (!code || code.length > 4000) return backTo("error");
    const { data: m } = await db.from("team_members").select("id, role, active").eq("id", st.member).maybeSingle();
    if (!m || m.role !== "owner" || !m.active) return backTo("not_owner");
    const t = await tokenCall(env, { grant_type: "authorization_code", code, redirect_uri: functionUrl(env), code_verifier: await pkceVerifier(secret, st.nonce) }, f);
    if (typeof t.refresh_token !== "string") return backTo("no_refresh");
    if (!String(t.scope ?? "").split(" ").includes("https://www.googleapis.com/auth/drive")) return backTo("scope_missing");
    const access = String(t.access_token);
    const g = async (url: string) => { const r = await f(url, { headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(15000) }); return r.ok ? await r.json() as Row : null; };
    const [about, root] = await Promise.all([g(`${API}/about?fields=${enc1("user(displayName,emailAddress)")}`), g(`${API}/files/root?fields=id`)]);
    if (!root || typeof root.id !== "string") return backTo("error");
    const user = (about?.user || {}) as Row;
    await saveConn(db, {
      refresh_token: t.refresh_token, access_token: access, scope: String(t.scope ?? ""),
      access_expires_at: new Date(Date.now() + Math.max(60, Number(t.expires_in) || 3600) * 1000).toISOString(),
      root_id: root.id, account_name: (user.displayName as string) || "Google Drive", account_email: (user.emailAddress as string) || null,
      connected_by: st.member, connected_at: new Date().toISOString(),
    });
    return backTo("connected");
  } catch (e) {
    console.error("gdrive callback", (e as Error).message);
    return backTo(e instanceof DriveError && e.code === "busy" ? "busy" : "error");
  }
}
