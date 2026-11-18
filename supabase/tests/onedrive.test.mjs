// Unit checks for the OneDrive helpers and actions (no network: Microsoft and the database are faked).
// Run: node --test supabase/tests/onedrive.test.mjs   (Node >= 22.18 strips TypeScript types natively)
import test from "node:test";
import assert from "node:assert/strict";
import {
  signState, verifyState, stateSecret, pkceVerifier, pkceChallenge, authorizeUrl, newNonce, STATE_TTL_S, SCOPES,
  graphErrorCode, tokenErrorCode, statusFor, retryAfterSeconds, cleanName, shapeItem, kindOf, sortItems, searchText,
  skipTokenOf, undoPlan, driveClient, runAction, handleCallback, DriveError, backTo,
} from "../functions/_shared/onedrive.ts";

const SECRET = "dummy-state-secret-for-tests-only-0123456789";
const MEMBER = "11111111-2222-4333-8444-555555555555";

/* ---------------------------------------------------------------- state + PKCE */

test("state: signs, verifies, binds the member and nonce", async () => {
  const now = 1_800_000_000;
  const s = await signState(MEMBER, "nonce-abcdefghijklmnop", SECRET, now);
  const r = await verifyState(s, SECRET, now + 10);
  assert.deepEqual(r, { ok: true, member: MEMBER, nonce: "nonce-abcdefghijklmnop" });
});

test("state: expires after 10 minutes", async () => {
  const now = 1_800_000_000;
  const s = await signState(MEMBER, "nonce-abcdefghijklmnop", SECRET, now);
  assert.equal(STATE_TTL_S, 600);
  assert.equal((await verifyState(s, SECRET, now + 600)).ok, true);
  assert.deepEqual(await verifyState(s, SECRET, now + 601), { ok: false, error: "expired" });
});

test("state: tampering, wrong secret and junk are refused", async () => {
  const now = 1_800_000_000;
  const s = await signState(MEMBER, "nonce-abcdefghijklmnop", SECRET, now);
  const [p, sig] = s.split(".");
  const forged = Buffer.from(JSON.stringify({ m: "99999999-2222-4333-8444-555555555555", n: "nonce-abcdefghijklmnop", e: now + 600 })).toString("base64url");
  assert.equal((await verifyState(`${forged}.${sig}`, SECRET, now)).error, "bad_state");
  assert.equal((await verifyState(s, `${SECRET}x`, now)).error, "bad_state");
  assert.equal((await verifyState(`${p}.${sig}x`, SECRET, now)).error, "bad_state");
  assert.equal((await verifyState(`${p}.${sig}.x`, SECRET, now)).error, "bad_state");
  for (const junk of [null, "", "abc", 42, "a".repeat(700)]) assert.equal((await verifyState(junk, SECRET, now)).ok, false);
  // An expiry pushed far into the future (a forged long-lived state) is refused even if signed.
  const longPayload = Buffer.from(JSON.stringify({ m: MEMBER, n: "nonce-abcdefghijklmnop", e: now + 86400 })).toString("base64url");
  const { createHmac } = await import("node:crypto");
  const longSig = createHmac("sha256", SECRET).update(longPayload).digest("base64url");
  assert.equal((await verifyState(`${longPayload}.${longSig}`, SECRET, now)).error, "bad_state");
});

test("state secret: own secret wins, otherwise derived from the service key", async () => {
  const a = await stateSecret((k) => ({ SUPABASE_SERVICE_ROLE_KEY: "svc-key" })[k]);
  const b = await stateSecret((k) => ({ SUPABASE_SERVICE_ROLE_KEY: "svc-key" })[k]);
  const c = await stateSecret((k) => ({ SUPABASE_SERVICE_ROLE_KEY: "other" })[k]);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, "svc-key");
  assert.equal(await stateSecret((k) => ({ ONEDRIVE_STATE_SECRET: "x".repeat(40), SUPABASE_SERVICE_ROLE_KEY: "svc" })[k]), "x".repeat(40));
});

