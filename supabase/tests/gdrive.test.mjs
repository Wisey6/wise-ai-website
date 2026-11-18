// Unit checks for the Google Drive helpers and actions (no network: Google and the database are faked).
// Run: node --test supabase/tests/gdrive.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  signState, verifyState, secretFor, pkceVerifier, pkceChallenge, authorizeUrl, signFile, verifyFile, safeThumbUrl, thumbAt,
  apiErrorCode, tokenErrorCode, statusFor, cleanName, qv, searchQuery, shapeFile, kindOf, undoPlan, runAction, handleCallback,
  handleFile, backTo, SCOPES, FOLDER_MIME, SHARED, isInside, readText,
} from "../functions/_shared/gdrive.ts";

const SECRET = "dummy-secret-for-tests-only-0123456789abcdef";
const MEMBER = "11111111-2222-4333-8444-555555555555";
const ENV = (k) => ({ GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "csecret", SUPABASE_SERVICE_ROLE_KEY: "svc" })[k];
const NO_ENV = (k) => ({ SUPABASE_SERVICE_ROLE_KEY: "svc" })[k];

test("state: signed, bound to the member, 10 minutes, tamper-proof", async () => {
  const now = 1_800_000_000;
  const s = await signState(MEMBER, "nonce-abcdefghijklmnop", SECRET, now);
  assert.deepEqual(await verifyState(s, SECRET, now + 600), { ok: true, member: MEMBER, nonce: "nonce-abcdefghijklmnop" });
  assert.deepEqual(await verifyState(s, SECRET, now + 601), { ok: false, error: "expired" });
  assert.equal((await verifyState(s, `${SECRET}x`, now)).error, "bad_state");
  assert.equal((await verifyState(`${s}x`, SECRET, now)).error, "bad_state");
  assert.equal((await verifyState("junk", SECRET, now)).error, "bad_state");
  const a = await secretFor(ENV, "state"), b = await secretFor(ENV, "file");
  assert.notEqual(a, b, "state and file keys differ");
});

test("authorise URL: offline access, consent, PKCE, full Drive scope", async () => {
  const v = await pkceVerifier(SECRET, "n-abcdefghijklmnop");
  const { createHash } = await import("node:crypto");
  assert.equal(await pkceChallenge(v), createHash("sha256").update(v).digest("base64url"));
  const u = new URL(authorizeUrl({ clientId: "cid", redirectUri: "https://x.supabase.co/functions/v1/gdrive", state: "s", challenge: "c" }));
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("prompt"), "consent");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.ok(u.searchParams.get("scope").split(" ").includes("https://www.googleapis.com/auth/drive"));
  assert.equal(SCOPES.includes("drive.file"), false);
});

test("file proxy tokens: an hour, one file, Google thumbnail hosts only", async () => {
  const now = 1_800_000_000;
  const t = await signFile(SECRET, { i: "F1", k: "c", n: "a.pdf" }, now);
  assert.equal((await verifyFile(t, SECRET, now + 3599)).i, "F1");
  assert.equal(await verifyFile(t, SECRET, now + 3601), null);
  assert.equal(await verifyFile(t, `${SECRET}x`, now), null);
  const bad = await signFile(SECRET, { i: "F1", k: "t", u: "https://evil.example/x.png" }, now);
  assert.equal(await verifyFile(bad, SECRET, now), null, "thumbnail must be a Google host");
  assert.equal(safeThumbUrl("https://lh3.googleusercontent.com/abc=s220"), true);
  assert.equal(safeThumbUrl("http://lh3.googleusercontent.com/abc"), false);
  assert.equal(safeThumbUrl("https://googleusercontent.com.evil.io/x"), false);
  assert.equal(thumbAt("https://lh3.googleusercontent.com/abc=s220", 1200), "https://lh3.googleusercontent.com/abc=s1200");
});

