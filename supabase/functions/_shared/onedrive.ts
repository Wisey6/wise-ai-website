// OneDrive (personal Microsoft account) through Microsoft Graph: sign-in helpers, the token
// cache, the Graph calls, and every action the hub's Files page uses. Written so the chat
// assistant can call the same actions server-side (`runAction`) with `source: 'assistant'`.
//
// No Deno globals and no remote imports at module level, so Node can unit-test the pure parts
// (supabase/tests/onedrive.test.mjs). Web Crypto + fetch only.
//
// RULES THIS FILE ENFORCES
//  - Nothing is ever deleted from the drive. There is no delete call in this file.
//  - Only items in the connected drive are returned. Items shared from someone else's drive
//    (remoteItem, or a different driveId) are dropped, and no download URL or token is ever
//    returned for them. Tokens are never returned at all.
//  - Every move, rename and new folder is written to public.file_changes with before/after.
//  - Microsoft is contacted only when an action asks for it (no background polling).

/* ------------------------------------------------------------------ constants */

export const AUTHORITY = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
export const GRAPH = "https://graph.microsoft.com/v1.0";
// Files.ReadWrite: least privilege for move/rename/create folder on a personal drive.
// offline_access: a refresh token. User.Read: the account's display name for the status line.
export const SCOPES = "Files.ReadWrite offline_access User.Read";
export const STATE_TTL_S = 600;
export const LINK_KINDS = ["client", "project", "deal", "lead"] as const;
export const LINK_TABLES: Record<string, string> = { client: "clients", project: "projects", deal: "deals", lead: "leads" };
const MAX_RETRY_AFTER_S = 8;
const PAGE = 200;
const MAX_PAGES = 5;
const ITEM_SELECT = [
  "id", "name", "size", "file", "folder", "image", "photo", "video", "package", "root", "remoteItem",
  "createdDateTime", "lastModifiedDateTime", "lastModifiedBy", "webUrl", "parentReference",
].join(",");

type Row = Record<string, unknown>;

/* ------------------------------------------------------------------ encoding */

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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

/* ------------------------------------------------------------------ OAuth state + PKCE */

/**
 * The server secret that signs `state`. ONEDRIVE_STATE_SECRET if set, otherwise derived from the
 * service-role key (HMAC with a fixed label), so no new secret is required.
 */
export async function stateSecret(env: (k: string) => string | undefined): Promise<string> {
  const own = env("ONEDRIVE_STATE_SECRET");
  if (own && own.length >= 32) return own;
  const base = env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!base) throw new Error("no state secret");
  return b64url(await hmac256(base, "wiseos/onedrive-state/v1"));
}

export function newNonce(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(24)));
}

/** state = base64url({m: member, n: nonce, e: expiry seconds}) "." base64url(HMAC-SHA256). */
export async function signState(member: string, nonce: string, secret: string, nowS = Math.floor(Date.now() / 1000)): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ m: member, n: nonce, e: nowS + STATE_TTL_S })));
  return `${payload}.${b64url(await hmac256(secret, payload))}`;
}

export type StateCheck = { ok: true; member: string; nonce: string } | { ok: false; error: "bad_state" | "expired" };

export async function verifyState(state: unknown, secret: string, nowS = Math.floor(Date.now() / 1000)): Promise<StateCheck> {
  if (typeof state !== "string" || state.length > 600) return { ok: false, error: "bad_state" };
  const [payload, sig, extra] = state.split(".");
  if (!payload || !sig || extra !== undefined) return { ok: false, error: "bad_state" };
  if (!safeEqual(b64url(await hmac256(secret, payload)), sig)) return { ok: false, error: "bad_state" };
  let p: { m?: unknown; n?: unknown; e?: unknown };
  try { p = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))); } catch { return { ok: false, error: "bad_state" }; }
  if (!isUuid(p.m) || typeof p.n !== "string" || p.n.length < 16 || typeof p.e !== "number") return { ok: false, error: "bad_state" };
  if (nowS > p.e) return { ok: false, error: "expired" };
  if (p.e - nowS > STATE_TTL_S + 5) return { ok: false, error: "bad_state" };
  return { ok: true, member: p.m, nonce: p.n };
}

/** PKCE verifier derived from the secret + nonce, so nothing has to be stored between the legs. */
export async function pkceVerifier(secret: string, nonce: string): Promise<string> {
  return b64url(await hmac256(secret, `pkce:${nonce}`));
}
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
}

export function authorizeUrl(o: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const q = new URLSearchParams({
    client_id: o.clientId, response_type: "code", redirect_uri: o.redirectUri, response_mode: "query",
    scope: SCOPES, state: o.state, code_challenge: o.challenge, code_challenge_method: "S256", prompt: "select_account",
  });
  return `${AUTHORITY}/authorize?${q}`;
}