test("PKCE: verifier is stable per nonce; challenge is S256 base64url", async () => {
  const v = await pkceVerifier(SECRET, "n1-abcdefghijklmnop");
  assert.equal(v, await pkceVerifier(SECRET, "n1-abcdefghijklmnop"));
  assert.notEqual(v, await pkceVerifier(SECRET, "n2-abcdefghijklmnop"));
  assert.ok(v.length >= 43 && v.length <= 128);
  const { createHash } = await import("node:crypto");
  assert.equal(await pkceChallenge(v), createHash("sha256").update(v).digest("base64url"));
  const url = new URL(authorizeUrl({ clientId: "cid", redirectUri: "https://x.supabase.co/functions/v1/onedrive", state: "s", challenge: "c" }));
  assert.equal(url.origin + url.pathname, "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize");
  assert.equal(url.searchParams.get("scope"), "Files.ReadWrite offline_access User.Read");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(SCOPES.includes("offline_access"), true);
  assert.ok(newNonce().length >= 30);
});

/* ---------------------------------------------------------------- error mapping */

test("Graph errors map to plain codes", () => {
  assert.equal(graphErrorCode(404, { error: { code: "itemNotFound" } }), "not_found");
  assert.equal(graphErrorCode(409, { error: { code: "nameAlreadyExists" } }), "name_taken");
  assert.equal(graphErrorCode(429, {}), "busy");
  assert.equal(graphErrorCode(503, { error: { code: "serviceNotAvailable" } }), "busy");
  assert.equal(graphErrorCode(423, {}), "locked");
  assert.equal(graphErrorCode(507, {}), "drive_full");
  assert.equal(graphErrorCode(403, { error: { code: "accessDenied" } }), "forbidden");
  assert.equal(graphErrorCode(401, {}), "unauthorized");
  assert.equal(graphErrorCode(500, {}), "ms_error");
  assert.equal(tokenErrorCode(400, { error: "invalid_grant" }), "reconnect_needed");
  assert.equal(tokenErrorCode(400, { error: "interaction_required" }), "reconnect_needed");
  assert.equal(tokenErrorCode(401, { error: "invalid_client" }), "not_configured");
  assert.equal(tokenErrorCode(503, { error: "temporarily_unavailable" }), "busy");
  assert.equal(statusFor("reconnect_needed"), 409);
  assert.equal(statusFor("busy"), 503);
  assert.equal(statusFor("owner_only"), 403);
  assert.equal(retryAfterSeconds("7"), 7);
  assert.equal(retryAfterSeconds(null), 2);
  assert.equal(retryAfterSeconds(new Date(Date.now() + 5000).toUTCString()) <= 5, true);
});

/* ---------------------------------------------------------------- names, items */

test("names: OneDrive's rules", () => {
  assert.deepEqual(cleanName("  Proposal v2.docx "), { ok: true, name: "Proposal v2.docx" });
  for (const bad of ["", "   ", "a/b", "a\\b", "what?", "x:y", "<a>", "pipe|d", 'q"', "ends.", "CON", "desktop.ini", "~$lock.docx", "a".repeat(251), 5]) {
    assert.equal(cleanName(bad).ok, false, `refuses ${bad}`);
  }
});