test("errors: rate limits are busy (403 and 429), revoked tokens need a reconnect", () => {
  assert.equal(apiErrorCode(429, {}), "busy");
  assert.equal(apiErrorCode(403, { error: { errors: [{ reason: "userRateLimitExceeded" }] } }), "busy");
  assert.equal(apiErrorCode(403, { error: { errors: [{ reason: "rateLimitExceeded" }] } }), "busy");
  assert.equal(apiErrorCode(403, { error: { errors: [{ reason: "insufficientFilePermissions" }] } }), "forbidden");
  assert.equal(apiErrorCode(403, { error: { errors: [{ reason: "exportSizeLimitExceeded" }] } }), "too_large");
  assert.equal(apiErrorCode(404, {}), "not_found");
  assert.equal(apiErrorCode(500, {}), "busy");
  assert.equal(tokenErrorCode(400, { error: "invalid_grant" }), "reconnect_needed");
  assert.equal(tokenErrorCode(400, { error: "admin_policy_enforced" }), "reconnect_needed");
  assert.equal(tokenErrorCode(401, { error: "invalid_client" }), "not_configured");
  assert.equal(statusFor("cross_drive"), 400);
});

test("names and queries", () => {
  assert.deepEqual(cleanName("  Q3 report "), { ok: true, name: "Q3 report" });
  for (const bad of ["", " ", "a/b", ".", "..", "x".repeat(251), 3]) assert.equal(cleanName(bad).ok, false);
  assert.equal(qv("O'Brien \\ co"), "O\\'Brien \\\\ co");
  assert.equal(searchQuery("O'Brien"), "(name contains 'O\\'Brien' or fullText contains 'O\\'Brien') and trashed = false");
  assert.equal(searchQuery("  "), null);
});

test("items: Google kinds, roots, shared-with-me dropped, trashed dropped", () => {
  assert.equal(kindOf("x", "application/vnd.google-apps.document"), "gdoc");
  assert.equal(kindOf("x", "application/vnd.google-apps.spreadsheet"), "gsheet");
  assert.equal(kindOf("x", "application/vnd.google-apps.presentation"), "gslide");
  assert.equal(kindOf("x", FOLDER_MIME), "folder");
  assert.equal(kindOf("a.pdf", "application/pdf"), "pdf");
  const doc = shapeFile({ id: "D1", name: "Proposal", mimeType: "application/vnd.google-apps.document", parents: ["P"], ownedByMe: true, webViewLink: "https://docs.google.com/document/d/D1/edit", thumbnailLink: "https://lh3.googleusercontent.com/t=s220", capabilities: { canRename: true, canMoveItemWithinDrive: true } });
  assert.equal(doc.kind, "gdoc");
  assert.equal(doc.badge, "DOC");
  assert.equal(doc.size, null);
  assert.equal(doc.parent_id, "P");
  assert.equal(doc.thumb_link, "https://lh3.googleusercontent.com/t=s220");
  assert.equal(shapeFile({ id: "R", name: "x", mimeType: FOLDER_MIME }, { rootId: "R" }).name, "My Drive");
  const sd = shapeFile({ id: "0AAA", name: "Drive", mimeType: FOLDER_MIME, driveId: "0AAA" }, { driveName: "Clients" });
  assert.equal(sd.is_root && sd.name === "Clients" && sd.parent_id === SHARED, true);
  assert.equal(shapeFile({ id: "S", name: "shared", mimeType: "application/pdf", ownedByMe: false }, { strict: true }), null);
  assert.ok(shapeFile({ id: "S2", name: "in my folder", mimeType: "application/pdf", ownedByMe: false, parents: ["P"] }, { strict: true }));
  assert.equal(shapeFile({ id: "T", name: "bin", trashed: true }), null);
  assert.equal(shapeFile({ id: "W", name: "w", webViewLink: "javascript:alert(1)" }).web_url, null);
});