/* ------------------------------------------------------------------ errors */

export class DriveError extends Error {
  code: string; status: number; retryAfter?: number;
  constructor(code: string, status: number, message?: string, retryAfter?: number) {
    super(message || code); this.code = code; this.status = status; this.retryAfter = retryAfter;
  }
}

/** Plain-English messages for every error code the page or the assistant can see. */
export const MESSAGES: Record<string, string> = {
  not_configured: "OneDrive is not set up yet. The Microsoft app details still need to be added.",
  not_connected: "OneDrive is not connected yet.",
  reconnect_needed: "Microsoft needs you to sign in to OneDrive again.",
  busy: "OneDrive is busy right now. Try again in a minute.",
  not_found: "That file or folder is no longer in OneDrive. It may have been moved or removed there.",
  name_taken: "Something with that name is already in that folder.",
  bad_name: "That name cannot be used in OneDrive.",
  changed_since: "That item has changed since, so undoing would overwrite a newer change.",
  already_undone: "That change was already undone.",
  not_undoable: "A new folder cannot be removed from here. Remove it in OneDrive if you do not need it.",
  outside_drive: "That item is not in the connected OneDrive.",
  bad_move: "A folder cannot be moved into itself.",
  locked: "That file is open or locked in OneDrive. Try again shortly.",
  drive_full: "The OneDrive is full.",
  forbidden: "OneDrive refused that change.",
  owner_only: "Only the owner can connect or disconnect OneDrive.",
  bad_request: "That request was not understood.",
  ms_error: "Microsoft did not answer as expected. Try again in a minute.",
};

/** Graph HTTP status + error body → one of our codes. */
export function graphErrorCode(status: number, body: unknown): string {
  const code = String((body as { error?: { code?: unknown } })?.error?.code ?? "");
  if (status === 401) return "unauthorized";
  if (status === 404 || code === "itemNotFound") return "not_found";
  if (status === 409 || code === "nameAlreadyExists") return "name_taken";
  if (status === 412) return "changed_since";
  if (status === 423 || code === "resourceLocked") return "locked";
  if (status === 429 || status === 503 && code === "serviceNotAvailable") return "busy";
  if (status === 507 || code === "quotaLimitReached") return "drive_full";
  if (status === 400 && /invalidRequest|nameContainsInvalidCharacters/i.test(code)) return "bad_name";
  if (status === 403) return "forbidden";
  return "ms_error";
}

/** Token endpoint error → reconnect_needed (sign in again) | not_configured (bad app secret) | busy | ms_error. */
export function tokenErrorCode(status: number, body: unknown): string {
  const e = String((body as { error?: unknown })?.error ?? "");
  if (["invalid_grant", "interaction_required", "consent_required", "login_required"].includes(e)) return "reconnect_needed";
  if (e === "invalid_client" || e === "unauthorized_client") return "not_configured";
  if (status === 429 || e === "temporarily_unavailable") return "busy";
  if (status >= 500) return "busy";
  return "ms_error";
}

/** HTTP status for one of our codes. */
export function statusFor(code: string): number {
  return ({
    unauthorized: 401, owner_only: 403, outside_drive: 403, forbidden: 403, not_found: 404,
    bad_request: 400, bad_name: 400, bad_move: 400, not_undoable: 400,
    not_configured: 409, not_connected: 409, reconnect_needed: 409, name_taken: 409, changed_since: 409,
    already_undone: 409, locked: 423, busy: 503, drive_full: 507, ms_error: 502,
  } as Record<string, number>)[code] ?? 500;
}

/** Retry-After header → seconds (number or HTTP date). */
export function retryAfterSeconds(h: string | null, nowMs = Date.now()): number {
  if (!h) return 2;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(0, n);
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - nowMs) / 1000)) : 2;
}