test("items: shape, kinds, outside-drive items dropped, folders first", () => {
  const it = shapeItem({ id: "A!1", name: "Quote.PDF", size: 1200, file: { mimeType: "application/pdf" }, webUrl: "https://onedrive.live.com/x",
    parentReference: { driveId: "abc", id: "A!0", path: "/drive/root:/Clients/Smith%20Plumbing" }, lastModifiedBy: { user: { displayName: "Tyler" } },
    thumbnails: [{ small: { url: "https://t/s" }, large: { url: "https://t/l" } }] }, "ABC");
  assert.equal(it.kind, "pdf");
  assert.equal(it.ext, "pdf");
  assert.equal(it.parent_path, "/Clients/Smith Plumbing");
  assert.equal(it.modified_by, "Tyler");
  assert.equal(it.thumb.large, "https://t/l");
  assert.equal(shapeItem({ id: "B!1", name: "x", remoteItem: { id: "Z" }, parentReference: { driveId: "abc" } }, "abc"), null);
  assert.equal(shapeItem({ id: "B!2", name: "x", parentReference: { driveId: "other" } }, "abc"), null);
  assert.equal(shapeItem({ id: "B!3", name: "x", webUrl: "javascript:alert(1)" }, "abc").web_url, null);
  assert.equal(kindOf("a.docx", null, false), "word");
  assert.equal(kindOf("a.xlsx", null, false), "excel");
  assert.equal(kindOf("a.pptx", null, false), "powerpoint");
  assert.equal(kindOf("a.heic", null, false), "image");
  assert.equal(kindOf("a", null, true), "folder");
  const sorted = sortItems([{ name: "b", folder: false }, { name: "File 10", folder: false }, { name: "z", folder: true }, { name: "File 2", folder: false }, { name: "A", folder: true }]);
  assert.deepEqual(sorted.map((i) => i.name), ["A", "z", "b", "File 2", "File 10"]);
  assert.equal(searchText("O'Brien quote"), "O''Brien quote");
  assert.equal(searchText("   "), null);
  assert.equal(skipTokenOf("https://graph.microsoft.com/v1.0/me/drive/items/x/children?$skiptoken=abc"), "abc");
  assert.equal(skipTokenOf("https://evil.example/?$skiptoken=abc"), null);
});

/* ---------------------------------------------------------------- undo */

test("undo: refuses when the item moved or was renamed again", () => {
  const move = { op: "move", item_id: "I", before: { parent_id: "P1", name: "a.pdf" }, after: { parent_id: "P2", name: "a.pdf" } };
  assert.deepEqual(undoPlan(move, { parent_id: "P2", name: "a.pdf" }), { ok: true, patch: { parent_id: "P1" } });
  assert.deepEqual(undoPlan(move, { parent_id: "P3", name: "a.pdf" }), { ok: false, error: "changed_since" });
  assert.deepEqual(undoPlan(move, { parent_id: "P2", name: "b.pdf" }), { ok: false, error: "changed_since" });
  assert.deepEqual(undoPlan(move, null), { ok: false, error: "not_found" });
  const ren = { op: "rename", item_id: "I", before: { name: "old.docx", parent_id: "P" }, after: { name: "new.docx", parent_id: "P" } };
  assert.deepEqual(undoPlan(ren, { parent_id: "P", name: "new.docx" }), { ok: true, patch: { name: "old.docx" } });
  assert.deepEqual(undoPlan(ren, { parent_id: "P", name: "newer.docx" }), { ok: false, error: "changed_since" });
  assert.deepEqual(undoPlan(ren, { parent_id: "Q", name: "new.docx" }), { ok: false, error: "changed_since" });
  assert.deepEqual(undoPlan({ ...ren, undone_at: "2026-01-01" }, { parent_id: "P", name: "new.docx" }), { ok: false, error: "already_undone" });
  assert.deepEqual(undoPlan({ op: "create_folder", item_id: "F", before: null, after: { name: "x" } }, { name: "x" }), { ok: false, error: "not_undoable" });
});

/* ---------------------------------------------------------------- fakes */