test("undo: conflict check; moves undo with add/remove parents; new folders are not undone", () => {
  const mv = { op: "move", item_id: "I", before: { parent_id: "A", name: "x" }, after: { parent_id: "B", name: "x" } };
  assert.deepEqual(undoPlan(mv, { parent_id: "B", name: "x" }), { ok: true, patch: { parent_id: "A", from: "B" } });
  assert.deepEqual(undoPlan(mv, { parent_id: "C", name: "x" }), { ok: false, error: "changed_since" });
  const rn = { op: "rename", item_id: "I", before: { name: "a", parent_id: "P" }, after: { name: "b", parent_id: "P" } };
  assert.deepEqual(undoPlan(rn, { parent_id: "P", name: "c" }), { ok: false, error: "changed_since" });
  assert.deepEqual(undoPlan({ op: "create_folder", item_id: "F", before: null, after: {} }, {}), { ok: false, error: "not_undoable" });
});

/* ---------------------------------------------------------------- fakes */
function fakeDb(seed = {}) {
  const tables = { team_members: [], file_links: [], file_changes: [], clients: [], projects: [], deals: [], leads: [], settings: [], ...seed.tables };
  const store = { conn: seed.conn ?? null, nonces: new Set() };
  let n = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const query = (t) => {
    const filters = [];
    let op = "select", payload = null, conflict = null;
    const apply = () => tables[t].filter((r) => filters.every((f) => f(r)));
    const b = {
      select() { return b; }, order() { return b; }, limit() { return b; },
      eq(k, v) { filters.push((r) => r[k] === v); return b; }, is(k, v) { filters.push((r) => (r[k] ?? null) === v); return b; },
      insert(row) { op = "insert"; payload = row; return b; }, upsert(row, o) { op = "upsert"; payload = row; conflict = o?.onConflict; return b; },
      update(p) { op = "update"; payload = p; return b; }, delete() { op = "delete"; return b; },
      run() {
        if (op === "insert") { const r = { id: uuid(), at: new Date().toISOString(), undone_at: null, ...payload }; tables[t].push(r); return [r]; }
        if (op === "upsert") { const keys = conflict.split(","); let r = tables[t].find((x) => keys.every((k) => x[k] === payload[k])); if (r) Object.assign(r, payload); else { r = { id: uuid(), ...payload }; tables[t].push(r); } return [r]; }
        if (op === "update") { const hit = apply(); hit.forEach((r) => Object.assign(r, payload)); return hit; }
        if (op === "delete") { const hit = apply(); tables[t] = tables[t].filter((r) => !hit.includes(r)); return hit; }
        return apply();
      },
      maybeSingle() { const r = b.run(); return Promise.resolve({ data: r[0] ?? null, error: null }); },
      single() { const r = b.run(); return Promise.resolve({ data: r[0] ?? null, error: r[0] ? null : { message: "none" } }); },
      then(res, rej) { return Promise.resolve({ data: b.run(), error: null }).then(res, rej); },
    };
    return b;
  };
  return {
    tables, store, from: query,
    rpc(name, args) {
      if (name === "gdrive_get") return Promise.resolve({ data: store.conn ? { ...store.conn } : null, error: null });
      if (name === "gdrive_save") { store.conn = { ...(store.conn || {}), ...Object.fromEntries(Object.entries(args.p).filter(([k, v]) => !(k === "refresh_token" && !v))) }; return Promise.resolve({ data: { ok: true }, error: null }); }
      if (name === "gdrive_clear") { store.conn = null; return Promise.resolve({ data: null, error: null }); }
      if (name === "onedrive_use_nonce") { const fresh = !store.nonces.has(args.p_nonce); store.nonces.add(args.p_nonce); return Promise.resolve({ data: fresh, error: null }); }
      return Promise.resolve({ data: null, error: { message: `unknown rpc ${name}` } });
    },
  };
}