/* ------------------------------------------------------------------ names */

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d|desktop\.ini|\.lock|_vti_)$/i;
/** Trimmed name or an error. OneDrive refuses " * : < > ? / \ | , leading/trailing dots and spaces. */
export function cleanName(raw: unknown): { ok: true; name: string } | { ok: false; error: "bad_name" } {
  if (typeof raw !== "string") return { ok: false, error: "bad_name" };
  const name = raw.normalize("NFC").trim();
  if (!name || name.length > 250) return { ok: false, error: "bad_name" };
  if (/["*:<>?/\\|]/.test(name) || /[\u0000-\u001f]/.test(name)) return { ok: false, error: "bad_name" };
  if (name.endsWith(".") || name.startsWith("~$") || RESERVED.test(name) || /^_vti_/i.test(name)) return { ok: false, error: "bad_name" };
  return { ok: true, name };
}

/* ------------------------------------------------------------------ item shape */

export type Item = {
  id: string; name: string; folder: boolean; child_count: number | null; size: number | null;
  mime: string | null; kind: string; ext: string; modified: string | null; created: string | null;
  modified_by: string | null; web_url: string | null; parent_id: string | null; parent_path: string | null;
  is_root: boolean; thumb: { small?: string; medium?: string; large?: string } | null;
};

const OFFICE: Record<string, string> = {
  doc: "word", docx: "word", docm: "word", dotx: "word", odt: "word", rtf: "word",
  xls: "excel", xlsx: "excel", xlsm: "excel", xlsb: "excel", csv: "excel", ods: "excel",
  ppt: "powerpoint", pptx: "powerpoint", pptm: "powerpoint", odp: "powerpoint",
};

export function kindOf(name: string, mime: string | null, folder: boolean): string {
  if (folder) return "folder";
  const ext = (name.match(/\.([a-z0-9]{1,8})$/i)?.[1] || "").toLowerCase();
  if (OFFICE[ext]) return OFFICE[ext];
  if (ext === "pdf" || mime === "application/pdf") return "pdf";
  if (/^image\//.test(mime || "") || /^(png|jpe?g|gif|webp|heic|heif|bmp|svg|tiff?)$/.test(ext)) return "image";
  if (/^video\//.test(mime || "") || /^(mp4|mov|m4v|avi|mkv|webm)$/.test(ext)) return "video";
  if (/^audio\//.test(mime || "") || /^(mp3|m4a|wav|aac|flac|ogg)$/.test(ext)) return "audio";
  if (/^(txt|md|json|xml|html?|js|ts|css|log)$/.test(ext)) return "text";
  if (/^(zip|7z|rar|tar|gz)$/.test(ext)) return "archive";
  return "file";
}

/** Graph driveItem → our compact item, or null when it is not in `driveId` (shared from elsewhere). */
export function shapeItem(raw: Row | null | undefined, driveId: string | null): Item | null {
  if (!raw || typeof raw.id !== "string") return null;
  if (raw.remoteItem) return null;
  const pr = (raw.parentReference || {}) as Row;
  if (driveId && pr.driveId && String(pr.driveId).toLowerCase() !== driveId.toLowerCase()) return null;
  const folder = Boolean(raw.folder); // OneNote notebooks arrive as `package` and are treated as files
  const file = (raw.file || null) as Row | null;
  const mime = file && typeof file.mimeType === "string" ? file.mimeType : null;
  const name = String(raw.name ?? "");
  const thumbs = Array.isArray(raw.thumbnails) ? raw.thumbnails[0] as Row | undefined : undefined;
  const t = (k: string) => (thumbs && thumbs[k] && typeof (thumbs[k] as Row).url === "string" ? String((thumbs[k] as Row).url) : undefined);
  const thumb = thumbs ? { small: t("small"), medium: t("medium"), large: t("large") } : null;
  const by = ((raw.lastModifiedBy as Row | undefined)?.user as Row | undefined)?.displayName;
  const path = typeof pr.path === "string" ? decodeURIComponent(String(pr.path).replace(/^\/drive(s\/[^/]+)?\/root:?/, "")) || "/" : null;
  return {
    id: raw.id,
    name,
    folder,
    child_count: folder ? Number((raw.folder as Row)?.childCount ?? 0) : null,
    size: typeof raw.size === "number" ? raw.size : null,
    mime,
    kind: kindOf(name, mime, folder),
    ext: (name.match(/\.([a-z0-9]{1,8})$/i)?.[1] || "").toLowerCase(),
    modified: typeof raw.lastModifiedDateTime === "string" ? raw.lastModifiedDateTime : null,
    created: typeof raw.createdDateTime === "string" ? raw.createdDateTime : null,
    modified_by: typeof by === "string" ? by : null,
    web_url: typeof raw.webUrl === "string" && /^https:\/\//.test(raw.webUrl) ? raw.webUrl : null,
    parent_id: typeof pr.id === "string" ? pr.id : null,
    parent_path: path,
    is_root: Boolean(raw.root),
    thumb: thumb && (thumb.small || thumb.medium || thumb.large) ? thumb : null,
  };
}

/** Folders first, then by name (natural, case-insensitive). */
export function sortItems(items: Item[]): Item[] {
  const coll = new Intl.Collator("en-AU", { numeric: true, sensitivity: "base" });
  return [...items].sort((a, b) => (a.folder === b.folder ? coll.compare(a.name, b.name) : a.folder ? -1 : 1));
}

/** Graph search text: single quotes doubled, control characters removed. */
export function searchText(q: unknown): string | null {
  if (typeof q !== "string") return null;
  const s = q.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200);
  return s ? s.replace(/'/g, "''") : null;
}

/** Only the $skiptoken of a nextLink goes back to the browser, never a URL. */
export function skipTokenOf(nextLink: unknown): string | null {
  if (typeof nextLink !== "string") return null;
  try {
    const u = new URL(nextLink);
    if (u.origin !== "https://graph.microsoft.com") return null;
    return u.searchParams.get("$skiptoken") || u.searchParams.get("$skipToken") || u.searchParams.get("skiptoken") || null;
  } catch { return null; }
}

/* ------------------------------------------------------------------ undo check */

export type Change = { op: string; item_id: string; before: Row | null; after: Row | null; undone_at?: string | null };
export type UndoPlan = { ok: true; patch: { parent_id?: string; name?: string } } | { ok: false; error: string };

/**
 * What undoing a change would do, given the item as it is now in OneDrive. Refused when the item
 * has since been moved or renamed again (by anyone, in the hub or in OneDrive itself), because
 * undoing then would silently overwrite that newer change. New folders are never removed.
 */
export function undoPlan(change: Change, current: Item | null): UndoPlan {
  if (change.undone_at) return { ok: false, error: "already_undone" };
  if (change.op === "create_folder") return { ok: false, error: "not_undoable" };
  if (!current) return { ok: false, error: "not_found" };
  const before = change.before || {}, after = change.after || {};
  if (change.op === "move") {
    if (!before.parent_id || current.parent_id !== after.parent_id || current.name !== after.name) return { ok: false, error: "changed_since" };
    return { ok: true, patch: { parent_id: String(before.parent_id) } };
  }
  if (change.op === "rename") {
    if (!before.name || current.name !== after.name || (after.parent_id && current.parent_id !== after.parent_id)) return { ok: false, error: "changed_since" };
    return { ok: true, patch: { name: String(before.name) } };
  }
  return { ok: false, error: "bad_request" };
}

/* ------------------------------------------------------------------ tokens */

export type Env = (k: string) => string | undefined;
// deno-lint-ignore no-explicit-any
type Db = any;
export type Conn = {
  refresh_token: string; access_token: string | null; access_expires_at: string | null;
  drive_id: string | null; root_id: string | null; account_name: string | null; account_email?: string | null;
  connected_by: string | null; connected_at: string; needs_reconnect: boolean; last_error: string | null;
};

export const configured = (env: Env) => Boolean(env("MS_CLIENT_ID") && env("MS_CLIENT_SECRET"));
export const redirectUri = (env: Env) =>
  `${(env("PUBLIC_FUNCTIONS_URL") ?? "https://adfgtlhryyyrqbbgbfmx.supabase.co/functions/v1").replace(/\/+$/, "")}/onedrive`;

export async function loadConn(db: Db): Promise<Conn | null> {
  const { data, error } = await db.rpc("onedrive_get");
  if (error) throw new Error(`onedrive_get: ${error.message}`);
  return (data as Conn) ?? null;
}
async function saveConn(db: Db, patch: Row): Promise<void> {
  const { error } = await db.rpc("onedrive_save", { p: patch });
  if (error) throw new Error(`onedrive_save: ${error.message}`);
}

type Fetch = typeof fetch;

/** POST the token endpoint (authorization_code or refresh_token). Throws DriveError. */
export async function tokenCall(env: Env, form: Record<string, string>, f: Fetch = fetch): Promise<Row> {
  const body = new URLSearchParams({ client_id: env("MS_CLIENT_ID") ?? "", client_secret: env("MS_CLIENT_SECRET") ?? "", scope: SCOPES, ...form });
  let res: Response;
  try {
    res = await f(`${AUTHORITY}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(15000) });
  } catch {
    throw new DriveError("busy", 503);
  }
  const data = await res.json().catch(() => ({})) as Row;
  if (!res.ok || typeof data.access_token !== "string") {
    const code = tokenErrorCode(res.status, data);
    throw new DriveError(code, statusFor(code), String(data.error ?? res.status));
  }
  return data;
}

/**
 * The drive client for one request: an access token from the cache (the connection row) or a
 * fresh one from the refresh token; 401 → refresh once; 429 → wait Retry-After once (up to 8 s),
 * then `busy`. A refresh token Microsoft rejects marks the connection `needs_reconnect`.
 */
export function driveClient(o: { db: Db; env: Env; conn: Conn; fetchImpl?: Fetch; sleep?: (ms: number) => Promise<void> }) {
  const f = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const conn = o.conn;
  let token = conn.access_token && conn.access_expires_at && Date.parse(conn.access_expires_at) - Date.now() > 120_000 ? conn.access_token : null;

  async function refresh(): Promise<string> {
    try {
      const t = await tokenCall(o.env, { grant_type: "refresh_token", refresh_token: conn.refresh_token }, f);
      token = String(t.access_token);
      const exp = new Date(Date.now() + Math.max(60, Number(t.expires_in) || 3600) * 1000).toISOString();
      // Microsoft hands back a new refresh token each time; keep the newest one.
      await saveConn(o.db, { access_token: token, access_expires_at: exp, refresh_token: typeof t.refresh_token === "string" ? t.refresh_token : "", needs_reconnect: false, last_error: null });
      return token;
    } catch (e) {
      if (e instanceof DriveError && e.code === "reconnect_needed") {
        await saveConn(o.db, { needs_reconnect: true, access_token: null, last_error: e.message }).catch(() => {});
      }
      throw e;
    }
  }

  async function call(method: string, path: string, body?: unknown): Promise<Row> {
    if (conn.needs_reconnect) throw new DriveError("reconnect_needed", 409);
    if (!token) await refresh();
    let refreshed = false, waited = false;
    for (;;) {
      let res: Response;
      try {
        res = await f(path.startsWith("https://") ? path : `${GRAPH}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(20000),
        });
      } catch {
        throw new DriveError("busy", 503);
      }
      if (res.status === 401 && !refreshed) { refreshed = true; await refresh(); continue; }
      if (res.status === 429 || res.status === 503) {
        const wait = retryAfterSeconds(res.headers.get("retry-after"));
        if (!waited && wait <= MAX_RETRY_AFTER_S) { waited = true; await sleep(wait * 1000); continue; }
        throw new DriveError("busy", 503, "throttled", wait);
      }
      if (res.status === 204) return {};
      const data = await res.json().catch(() => ({})) as Row;
      if (!res.ok) {
        const code = graphErrorCode(res.status, data);
        if (code === "unauthorized") {
          await saveConn(o.db, { needs_reconnect: true, access_token: null, last_error: "graph 401 after refresh" }).catch(() => {});
          throw new DriveError("reconnect_needed", 409);
        }
        throw new DriveError(code, statusFor(code), String((data.error as Row | undefined)?.code ?? res.status));
      }
      return data;
    }
  }
  return { call, refresh };
}
export type Drive = ReturnType<typeof driveClient>;

/* ------------------------------------------------------------------ Graph calls (exported for reuse) */

const enc1 = (id: string) => encodeURIComponent(id);
const folderPath = (id: string | null | undefined) => (!id || id === "root" ? "/me/drive/root" : `/me/drive/items/${enc1(id)}`);

export async function getItem(d: Drive, driveId: string | null, id: string, opts: { thumbs?: boolean } = {}): Promise<{ item: Item | null; raw: Row }> {
  const raw = await d.call("GET", `${folderPath(id)}${opts.thumbs ? "?$expand=thumbnails" : `?$select=${ITEM_SELECT}`}`);
  return { item: shapeItem(raw, driveId), raw };
}

export async function listChildren(d: Drive, driveId: string | null, id: string | null, cursor?: string | null) {
  const items: Item[] = [];
  let next: string | null = null;
  let url = `${folderPath(id)}/children?$top=${PAGE}&$expand=thumbnails&$select=${ITEM_SELECT}${cursor ? `&$skiptoken=${encodeURIComponent(cursor)}` : ""}`;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await d.call("GET", url);
    for (const r of (data.value as Row[]) || []) { const it = shapeItem(r, driveId); if (it) items.push(it); }
    const link = data["@odata.nextLink"];
    if (typeof link !== "string" || !link.startsWith(GRAPH)) { next = null; break; }
    url = link;
    next = skipTokenOf(link);
  }
  return { items: sortItems(items), cursor: next };
}

export async function searchDrive(d: Drive, driveId: string | null, q: string) {
  const data = await d.call("GET", `/me/drive/root/search(q='${encodeURIComponent(q)}')?$top=100&$expand=thumbnails&$select=${ITEM_SELECT}`);
  const items: Item[] = [];
  for (const r of (data.value as Row[]) || []) { const it = shapeItem(r, driveId); if (it && !it.is_root) items.push(it); }
  return items;
}

/** Breadcrumbs from the root down to `id` (walks parents, at most 15 levels). */
export async function pathTo(d: Drive, driveId: string | null, id: string | null): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  let cur: string | null = id;
  for (let i = 0; cur && i < 15; i++) {
    const { item } = await getItem(d, driveId, cur);
    if (!item) break;
    if (item.is_root) { out.unshift({ id: item.id, name: "OneDrive" }); break; }
    out.unshift({ id: item.id, name: item.name });
    cur = item.parent_id;
  }
  return out;
}