function fakeDb(seed = {}) {
  const tables = { team_members: [], file_links: [], file_changes: [], clients: [], projects: [], deals: [], leads: [], ...seed.tables };
  const store = { conn: seed.conn ?? null, nonces: new Set(), saves: [] };
  let n = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const query = (t) => {
    let rows = () => tables[t];
    const filters = [];
    let op = "select", payload = null, conflict = null;
    const apply = () => tables[t].filter((r) => filters.every((f) => f(r)));
    const b = {
      select() { return b; }, order() { return b; }, limit() { return b; },
      eq(k, v) { filters.push((r) => r[k] === v); return b; },
      is(k, v) { filters.push((r) => (r[k] ?? null) === v); return b; },
      insert(row) { op = "insert"; payload = row; return b; },
      upsert(row, o) { op = "upsert"; payload = row; conflict = o?.onConflict; return b; },
      update(p) { op = "update"; payload = p; return b; },
      delete() { op = "delete"; return b; },
      run() {
        if (op === "insert") { const r = { id: uuid(), at: new Date().toISOString(), undone_at: null, ...payload }; tables[t].push(r); return [r]; }
        if (op === "upsert") {
          const keys = conflict.split(",");
          let r = tables[t].find((x) => keys.every((k) => x[k] === payload[k]));
          if (r) Object.assign(r, payload); else { r = { id: uuid(), ...payload }; tables[t].push(r); }
          return [r];
        }
        if (op === "update") { const hit = apply(); hit.forEach((r) => Object.assign(r, payload)); return hit; }
        if (op === "delete") { const hit = apply(); tables[t] = tables[t].filter((r) => !hit.includes(r)); return hit; }
        return apply();
      },
      maybeSingle() { const r = b.run(); return Promise.resolve({ data: r[0] ?? null, error: null }); },
      single() { const r = b.run(); return Promise.resolve({ data: r[0] ?? null, error: r[0] ? null : { message: "none" } }); },
      then(res, rej) { return Promise.resolve({ data: b.run(), error: null }).then(res, rej); },
    };
    void rows;
    return b;
  };
  return {
    tables, store,
    from: query,
    rpc(name, args) {
      if (name === "onedrive_get") return Promise.resolve({ data: store.conn ? { ...store.conn } : null, error: null });
      if (name === "onedrive_save") { store.saves.push(args.p); store.conn = { ...(store.conn || {}), ...Object.fromEntries(Object.entries(args.p).filter(([k, v]) => !(k === "refresh_token" && !v))) }; return Promise.resolve({ data: { ok: true }, error: null }); }
      if (name === "onedrive_clear") { store.conn = null; return Promise.resolve({ data: null, error: null }); }
      if (name === "onedrive_use_nonce") { const fresh = !store.nonces.has(args.p_nonce); store.nonces.add(args.p_nonce); return Promise.resolve({ data: fresh, error: null }); }
      return Promise.resolve({ data: null, error: { message: `unknown rpc ${name}` } });
    },
  };
}

/** A tiny in-memory OneDrive behind fetch. */
function fakeGraph() {
  const items = {
    ROOT: { id: "ROOT", name: "root", root: {}, folder: { childCount: 3 } },
    F1: { id: "F1", name: "Clients", folder: { childCount: 1 }, parentReference: { driveId: "d1", id: "ROOT", path: "/drive/root:" } },
    F2: { id: "F2", name: "Archive", folder: { childCount: 0 }, parentReference: { driveId: "d1", id: "ROOT", path: "/drive/root:" } },
    P1: { id: "P1", name: "Quote.pdf", size: 1000, file: { mimeType: "application/pdf" }, parentReference: { driveId: "d1", id: "F1", path: "/drive/root:/Clients" }, "@microsoft.graph.downloadUrl": "https://public.dl/p1" },
    R1: { id: "R1", name: "Shared with me", folder: {}, remoteItem: { id: "X" }, parentReference: { driveId: "d1", id: "ROOT" } },
  };
  const calls = [];
  let tokenCalls = 0;
  const plan = { graph401Once: false, throttleOnce: 0, tokenError: null };
  const res = (status, body, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const f = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(`${init.method || "GET"} ${u.pathname}`);
    if (u.host === "login.microsoftonline.com") {
      tokenCalls++;
      if (plan.tokenError) return res(400, { error: plan.tokenError });
      return res(200, { access_token: `at${tokenCalls}`, refresh_token: `rt${tokenCalls}`, expires_in: 3600 });
    }
    if (plan.graph401Once) { plan.graph401Once = false; return res(401, { error: { code: "InvalidAuthenticationToken" } }); }
    if (plan.throttleOnce > 0) { plan.throttleOnce--; return res(429, { error: { code: "TooManyRequests" } }, { "retry-after": "1" }); }
    const p = decodeURIComponent(u.pathname.replace("/v1.0", ""));
    let m;
    if ((m = /^\/me\/drive\/(?:root|items\/([^/]+))\/children$/.exec(p))) {
      const pid = m[1] || "ROOT";
      if ((init.method || "GET") === "POST") {
        const b = JSON.parse(init.body);
        if (Object.values(items).some((i) => i.parentReference?.id === pid && i.name === b.name)) return res(409, { error: { code: "nameAlreadyExists" } });
        const id = `N${Object.keys(items).length}`;
        items[id] = { id, name: b.name, folder: { childCount: 0 }, parentReference: { driveId: "d1", id: pid } };
        return res(201, items[id]);
      }
      return res(200, { value: Object.values(items).filter((i) => i.parentReference?.id === pid) });
    }
    if ((m = /^\/me\/drive\/(?:root|items\/([^/]+))$/.exec(p))) {
      const it = items[m[1] || "ROOT"];
      if (!it) return res(404, { error: { code: "itemNotFound" } });
      if ((init.method || "GET") === "PATCH") {
        const b = JSON.parse(init.body);
        const pid = b.parentReference?.id ?? it.parentReference.id;
        const nm = b.name ?? it.name;
        if (Object.values(items).some((i) => i !== it && i.parentReference?.id === pid && i.name === nm)) return res(409, { error: { code: "nameAlreadyExists" } });
        it.name = nm;
        it.parentReference = { ...it.parentReference, id: pid };
      }
      return res(200, it);
    }
    if (/^\/me\/drive\/root\/search/.test(p)) return res(200, { value: Object.values(items).filter((i) => !i.root && /quote|shared/i.test(i.name)) });
    if (p === "/me") return res(200, { displayName: "Tyler W" });
    return res(404, { error: { code: "itemNotFound" } });
  };
  return { f, items, calls, plan, tokenCalls: () => tokenCalls };
}