/** A tiny Google Drive behind fetch: My Drive, one shared drive, a Google Doc. */
function fakeGoogle() {
  const F = FOLDER_MIME;
  const files = {
    ROOT: { id: "ROOT", name: "My Drive", mimeType: F, ownedByMe: true },
    CL: { id: "CL", name: "Clients", mimeType: F, parents: ["ROOT"], ownedByMe: true },
    AR: { id: "AR", name: "Archive", mimeType: F, parents: ["ROOT"], ownedByMe: true },
    DOC: { id: "DOC", name: "Scope of work", mimeType: "application/vnd.google-apps.document", parents: ["CL"], ownedByMe: true, webViewLink: "https://docs.google.com/document/d/DOC/edit", hasThumbnail: true, thumbnailLink: "https://lh3.googleusercontent.com/doc=s220" },
    PDF: { id: "PDF", name: "Quote.pdf", mimeType: "application/pdf", size: "1200", parents: ["CL"], ownedByMe: true },
    SWM: { id: "SWM", name: "Quote from a friend.pdf", mimeType: "application/pdf", ownedByMe: false },
    SD: { id: "0ASD", name: "Drive", mimeType: F, driveId: "0ASD" },
    SDF: { id: "SDF", name: "Team notes.pdf", mimeType: "application/pdf", parents: ["0ASD"], driveId: "0ASD" },
    SUB: { id: "SUB", name: "Smith", mimeType: F, parents: ["CL"], ownedByMe: true },
    QS: { id: "QS", name: "Quote Smith.pdf", mimeType: "application/pdf", size: "900", parents: ["SUB"], ownedByMe: true },
    SHEET: { id: "SHEET", name: "Numbers", mimeType: "application/vnd.google-apps.spreadsheet", parents: ["CL"], ownedByMe: true },
    MD: { id: "MD", name: "notes.md", mimeType: "text/markdown", size: "40", parents: ["CL"], ownedByMe: true },
  };
  const calls = [];
  let tokens = 0;
  const plan = { unauthOnce: false, limitOnce: 0, tokenError: null };
  const res = (status, body, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const f = async (url, init = {}) => {
    const u = new URL(url);
    const m0 = init.method || "GET";
    calls.push(`${m0} ${u.pathname}`);
    if (u.host === "oauth2.googleapis.com" && u.pathname === "/token") {
      tokens++;
      if (plan.tokenError) return res(400, { error: plan.tokenError });
      return res(200, { access_token: `at${tokens}`, expires_in: 3599, refresh_token: tokens === 1 ? "rt-new" : undefined, scope: "https://www.googleapis.com/auth/drive openid" });
    }
    if (u.host === "oauth2.googleapis.com" && u.pathname === "/revoke") return res(200, {});
    if (u.host === "lh3.googleusercontent.com") return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "content-type": "image/png", "content-length": "4" } });
    if (plan.unauthOnce) { plan.unauthOnce = false; return res(401, { error: { code: 401 } }); }
    if (plan.limitOnce > 0) { plan.limitOnce--; return res(403, { error: { errors: [{ reason: "userRateLimitExceeded" }] } }); }
    const p = decodeURIComponent(u.pathname.replace("/drive/v3", ""));
    let m;
    if (p === "/about") return res(200, { user: { displayName: "Tyler W", emailAddress: "owner@example.test" } });
    if (p === "/drives") return res(200, { drives: [{ id: "0ASD", name: "Clients shared" }] });
    if ((m = /^\/drives\/(.+)$/.exec(p))) return res(200, { name: "Clients shared" });
    if (p === "/files" && m0 === "GET") {
      const q = u.searchParams.get("q") || "";
      let pm;
      if ((pm = /^'([^']+)' in parents and name = '(.+)' and trashed = false$/.exec(q))) return res(200, { files: Object.values(files).filter((x) => x.parents?.[0] === pm[1] && x.name === pm[2].replace(/\\'/g, "'")) });
      const ps = [...q.matchAll(/'([^']+)' in parents/g)].map((x) => x[1]);
      const term = (/name contains '([^']+)'/.exec(q) || [])[1];
      if (ps.length) return res(200, { files: Object.values(files).filter((x) => ps.includes(x.parents?.[0]) && (!q.includes("mimeType =") || x.mimeType === F) && (!term || x.name.toLowerCase().includes(term.toLowerCase()))) });
      if (/name contains/.test(q)) return res(200, { files: Object.values(files).filter((x) => /quote/i.test(x.name)) });
    }
    if (p === "/files" && m0 === "POST") {
      const b = JSON.parse(init.body);
      const id = `N${Object.keys(files).length}`;
      files[id] = { id, name: b.name, mimeType: b.mimeType, parents: b.parents, ownedByMe: true };
      return res(200, files[id]);
    }
    if ((m = /^\/files\/([^/]+)\/export$/.exec(p))) {
      const mt = u.searchParams.get("mimeType");
      if (mt === "text/plain") return new Response("\uFEFFScope of work\r\nWe will build the thing.", { status: 200, headers: { "content-type": "text/plain" } });
      if (mt === "text/csv") return new Response("Month,Income\r\nOct,1200", { status: 200, headers: { "content-type": "text/csv" } });
      return new Response("%PDF-1.4 fake", { status: 200, headers: { "content-type": "application/pdf" } });
    }
    if ((m = /^\/files\/([^/]+)$/.exec(p))) {
      const x = files[m[1] === "root" ? "ROOT" : m[1]] || files[Object.keys(files).find((k) => files[k].id === m[1])];
      if (!x) return res(404, { error: { errors: [{ reason: "notFound" }] } });
      if (u.searchParams.get("alt") === "media" && x.mimeType === "text/markdown") return new Response("# Notes\nCall Smith on Friday.", { status: 200, headers: { "content-type": "text/markdown" } });
      if (u.searchParams.get("alt") === "media") return new Response("%PDF-1.4 fake", { status: 200, headers: { "content-type": x.mimeType } });
      if (m0 === "PATCH") {
        const b = JSON.parse(init.body || "{}");
        if (b.name) x.name = b.name;
        const add = u.searchParams.get("addParents"), rem = u.searchParams.get("removeParents");
        if (add) { assert.equal(rem, x.parents[0], "removeParents is the current parent"); x.parents = [add]; }
        if ("trashed" in b) throw new Error("never trash");
      }
      if (m0 === "DELETE") throw new Error("never delete");
      return res(200, x);
    }
    return res(404, { error: { errors: [{ reason: "notFound" }] } });
  };
  return { f, files, calls, plan, tokens: () => tokens };
}
const CONN = () => ({ refresh_token: "rt0", access_token: "at0", access_expires_at: new Date(Date.now() + 3600e3).toISOString(), root_id: "ROOT", account_name: "Tyler W", connected_by: MEMBER, connected_at: "2026-11-18T00:00:00Z", needs_reconnect: false, last_error: null });
const OWNER = { member_id: MEMBER, name: "Tyler", role: "owner" };
const STAFF = { member_id: "22222222-2222-4333-8444-555555555555", name: "Jay", role: "member" };