export async function patchItem(d: Drive, driveId: string | null, id: string, patch: { parent_id?: string; name?: string }) {
  const body: Row = {};
  if (patch.parent_id) body.parentReference = { id: patch.parent_id };
  if (patch.name) body.name = patch.name;
  const raw = await d.call("PATCH", `/me/drive/items/${enc1(id)}?@microsoft.graph.conflictBehavior=fail`, body);
  return shapeItem(raw, driveId);
}

export async function makeFolder(d: Drive, driveId: string | null, parentId: string, name: string) {
  const raw = await d.call("POST", `${folderPath(parentId)}/children?@microsoft.graph.conflictBehavior=fail`,
    { name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" });
  return shapeItem(raw, driveId);
}

/* ------------------------------------------------------------------ actions */

export type Member = { member_id: string; name: string; role: string };
export type Ctx = { db: Db; env: Env; member: Member; source?: "hub" | "assistant"; chatId?: string | null; fetchImpl?: Fetch };
export type Result = { status: number; body: Row };

const ok = (body: Row): Result => ({ status: 200, body: { ok: true, ...body } });
export const fail = (code: string, extra: Row = {}): Result =>
  ({ status: statusFor(code), body: { ok: false, error: code, message: MESSAGES[code] ?? "Something went wrong.", ...extra } });

const str = (v: unknown, max = 300) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const ID = /^[A-Za-z0-9!._~:-]{1,200}$/;
const itemId = (v: unknown) => (typeof v === "string" && ID.test(v) ? v : null);

async function memberName(db: Db, id: string | null): Promise<string | null> {
  if (!id) return null;
  const { data } = await db.from("team_members").select("name").eq("id", id).maybeSingle();
  return data?.name ?? null;
}
async function ownerName(db: Db): Promise<string | null> {
  const { data } = await db.from("team_members").select("name").eq("role", "owner").eq("active", true).order("sort").limit(1).maybeSingle();
  return data?.name ?? null;
}

/** status: never contacts Microsoft, never returns a token. */
async function status(ctx: Ctx): Promise<Result> {
  const isOwner = ctx.member.role === "owner";
  if (!configured(ctx.env)) return ok({ configured: false, connected: false, can_connect: isOwner, owner_name: await ownerName(ctx.db) });
  const conn = await loadConn(ctx.db);
  return ok({
    configured: true,
    connected: Boolean(conn),
    needs_reconnect: Boolean(conn?.needs_reconnect),
    can_connect: isOwner,
    owner_name: await ownerName(ctx.db),
    account: conn ? { name: conn.account_name, connected_at: conn.connected_at, connected_by: await memberName(ctx.db, conn.connected_by), root_id: conn.root_id } : null,
  });
}

async function connectUrl(ctx: Ctx): Promise<Result> {
  if (ctx.member.role !== "owner") return fail("owner_only");
  if (!configured(ctx.env)) return fail("not_configured");
  const secret = await stateSecret(ctx.env);
  const nonce = newNonce();
  const state = await signState(ctx.member.member_id, nonce, secret);
  const challenge = await pkceChallenge(await pkceVerifier(secret, nonce));
  return ok({ url: authorizeUrl({ clientId: ctx.env("MS_CLIENT_ID")!, redirectUri: redirectUri(ctx.env), state, challenge }), expires_in: STATE_TTL_S });
}

async function disconnect(ctx: Ctx): Promise<Result> {
  if (ctx.member.role !== "owner") return fail("owner_only");
  const { error } = await ctx.db.rpc("onedrive_clear");
  if (error) throw new Error(error.message);
  return ok({ connected: false });
}

/** Open a drive client, or a failure result (not configured / not connected / reconnect). */
export async function openDrive(ctx: Ctx): Promise<{ d: Drive; conn: Conn } | Result> {
  if (!configured(ctx.env)) return fail("not_configured");
  const conn = await loadConn(ctx.db);
  if (!conn) return fail("not_connected");
  if (conn.needs_reconnect) return fail("reconnect_needed");
  return { d: driveClient({ db: ctx.db, env: ctx.env, conn, fetchImpl: ctx.fetchImpl }), conn };
}

async function logChange(ctx: Ctx, row: Row): Promise<Row | null> {
  const { data, error } = await ctx.db.from("file_changes").insert({
    ...row, member_id: ctx.member.member_id, source: ctx.source ?? "hub", chat_id: isUuid(ctx.chatId) ? ctx.chatId : null,
  }).select("*").single();
  if (error) { console.error("file_changes insert failed", error.message); return null; }
  return data;
}

async function linksFor(db: Db, itemIdv: string) {
  const { data } = await db.from("file_links").select("*").eq("item_id", itemIdv).order("created_at");
  return data ?? [];
}

/** Run one action. `body.action` picks it. Throws only on programming/database errors. */
export async function runAction(ctx: Ctx, body: Row): Promise<Result> {
  const action = String(body.action ?? "");
  try {
    if (action === "status") return await status(ctx);
    if (action === "connect_url") return await connectUrl(ctx);
    if (action === "disconnect") return await disconnect(ctx);

    const drive = [
      "list", "search", "item", "move", "rename", "create_folder", "undo", "link", "unlink", "folders",
    ].includes(action) ? await openDrive(ctx) : null;
    if (!drive) return fail("bad_request");
    if ("status" in drive && "body" in drive) return drive as Result;
    const { d, conn } = drive as { d: Drive; conn: Conn };
    const driveId = conn.drive_id;
    const rootId = conn.root_id;
    const resolve = (v: unknown) => (v === "root" || v === undefined || v === null || v === "" ? rootId : itemId(v));

    if (action === "list" || action === "folders") {
      const id = resolve(body.item_id);
      if (!id) return fail("bad_request");
      const [{ item: folder }, listing] = await Promise.all([getItem(d, driveId, id), listChildren(d, driveId, id, str(body.cursor, 2000))]);
      if (!folder) return fail("outside_drive");
      if (!folder.folder) return fail("bad_request", { message: "That is a file, not a folder." });
      const items = action === "folders" ? listing.items.filter((i) => i.folder) : listing.items;
      const path = body.with_path || action === "folders" ? await pathTo(d, driveId, folder.id) : null;
      return ok({ folder, items, cursor: listing.cursor, path });
    }

    if (action === "search") {
      const q = searchText(body.q);
      if (!q) return fail("bad_request");
      return ok({ q: String(body.q).trim(), items: await searchDrive(d, driveId, q) });
    }

    if (action === "item") {
      const id = itemId(body.id);
      if (!id) return fail("bad_request");
      const { item, raw } = await getItem(d, driveId, id, { thumbs: true });
      if (!item) return fail("outside_drive");
      const dl = !item.folder && typeof raw["@microsoft.graph.downloadUrl"] === "string" ? String(raw["@microsoft.graph.downloadUrl"]) : null;
      const path = body.with_path ? await pathTo(d, driveId, item.parent_id) : null;
      return ok({ item, download_url: dl && /^https:\/\//.test(dl) ? dl : null, path, links: await linksFor(ctx.db, item.id) });
    }

    if (action === "move") {
      const id = itemId(body.id), parent = resolve(body.parent_id);
      if (!id || !parent) return fail("bad_request");
      if (id === parent) return fail("bad_move");
      const [{ item: cur }, { item: dest }] = await Promise.all([getItem(d, driveId, id), getItem(d, driveId, parent)]);
      if (!cur || !dest) return fail("outside_drive");
      if (!dest.folder) return fail("bad_request", { message: "You can only move things into a folder." });
      if (cur.is_root) return fail("bad_request");
      if (cur.parent_id === dest.id) return ok({ item: cur, change: null, unchanged: true });
      if (cur.folder) {
        const destPath = await pathTo(d, driveId, dest.id);
        if (destPath.some((p) => p.id === cur.id)) return fail("bad_move");
      }
      const fromPath = await pathTo(d, driveId, cur.parent_id);
      const moved = await patchItem(d, driveId, id, { parent_id: dest.id });
      const fromName = fromPath.at(-1)?.name ?? "OneDrive";
      const toName = dest.is_root ? "OneDrive" : dest.name;
      const change = await logChange(ctx, {
        item_id: id, op: "move",
        before: { parent_id: cur.parent_id, parent_name: fromName, name: cur.name },
        after: { parent_id: dest.id, parent_name: toName, name: moved?.name ?? cur.name },
        summary: `Moved ${cur.name} from ${fromName} to ${toName}`,
      });
      return ok({ item: moved, change });
    }

    if (action === "rename") {
      const id = itemId(body.id);
      const nm = cleanName(body.name);
      if (!id) return fail("bad_request");
      if (!nm.ok) return fail("bad_name");
      const { item: cur } = await getItem(d, driveId, id);
      if (!cur) return fail("outside_drive");
      if (cur.is_root) return fail("bad_request");
      if (cur.name === nm.name) return ok({ item: cur, change: null, unchanged: true });
      const renamed = await patchItem(d, driveId, id, { name: nm.name });
      const change = await logChange(ctx, {
        item_id: id, op: "rename",
        before: { name: cur.name, parent_id: cur.parent_id },
        after: { name: renamed?.name ?? nm.name, parent_id: cur.parent_id },
        summary: `Renamed ${cur.name} to ${renamed?.name ?? nm.name}`,
      });
      // Keep the names on links current.
      await ctx.db.from("file_links").update({ name: renamed?.name ?? nm.name }).eq("item_id", id);
      return ok({ item: renamed, change });
    }

    if (action === "create_folder") {
      const parent = resolve(body.parent_id);
      const nm = cleanName(body.name);
      if (!parent) return fail("bad_request");
      if (!nm.ok) return fail("bad_name");
      const { item: dest } = await getItem(d, driveId, parent);
      if (!dest) return fail("outside_drive");
      if (!dest.folder) return fail("bad_request");
      const made = await makeFolder(d, driveId, dest.id, nm.name);
      if (!made) return fail("ms_error");
      const where = dest.is_root ? "OneDrive" : dest.name;
      const change = await logChange(ctx, {
        item_id: made.id, op: "create_folder", before: null,
        after: { name: made.name, parent_id: dest.id, parent_name: where },
        summary: `Made a folder ${made.name} in ${where}`,
      });
      return ok({ item: made, change });
    }

    if (action === "undo") {
      if (!isUuid(body.change_id)) return fail("bad_request");
      const { data: ch, error } = await ctx.db.from("file_changes").select("*").eq("id", body.change_id).maybeSingle();
      if (error) throw new Error(error.message);
      if (!ch) return fail("not_found", { message: "That change is not in the log." });
      let current: Item | null = null;
      if (ch.op !== "create_folder" && !ch.undone_at) {
        try { current = (await getItem(d, driveId, ch.item_id)).item; } catch (e) {
          if (!(e instanceof DriveError && e.code === "not_found")) throw e;
        }
      }
      const plan = undoPlan(ch, current);
      if (!plan.ok) return fail(plan.error);
      const item = await patchItem(d, driveId, ch.item_id, plan.patch);
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
      const { item } = await getItem(d, driveId, id);
      if (!item) return fail("outside_drive");
      const row = { item_id: item.id, name: item.name, web_url: item.web_url, mime: item.mime, is_folder: item.folder, kind, record_id: body.record_id, created_by: ctx.member.member_id };
      const { data, error } = await ctx.db.from("file_links").upsert(row, { onConflict: "item_id,kind,record_id" }).select("*").single();
      if (error) throw new Error(error.message);
      return ok({ link: data });
    }

    if (action === "unlink") {
      if (!isUuid(body.link_id)) return fail("bad_request");
      // Removes the hub's link only. The file in OneDrive is untouched.
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

/* ------------------------------------------------------------------ OAuth callback */

export const HUB_FILES = "https://wise-ai.au/os/";
export const backTo = (result: string) => `${HUB_FILES}?onedrive=${encodeURIComponent(result)}#files`;

/**
 * GET ?code&state (or ?error&state): validate state (signature, 10-minute expiry, one use, still
 * the owner), swap the code for tokens, read the account name and drive root, store, and return
 * the URL to send the browser back to. Never throws; every failure maps to a result flag.
 */
export async function handleCallback(o: { db: Db; env: Env; params: URLSearchParams; fetchImpl?: Fetch }): Promise<string> {
  const { db, env, params } = o;
  try {
    if (!configured(env)) return backTo("not_configured");
    const secret = await stateSecret(env);
    const st = await verifyState(params.get("state"), secret);
    if (!st.ok) return backTo(st.error === "expired" ? "expired" : "bad_state");
    const { data: fresh, error: nErr } = await db.rpc("onedrive_use_nonce", { p_nonce: st.nonce });
    if (nErr || fresh !== true) return backTo("bad_state");
    if (params.get("error")) return backTo(params.get("error") === "access_denied" ? "denied" : "error");
    const code = params.get("code");
    if (!code || code.length > 4000) return backTo("error");
    const { data: m } = await db.from("team_members").select("id, role, active").eq("id", st.member).maybeSingle();
    if (!m || m.role !== "owner" || !m.active) return backTo("not_owner");

    const t = await tokenCall(env, {
      grant_type: "authorization_code", code, redirect_uri: redirectUri(env), code_verifier: await pkceVerifier(secret, st.nonce),
    }, o.fetchImpl);
    if (typeof t.refresh_token !== "string") return backTo("error");
    const access = String(t.access_token);
    const g = async (path: string) => {
      const r = await (o.fetchImpl ?? fetch)(`${GRAPH}${path}`, { headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(15000) });
      return r.ok ? await r.json() as Row : null;
    };
    const [me, root] = await Promise.all([g("/me?$select=displayName,userPrincipalName,mail"), g("/me/drive/root?$select=id,parentReference")]);
    if (!root || typeof root.id !== "string") return backTo("no_drive");
    await saveConn(db, {
      refresh_token: t.refresh_token, access_token: access,
      access_expires_at: new Date(Date.now() + Math.max(60, Number(t.expires_in) || 3600) * 1000).toISOString(),
      drive_id: String((root.parentReference as Row | undefined)?.driveId ?? "") || null, root_id: root.id,
      account_name: (me?.displayName as string) || "OneDrive", account_email: (me?.userPrincipalName as string) || (me?.mail as string) || null,
      connected_by: st.member, connected_at: new Date().toISOString(),
    });
    return backTo("connected");
  } catch (e) {
    console.error("onedrive callback", (e as Error).message);
    return backTo(e instanceof DriveError && e.code === "busy" ? "busy" : "error");
  }
}