const ENV = (k) => ({ MS_CLIENT_ID: "cid", MS_CLIENT_SECRET: "csecret", SUPABASE_SERVICE_ROLE_KEY: "svc" })[k];
const NO_ENV = (k) => ({ SUPABASE_SERVICE_ROLE_KEY: "svc" })[k];
const OWNER = { member_id: MEMBER, name: "Tyler", role: "owner" };
const STAFF = { member_id: "22222222-2222-4333-8444-555555555555", name: "Jay", role: "member" };
const CONN = () => ({ refresh_token: "rt0", access_token: "at0", access_expires_at: new Date(Date.now() + 3600e3).toISOString(), drive_id: "d1", root_id: "ROOT", account_name: "Tyler W", connected_by: MEMBER, connected_at: "2026-11-18T00:00:00Z", needs_reconnect: false, last_error: null });

/* ---------------------------------------------------------------- actions */

test("status: not configured is clean; never returns tokens", async () => {
  const db = fakeDb({ tables: { team_members: [{ id: MEMBER, name: "Tyler", role: "owner", active: true }] } });
  let r = await runAction({ db, env: NO_ENV, member: STAFF }, { action: "status" });
  assert.equal(r.status, 200);
  assert.equal(r.body.configured, false);
  assert.equal(r.body.can_connect, false);
  assert.equal(r.body.owner_name, "Tyler");
  db.store.conn = CONN();
  r = await runAction({ db, env: ENV, member: OWNER }, { action: "status" });
  assert.equal(r.body.connected, true);
  assert.equal(r.body.account.name, "Tyler W");
  assert.doesNotMatch(JSON.stringify(r.body), /rt0|at0/);
  assert.equal((await runAction({ db, env: ENV, member: STAFF }, { action: "connect_url" })).body.error, "owner_only");
  assert.equal((await runAction({ db, env: ENV, member: STAFF }, { action: "disconnect" })).body.error, "owner_only");
  assert.equal((await runAction({ db, env: NO_ENV, member: OWNER }, { action: "list" })).body.error, "not_configured");
  db.store.conn = null;
  assert.equal((await runAction({ db, env: ENV, member: OWNER }, { action: "list" })).body.error, "not_connected");
});