test("status: configured:false without keys; owner-only connect; never a token", async () => {
  const db = fakeDb({ tables: { team_members: [{ id: MEMBER, name: "Tyler", role: "owner", active: true }] } });
  const r = await runAction({ db, env: NO_ENV, member: STAFF }, { action: "status" });
  assert.equal(r.body.configured, false);
  assert.equal(r.body.provider, "gdrive");
  assert.equal(r.body.owner_name, "Tyler");
  assert.equal((await runAction({ db, env: ENV, member: STAFF }, { action: "connect_url" })).body.error, "owner_only");
  const c = await runAction({ db, env: ENV, member: OWNER }, { action: "connect_url" });
  assert.match(c.body.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  db.store.conn = CONN();
  const s = await runAction({ db, env: ENV, member: OWNER }, { action: "status" });
  assert.equal(s.body.connected, true);
  assert.doesNotMatch(JSON.stringify(s.body), /rt0|at0/);
});

test("list: My Drive with a Shared drives folder; shared drive contents; signed thumbnails", async () => {
  const g = fakeGoogle();
  const db = fakeDb({ conn: CONN() });
  const ctx = { db, env: ENV, member: STAFF, fetchImpl: g.f };
  const r = await runAction(ctx, { action: "list", with_path: true });
  assert.deepEqual(r.body.items.map((i) => i.name), ["Archive", "Clients", "Shared drives"]);
  assert.deepEqual(r.body.path, [{ id: "ROOT", name: "My Drive" }]);
  const sh = await runAction(ctx, { action: "list", item_id: SHARED });
  assert.deepEqual(sh.body.items.map((i) => `${i.id}:${i.name}`), ["0ASD:Clients shared"]);
  const sd = await runAction(ctx, { action: "list", item_id: "0ASD", with_path: true });
  assert.deepEqual(sd.body.items.map((i) => i.name), ["Team notes.pdf"]);
  assert.deepEqual(sd.body.path.map((p) => p.name), ["Shared drives", "Clients shared"]);
  const cl = await runAction(ctx, { action: "list", item_id: "CL" });
  const doc = cl.body.items.find((i) => i.id === "DOC");
  assert.match(doc.thumb.large, /\/functions\/v1\/gdrive\?f=/);
  assert.doesNotMatch(JSON.stringify(cl.body), /lh3\.googleusercontent/, "the raw thumbnail link never leaves the server");
});

test("item: a Google Doc previews as PDF through the proxy; shared-with-me is refused", async () => {
  const g = fakeGoogle();
  const db = fakeDb({ conn: CONN() });
  const ctx = { db, env: ENV, member: STAFF, fetchImpl: g.f };
  const it = await runAction(ctx, { action: "item", id: "DOC", with_path: true });
  assert.equal(it.body.item.kind, "gdoc");
  assert.equal(it.body.download_url, null);
  assert.match(it.body.preview_url, /\?f=/);
  assert.deepEqual(it.body.path.map((p) => p.name), ["My Drive", "Clients"]);
  const token = new URL(it.body.preview_url).searchParams.get("f");
  const file = await handleFile({ db, env: ENV, token, fetchImpl: g.f });
  assert.equal(file.status, 200);
  assert.equal(file.headers["content-type"], "application/pdf");
  assert.match(file.headers["content-disposition"], /^inline; filename\*=UTF-8''Scope%20of%20work\.pdf/);
  assert.ok(g.calls.some((c) => c === "GET /drive/v3/files/DOC/export"));
  const thumb = await handleFile({ db, env: ENV, token: new URL(it.body.item.thumb.large).searchParams.get("f"), fetchImpl: g.f });
  assert.equal(thumb.headers["content-type"], "image/png");
  assert.equal((await handleFile({ db, env: ENV, token: "junk", fetchImpl: g.f })).status, 403);
  assert.equal((await runAction(ctx, { action: "item", id: "SWM" })).body.error, "outside_drive");
});

test("move, rename, undo, new folder, cross-drive refused, nothing deleted or trashed", async () => {
  const g = fakeGoogle();
  const db = fakeDb({ conn: CONN() });
  const ctx = { db, env: ENV, member: STAFF, fetchImpl: g.f };
  const mv = await runAction(ctx, { action: "move", id: "PDF", parent_id: "AR" });
  assert.equal(mv.body.ok, true);
  assert.deepEqual(g.files.PDF.parents, ["AR"]);
  assert.equal(mv.body.change.summary, "Moved Quote.pdf from Clients to Archive");
  assert.equal(mv.body.change.provider, "gdrive");
  assert.equal((await runAction(ctx, { action: "undo", change_id: mv.body.change.id })).body.ok, true);
  assert.deepEqual(g.files.PDF.parents, ["CL"]);
  assert.equal((await runAction(ctx, { action: "move", id: "PDF", parent_id: "0ASD" })).body.error, "cross_drive");
  assert.equal((await runAction(ctx, { action: "move", id: "PDF", parent_id: SHARED })).body.error, "cross_drive");
  const rn = await runAction(ctx, { action: "rename", id: "PDF", name: "Quote v2.pdf" });
  assert.equal(g.files.PDF.name, "Quote v2.pdf");
  g.files.PDF.name = "Quote final.pdf";
  assert.equal((await runAction(ctx, { action: "undo", change_id: rn.body.change.id })).body.error, "changed_since");
  assert.equal((await runAction(ctx, { action: "rename", id: "PDF", name: "Scope of work" })).body.error, "name_taken");
  const nf = await runAction(ctx, { action: "create_folder", parent_id: "CL", name: "Smith Plumbing" });
  assert.equal(nf.body.ok, true);
  assert.equal(g.files[nf.body.item.id].mimeType, FOLDER_MIME);
  assert.equal((await runAction(ctx, { action: "create_folder", parent_id: "CL", name: "Smith Plumbing" })).body.error, "name_taken");
  assert.equal((await runAction(ctx, { action: "undo", change_id: nf.body.change.id })).body.error, "not_undoable");
  assert.equal(g.calls.some((c) => c.startsWith("DELETE")), false);
});

test("tokens: cached; refresh once on 401; 403 rate limit waits once then busy; revoked → reconnect", async () => {
  const g = fakeGoogle();
  const db = fakeDb({ conn: CONN() });
  const ctx = { db, env: ENV, member: STAFF, fetchImpl: g.f };
  await runAction(ctx, { action: "list" });
  assert.equal(g.tokens(), 0);
  g.plan.unauthOnce = true;
  assert.equal((await runAction(ctx, { action: "list", item_id: "CL" })).body.ok, true);
  assert.equal(g.tokens(), 1);
  assert.equal(db.store.conn.refresh_token, "rt-new");
  g.plan.limitOnce = 1;
  assert.equal((await runAction(ctx, { action: "list", item_id: "AR" })).body.ok, true, "one rate limit is waited out");
  g.plan.limitOnce = 5;
  const busy = await runAction(ctx, { action: "list", item_id: "AR" });
  assert.equal(busy.body.error, "busy");
  assert.equal(busy.status, 503);
  g.plan.limitOnce = 0;
  db.store.conn = { ...CONN(), access_expires_at: new Date(Date.now() - 1000).toISOString() };
  g.plan.tokenError = "invalid_grant";
  assert.equal((await runAction(ctx, { action: "list" })).body.error, "reconnect_needed");
  assert.equal(db.store.conn.needs_reconnect, true);
});

test("links carry the provider; unlink leaves the file", async () => {
  const g = fakeGoogle();
  const CL = "44444444-2222-4333-8444-555555555555";
  const db = fakeDb({ conn: CONN(), tables: { clients: [{ id: CL }] } });
  const ctx = { db, env: ENV, member: STAFF, fetchImpl: g.f };
  const l = await runAction(ctx, { action: "link", item_id: "DOC", kind: "client", record_id: CL });
  assert.equal(l.body.link.provider, "gdrive");
  assert.equal(l.body.link.web_url, "https://docs.google.com/document/d/DOC/edit");
  await runAction(ctx, { action: "unlink", link_id: l.body.link.id });
  assert.equal(db.tables.file_links.length, 0);
  assert.ok(g.files.DOC);
});

test("callback: bad/expired/replayed/non-owner refused; good one stores account and root; disconnect revokes", async () => {
  const g = fakeGoogle();
  const db = fakeDb({ tables: { team_members: [{ id: MEMBER, role: "owner", active: true }, { id: STAFF.member_id, role: "member", active: true }] } });
  const secret = await secretFor(ENV, "state");
  const call = (p) => handleCallback({ db, env: ENV, params: new URLSearchParams(p), fetchImpl: g.f });
  assert.equal(await call({ code: "c", state: "junk" }), backTo("bad_state"));
  assert.equal(await call({ code: "c", state: await signState(MEMBER, "n-old-abcdefghijklmnop", secret, Math.floor(Date.now() / 1000) - 700) }), backTo("expired"));
  assert.equal(await call({ code: "c", state: await signState(STAFF.member_id, "n-staff-abcdefghijkl", secret) }), backTo("not_owner"));
  assert.equal(await call({ error: "access_denied", state: await signState(MEMBER, "n-deny-abcdefghijklm", secret) }), backTo("denied"));
  assert.equal(await call({ error: "org_internal", state: await signState(MEMBER, "n-org-abcdefghijklmn", secret) }), backTo("not_in_org"));
  const good = await signState(MEMBER, "n-good-abcdefghijklm", secret);
  assert.equal(await call({ code: "c", state: good }), backTo("connected"));
  assert.equal(db.store.conn.root_id, "ROOT");
  assert.equal(db.store.conn.account_name, "Tyler W");
  assert.equal(await call({ code: "c", state: good }), backTo("bad_state"), "a state works once");
  assert.equal(await handleCallback({ db, env: NO_ENV, params: new URLSearchParams({ code: "c", state: "junk" }) }), backTo("bad_state"));
  assert.equal(backTo("connected"), "https://wise-ai.au/os/?drive=connected#files");
  await runAction({ db, env: ENV, member: OWNER, fetchImpl: g.f }, { action: "disconnect" });
  assert.equal(db.store.conn, null);
  assert.ok(g.calls.includes("POST /revoke"));
});

test("business folder: isInside uses the folder tree; search within keeps only what is inside; status reports home", async () => {
  const g = fakeGoogle();
  const db = fakeDb({ conn: CONN(), tables: { settings: [{ id: 1, files_home_id: "CL", files_home_name: "Clients" }] } });
  const ctx = { db, env: ENV, member: STAFF, fetchImpl: g.f };
  assert.equal(await isInside(ctx, "QS", "CL"), true);
  assert.equal(await isInside(ctx, "CL", "CL"), true);
  assert.equal(await isInside(ctx, "AR", "CL"), false);
  const all = await runAction(ctx, { action: "search", q: "quote" });
  assert.ok(all.body.items.length >= 2);
  const inside = await runAction(ctx, { action: "search", q: "quote", within: "CL" });
  assert.deepEqual(inside.body.items.map((i) => i.id).sort(), ["PDF", "QS"]);
  assert.equal(inside.body.within, "CL");
  const st = await runAction(ctx, { action: "status" });
  assert.deepEqual(st.body.home, { id: "CL", name: "Clients" });
});

test("readText: Docs as text, Sheets as CSV, Markdown as is; PDFs unsupported; capped", async () => {
  const g = fakeGoogle();
  const db = fakeDb({ conn: CONN() });
  const ctx = { db, env: ENV, member: STAFF, fetchImpl: g.f };
  const doc = await readText(ctx, "DOC");
  assert.equal(doc.ok, true);
  assert.equal(doc.text, "Scope of work\nWe will build the thing.");
  assert.equal(doc.item.kind, "gdoc");
  const sheet = await readText(ctx, "SHEET");
  assert.equal(sheet.format, "csv (first sheet)");
  assert.equal(sheet.text, "Month,Income\nOct,1200");
  const md = await readText(ctx, "MD", 300);
  assert.equal(md.text, "# Notes\nCall Smith on Friday.");
  const cut = await readText(ctx, "DOC", 10);
  assert.equal(cut.truncated, false, "short texts are not cut below 200 characters");
  const pdf = await readText(ctx, "PDF");
  assert.deepEqual([pdf.ok, pdf.error, pdf.unsupported], [false, "unsupported", "pdf"]);
  assert.equal((await readText(ctx, "SWM")).error, "outside_drive");
  const act = await runAction(ctx, { action: "read_text", id: "PDF" });
  assert.equal(act.status, 415);
  assert.match(act.body.message, /PDF/);
});