test("list: folders first, shared-from-elsewhere dropped, root resolves", async () => {
  const g = fakeGraph();
  const db = fakeDb({ conn: CONN() });
  const r = await runAction({ db, env: ENV, member: STAFF, fetchImpl: g.f }, { action: "list", with_path: true });
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.items.map((i) => i.name), ["Archive", "Clients"]);
  assert.equal(r.body.folder.is_root, true);
  assert.deepEqual(r.body.path, [{ id: "ROOT", name: "OneDrive" }]);
  const s = await runAction({ db, env: ENV, member: STAFF, fetchImpl: g.f }, { action: "search", q: "quote" });
  assert.deepEqual(s.body.items.map((i) => i.name), ["Quote.pdf"]);
  const it = await runAction({ db, env: ENV, member: STAFF, fetchImpl: g.f }, { action: "item", id: "P1", with_path: true });
  assert.equal(it.body.download_url, "https://public.dl/p1");
  assert.deepEqual(it.body.path.map((p) => p.name), ["OneDrive", "Clients"]);
  const remote = await runAction({ db, env: ENV, member: STAFF, fetchImpl: g.f }, { action: "item", id: "R1" });
  assert.equal(remote.body.error, "outside_drive");
  assert.equal(remote.body.download_url, undefined);
});

test("move, rename, undo with conflict check; new folders are logged and not undoable", async () => {
  const g = fakeGraph();
  const db = fakeDb({ conn: CONN() });
  const ctx = { db, env: ENV, member: STAFF, fetchImpl: g.f };
  const mv = await runAction(ctx, { action: "move", id: "P1", parent_id: "F2" });
  assert.equal(mv.body.ok, true);
  assert.equal(g.items.P1.parentReference.id, "F2");
  assert.equal(mv.body.change.op, "move");
  assert.equal(mv.body.change.summary, "Moved Quote.pdf from Clients to Archive");
  assert.equal(mv.body.change.source, "hub");
  assert.equal(mv.body.change.member_id, STAFF.member_id);
  // Undo puts it back.
  const un = await runAction(ctx, { action: "undo", change_id: mv.body.change.id });
  assert.equal(un.body.ok, true);
  assert.equal(g.items.P1.parentReference.id, "F1");
  assert.ok(db.tables.file_changes[0].undone_at);
  assert.equal((await runAction(ctx, { action: "undo", change_id: mv.body.change.id })).body.error, "already_undone");
  // Rename, then someone renames it again in OneDrive: undo is refused.
  const rn = await runAction(ctx, { action: "rename", id: "P1", name: "Quote v2.pdf" });
  assert.equal(g.items.P1.name, "Quote v2.pdf");
  g.items.P1.name = "Quote final.pdf";
  const refused = await runAction(ctx, { action: "undo", change_id: rn.body.change.id });
  assert.equal(refused.body.error, "changed_since");
  assert.equal(refused.status, 409);
  assert.equal(g.items.P1.name, "Quote final.pdf");
  // Bad names and moving a folder into itself.
  assert.equal((await runAction(ctx, { action: "rename", id: "P1", name: "a/b" })).body.error, "bad_name");
  assert.equal((await runAction(ctx, { action: "move", id: "F1", parent_id: "F1" })).body.error, "bad_move");
  // New folder; a clash is a friendly name_taken.
  const nf = await runAction({ ...ctx, source: "assistant", chatId: "33333333-2222-4333-8444-555555555555" }, { action: "create_folder", name: "Smith Plumbing" });
  assert.equal(nf.body.ok, true);
  assert.equal(nf.body.change.source, "assistant");
  assert.equal(nf.body.change.chat_id, "33333333-2222-4333-8444-555555555555");
  assert.equal((await runAction(ctx, { action: "create_folder", name: "Smith Plumbing" })).body.error, "name_taken");
  assert.equal((await runAction(ctx, { action: "undo", change_id: nf.body.change.id })).body.error, "not_undoable");
  // There is no delete call anywhere.
  assert.equal(g.calls.some((c) => c.startsWith("DELETE")), false);
});

test("links: only to records that exist; unlink removes the link, not the file", async () => {
  const g = fakeGraph();
  const CL = "44444444-2222-4333-8444-555555555555";
  const db = fakeDb({ conn: CONN(), tables: { clients: [{ id: CL }] } });
  const ctx = { db, env: ENV, member: STAFF, fetchImpl: g.f };
  assert.equal((await runAction(ctx, { action: "link", item_id: "P1", kind: "client", record_id: "55555555-2222-4333-8444-555555555555" })).body.error, "not_found");
  assert.equal((await runAction(ctx, { action: "link", item_id: "P1", kind: "invoice", record_id: CL })).body.error, "bad_request");
  const l = await runAction(ctx, { action: "link", item_id: "P1", kind: "client", record_id: CL });
  assert.equal(l.body.link.name, "Quote.pdf");
  await runAction(ctx, { action: "link", item_id: "P1", kind: "client", record_id: CL });
  assert.equal(db.tables.file_links.length, 1);
  const u = await runAction(ctx, { action: "unlink", link_id: l.body.link.id });
  assert.equal(u.body.ok, true);
  assert.equal(db.tables.file_links.length, 0);
  assert.ok(g.items.P1);
});

test("tokens: cached until expiry, refreshed once on 401, 429 waits once then busy, revoked → reconnect_needed", async () => {
  const g = fakeGraph();
  const db = fakeDb({ conn: CONN() });
  const ctx = { db, env: ENV, member: STAFF, fetchImpl: g.f };
  await runAction(ctx, { action: "list" });
  assert.equal(g.tokenCalls(), 0, "cached access token used");
  g.plan.graph401Once = true;
  assert.equal((await runAction(ctx, { action: "list" })).body.ok, true);
  assert.equal(g.tokenCalls(), 1, "refreshed once on 401");
  assert.equal(db.store.conn.refresh_token, "rt1", "new refresh token kept");
  // 429 with Retry-After: waits once and succeeds.
  const sleeps = [];
  const d = driveClient({ db, env: ENV, conn: db.store.conn, fetchImpl: g.f, sleep: async (ms) => { sleeps.push(ms); } });
  g.plan.throttleOnce = 1;
  await d.call("GET", "/me/drive/root");
  assert.deepEqual(sleeps, [1000]);
  g.plan.throttleOnce = 2;
  await assert.rejects(d.call("GET", "/me/drive/root"), (e) => e instanceof DriveError && e.code === "busy");
  // Expired access token + refresh token revoked.
  db.store.conn = { ...CONN(), access_expires_at: new Date(Date.now() - 1000).toISOString() };
  g.plan.tokenError = "invalid_grant";
  const r = await runAction(ctx, { action: "list" });
  assert.equal(r.body.error, "reconnect_needed");
  assert.equal(db.store.conn.needs_reconnect, true);
  assert.equal((await runAction(ctx, { action: "status" })).body.needs_reconnect, true);
});

test("callback: bad, expired, replayed and non-owner states are refused; a good one stores the connection", async () => {
  const g = fakeGraph();
  const db = fakeDb({ tables: { team_members: [{ id: MEMBER, role: "owner", active: true }, { id: STAFF.member_id, role: "member", active: true }] } });
  const secret = await stateSecret(ENV);
  const call = (params) => handleCallback({ db, env: ENV, params: new URLSearchParams(params), fetchImpl: g.f });
  assert.equal(await call({ code: "c", state: "junk" }), backTo("bad_state"));
  const old = await signState(MEMBER, "n-old-abcdefghijklmnop", secret, Math.floor(Date.now() / 1000) - 700);
  assert.equal(await call({ code: "c", state: old }), backTo("expired"));
  const staff = await signState(STAFF.member_id, "n-staff-abcdefghijklmnop", secret);
  assert.equal(await call({ code: "c", state: staff }), backTo("not_owner"));
  const denied = await signState(MEMBER, "n-deny-abcdefghijklmnop", secret);
  assert.equal(await call({ error: "access_denied", state: denied }), backTo("denied"));
  assert.equal(await call({ code: "c", state: await signState(MEMBER, "n-x-abcdefghijklmnop", secret) }), backTo("connected"));
  assert.equal(db.store.conn.root_id, "ROOT");
  assert.equal(db.store.conn.account_name, "Tyler W");
  assert.equal(db.store.conn.connected_by, MEMBER);
  // The same state cannot be used twice.
  const once = await signState(MEMBER, "n-once-abcdefghijklmnop", secret);
  await call({ code: "c", state: once });
  assert.equal(await call({ code: "c", state: once }), backTo("bad_state"));
  assert.equal(await handleCallback({ db, env: NO_ENV, params: new URLSearchParams({ code: "c", state: once }) }), backTo("not_configured"));
  assert.equal(backTo("connected"), "https://wise-ai.au/os/?onedrive=connected#files");
});
