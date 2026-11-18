// Unit checks for the email parts: the Gmail search string, body text, caps, draft checks, MIME,
// error mapping, the sign-in state routing and the hub's send/discard gate. No network: Google
// and the database are faked. Run: node --test supabase/tests/mail.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as G from "../functions/_shared/gdrive.ts";
import {
  SCOPES, SCOPE_READ, SCOPE_COMPOSE, SCOPE_CALENDAR, googleErrorCode, parseAddress, parseAddressList, blockedRecipients, runMailAction,
  routeCallback, handleMailCallback, backToMail, gmailDraftUrl, mailAuthorizeUrl, MAIL_ACTIONS, DAILY_SENDS,
} from "../functions/_shared/gmail.ts";
import {
  quoteTerm, buildGmailQuery, searchLimit, extractBody, htmlToText, decodeEntities, compactMessage, readableMessage, perMessageCap, capText,
  checkDraft, replySubject, buildMime, b64urlString, encodeHeader, b64urlToBytes, READ_MAX,
} from "../functions/agent/mail-rules.ts";
import { MAIL_TOOL_DEFS, MAIL_TOOL_NAMES } from "../functions/agent/mail.ts";
import { taintCheck, taints, MAIL_READ_TOOLS } from "../functions/agent/chat-rules.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ME = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
const ENV = (k) => ({ GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "csecret", SUPABASE_SERVICE_ROLE_KEY: "svc" })[k];
const b64u = (s, charset) => Buffer.from(s, charset === "latin1" ? "latin1" : "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/* ---------------------------------------------------------------- search */
test("search: structured fields only, every value quoted, no operator injection", () => {
  assert.equal(buildGmailQuery({}), "");
  assert.equal(buildGmailQuery({ from: "dentist", newer_than_days: 7, unread: true }), 'from:"dentist" newer_than:7d is:unread');
  assert.equal(buildGmailQuery({ query: "quote kitchen", subject: "Re: price", has_attachment: true }), '"quote" "kitchen" subject:"Re: price" has:attachment');
  // Attempts to add operators stay inside quotes.
  const q = buildGmailQuery({ from: 'x" OR in:trash {label:secret} (', query: 'in:spam -label:x "a" OR b' });
  assert.equal(q, '"in:spam" "-label:x" "a" "OR" "b" from:"x OR in:trash label:secret"');
  assert.ok(!/[{}()]/.test(q));
  assert.equal(quoteTerm("  "), null);
  assert.throws(() => buildGmailQuery({ newer_than_days: 0 }));
  assert.throws(() => buildGmailQuery({ newer_than_days: "7d; in:trash" }));
  assert.equal(searchLimit(undefined), 10);
  assert.equal(searchLimit(500), 25);
  assert.equal(searchLimit(0), 1);
});

/* ---------------------------------------------------------------- bodies */
test("bodies: multipart prefers text/plain, base64url decoded, charset honoured, attachments named only", () => {
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "multipart/alternative", parts: [
        { mimeType: "text/plain", headers: [{ name: "Content-Type", value: 'text/plain; charset="UTF-8"' }], body: { data: b64u("Hi Tyler,\r\nThursday works — see you then.\r\n") } },
        { mimeType: "text/html", body: { data: b64u("<p>Hi Tyler</p>") } },
      ] },
      { mimeType: "application/pdf", filename: "Quote.pdf", body: { attachmentId: "ATT1", size: 204800 } },
    ],
  };
  const b = extractBody(payload);
  assert.equal(b.format, "plain");
  assert.equal(b.text, "Hi Tyler,\nThursday works — see you then.");
  assert.deepEqual(b.attachments, [{ name: "Quote.pdf", size: 204800, type: "application/pdf" }]);
  const latin = extractBody({ mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=ISO-8859-1" }], body: { data: b64u("Café", "latin1") } });
  assert.equal(latin.text, "Café");
  const html = extractBody({ mimeType: "text/html", body: { data: b64u('<html><head><style>p{}</style></head><body><script>alert(1)</script><p>Hello&nbsp;there &amp; welcome</p><ul><li>One</li><li>Two</li></ul><a href="https://x.test/a">Book</a></body></html>') } });
  assert.equal(html.format, "html");
  assert.equal(html.text, "Hello there & welcome\n\n- One\n- Two\nBook (https://x.test/a)");
  assert.ok(!/alert|style/.test(html.text));
  assert.equal(extractBody(null).format, "none");
  assert.equal(decodeEntities("&#39;hi&#x27; &lt;b&gt;"), "'hi' <b>");
  assert.deepEqual([...b64urlToBytes(b64u("ÿ?>"))], [...Buffer.from("ÿ?>")]);
  assert.equal(htmlToText("<div>a</div><div>b</div>"), "a\n\nb");
});

test("rows and caps: snippet ≤160, unread, local date source, body capped at 12,000, thread shares", () => {
  const msg = { id: "18c1a2b3c4d5", threadId: "18c1a2b3c4d0", labelIds: ["UNREAD", "INBOX"], internalDate: "1763444400000", snippet: "x".repeat(300) + " &amp;",
    payload: { mimeType: "multipart/mixed", headers: [{ name: "From", value: '"Sam Lee" <Sam@Example.com.au>' }, { name: "Subject", value: "Quote" }] } };
  const r = compactMessage(msg);
  assert.equal(r.from_name, "Sam Lee");
  assert.equal(r.from_address, "sam@example.com.au");
  assert.equal(r.unread, true);
  assert.equal(r.has_attachments, true);
  assert.equal(r.snippet.length, 160);
  assert.equal(r.date, new Date(1763444400000).toISOString());
  const big = readableMessage({ id: "a1b2c3d4e5", payload: { mimeType: "text/plain", body: { data: b64u("y".repeat(20000)) } } });
  assert.equal(big.truncated, true);
  assert.equal(big.body.length, READ_MAX + 1);
  assert.equal(perMessageCap(2), 8000);
  assert.equal(perMessageCap(40), 1500);
  assert.deepEqual(capText("abc", 5), { text: "abc", truncated: false, chars: 3 });
});

/* ---------------------------------------------------------------- drafts + MIME */
test("draft checks: real addresses, ≤10 recipients, subject ≤200, body ≤8,000, no attachments", () => {
  const ok = checkDraft({ to: ["Sam Lee <sam@example.com.au>", "sam@example.com.au"], cc: ["jo@example.com"], subject: "Thursday", body: "Hi Sam" });
  assert.deepEqual(ok.to, [{ name: "Sam Lee", address: "sam@example.com.au" }]);
  assert.equal(ok.cc.length, 1);
  assert.throws(() => checkDraft({ to: ["not an address"], subject: "a", body: "b" }), /not an email address/);
  assert.throws(() => checkDraft({ to: ["a@b.co\r\nBcc: evil@x.com"], subject: "a", body: "b" }));
  assert.throws(() => checkDraft({ to: Array.from({ length: 11 }, (_, i) => `p${i}@x.com`), subject: "a", body: "b" }), /at most 10/);
  assert.throws(() => checkDraft({ to: ["a@b.com"], subject: "s".repeat(201), body: "b" }), /200/);
  assert.throws(() => checkDraft({ to: ["a@b.com"], subject: "s", body: "b".repeat(8001) }), /8,000/);
  assert.throws(() => checkDraft({ to: ["a@b.com"], subject: "s", body: "b", attachments: ["x.pdf"] }), /Attachments/);
  assert.throws(() => checkDraft({ subject: "s", body: "b" }), /who is it to/);
  assert.equal(checkDraft({ body: "Thanks" }, { reply: true }).to.length, 0);
  assert.equal(replySubject("Quote for the kitchen"), "Re: Quote for the kitchen");
  assert.equal(replySubject("RE: Quote"), "RE: Quote");
  assert.equal(checkDraft({ to: ["a@b.com"], subject: "Hi\r\nBcc: x@y.com", body: "b" }).subject, "Hi Bcc: x@y.com");
});

test("MIME: headers, UTF-8 subject, threading headers, base64 bodies, base64url raw", () => {
  const raw = buildMime({
    to: [{ name: "Sam Lee", address: "sam@example.com.au" }], cc: [{ name: null, address: "jo@example.com" }],
    subject: "Re: Café quote – Thursday", body: "Hi Sam,\n\nThursday at 10 suits.\n\nTyler\nWise AI",
    inReplyTo: "<CAB123@mail.gmail.com>", references: "<CAA000@mail.gmail.com> junk", boundary: "BOUND",
  });
  const head = raw.split("\r\n\r\n")[0];
  assert.match(head, /^To: "Sam Lee" <sam@example\.com\.au>\r\nCc: jo@example\.com\r\nSubject: =\?UTF-8\?B\?/);
  assert.match(head, /In-Reply-To: <CAB123@mail\.gmail\.com>\r\nReferences: <CAA000@mail\.gmail\.com> <CAB123@mail\.gmail\.com>/);
  assert.match(head, /Content-Type: multipart\/alternative; boundary="BOUND"/);
  // The encoded subject decodes back exactly.
  const words = [...head.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map((m) => Buffer.from(m[1], "base64").toString("utf8")).join("");
  assert.equal(words, "Re: Café quote – Thursday");
  const plain = raw.split('Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1].split("\r\n--BOUND")[0];
  assert.equal(Buffer.from(plain.replace(/\r\n/g, ""), "base64").toString("utf8"), "Hi Sam,\n\nThursday at 10 suits.\n\nTyler\nWise AI");
  const html = raw.split('Content-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1].split("\r\n--BOUND")[0];
  assert.equal(Buffer.from(html.replace(/\r\n/g, ""), "base64").toString("utf8"), '<div dir="ltr">Hi Sam,<br><br>Thursday at 10 suits.<br><br>Tyler<br>Wise AI</div>');
  assert.ok(raw.trimEnd().endsWith("--BOUND--"));
  // No threading headers for a new email, and a bad Message-ID is ignored.
  assert.ok(!/In-Reply-To/.test(buildMime({ to: [{ name: null, address: "a@b.com" }], cc: [], subject: "x", body: "y", inReplyTo: "not-an-id\r\nBcc: x@y.com" })));
  const enc = b64urlString(raw);
  assert.ok(!/[+/=]/.test(enc));
  assert.equal(Buffer.from(enc.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"), raw);
  assert.equal(encodeHeader("Plain"), "Plain");
});

test("addresses: parsing headers with quoted commas, strict address shape", () => {
  assert.deepEqual(parseAddressList('"Lee, Sam" <sam@x.com>, jo@y.com.au; Bad <nope>'), [{ name: "Lee, Sam", address: "sam@x.com" }, { name: null, address: "jo@y.com.au" }]);
  assert.equal(parseAddress("a b@c.com"), null);
  assert.equal(parseAddress("mailto:A@B.com")?.address, "a@b.com");
  assert.deepEqual(parseAddressList(""), []);
});

/* ---------------------------------------------------------------- errors */
test("errors: a switched-off API, rate limits, missing permission", () => {
  const off = { error: { code: 403, status: "PERMISSION_DENIED", errors: [{ reason: "accessNotConfigured" }], details: [{ reason: "SERVICE_DISABLED" }] } };
  assert.equal(googleErrorCode(403, off), "mail_api_off");
  assert.equal(googleErrorCode(403, off, "calendar"), "calendar_api_off");
  assert.equal(googleErrorCode(403, { error: { details: [{ reason: "SERVICE_DISABLED" }] } }), "mail_api_off");
  assert.equal(googleErrorCode(429, {}), "busy");
  assert.equal(googleErrorCode(403, { error: { errors: [{ reason: "userRateLimitExceeded" }] } }), "busy");
  assert.equal(googleErrorCode(403, { error: { errors: [{ reason: "insufficientPermissions" }] } }), "scope_missing");
  assert.equal(googleErrorCode(404, {}), "not_found");
  assert.equal(googleErrorCode(401, {}), "unauthorized");
  assert.equal(googleErrorCode(502, {}), "busy");
});

/* ---------------------------------------------------------------- fakes */
function fakeDb(seed = {}) {
  const tables = { team_members: [{ id: ME, active: true, role: "owner" }, { id: OTHER, active: true, role: "member" }], leads: [], suppressions: [], mail_drafts: [], settings: [{ id: 1, timezone: "Australia/Brisbane" }], ...seed.tables };
  const store = { conns: { ...(seed.conns || {}) }, nonces: new Set(), drive: seed.drive ?? null };
  let n = 0;
  const query = (t) => {
    const filters = [];
    let op = "select", payload = null;
    const apply = () => tables[t].filter((r) => filters.every((f) => f(r)));
    const b = {
      select() { return b; }, order() { return b; }, limit() { return b; },
      eq(k, v) { filters.push((r) => r[k] === v); return b; },
      in(k, vs) { filters.push((r) => vs.includes(r[k])); return b; },
      gte(k, v) { filters.push((r) => r[k] !== null && r[k] !== undefined && String(r[k]) >= String(v)); return b; },
      or(expr) {
        const pats = expr.split(",").map((x) => x.replace(/^email\.ilike\./, "").replace(/\\(.)/g, "$1").toLowerCase());
        filters.push((r) => pats.includes(String(r.email ?? "").toLowerCase()));
        return b;
      },
      insert(row) { op = "insert"; payload = row; return b; }, update(p) { op = "update"; payload = p; return b; },
      run() {
        if (op === "insert") { const r = { id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, created_at: new Date().toISOString(), status: "draft", ...payload }; tables[t].push(r); return [r]; }
        if (op === "update") { const hit = apply(); hit.forEach((r) => Object.assign(r, payload)); return hit; }
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
    rpc(name, a) {
      const R = (data) => Promise.resolve({ data, error: null });
      if (name === "gmail_get") return R(store.conns[a.p_member] ? { ...store.conns[a.p_member] } : null);
      if (name === "gmail_save") { store.conns[a.p_member] = { member_id: a.p_member, ...(store.conns[a.p_member] || {}), ...Object.fromEntries(Object.entries(a.p).filter(([k, v]) => !(k === "refresh_token" && !v))) }; return R({ ok: true }); }
      if (name === "gmail_clear") { delete store.conns[a.p_member]; return R(null); }
      if (name === "gmail_email_in_use") return R(Object.values(store.conns).some((c) => c.email?.toLowerCase() === a.p_email.toLowerCase() && c.member_id !== a.p_except));
      if (name === "gdrive_get") return R(store.drive);
      if (name === "onedrive_use_nonce") { const fresh = !store.nonces.has(a.p_nonce); store.nonces.add(a.p_nonce); return R(fresh); }
      return Promise.resolve({ data: null, error: { message: `unknown rpc ${name}` } });
    },
  };
}
const conn = (over = {}) => ({ member_id: ME, email: "owner@example.com", refresh_token: "rt", access_token: "at", access_expires_at: new Date(Date.now() + 3600e3).toISOString(), scope: `${SCOPE_READ} ${SCOPE_COMPOSE} ${SCOPE_CALENDAR}`, connected_at: new Date().toISOString(), needs_reconnect: false, ...over });

/** Gmail drafts behind fetch. */
function fakeGmail({ drafts = {}, profile = { emailAddress: "Owner@Example.com" }, profileStatus = 200, tokenScope = SCOPES } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(`${init.method || "GET"} ${u.pathname}`);
    const J = (s, b) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
    if (u.hostname === "oauth2.googleapis.com" && u.pathname === "/token") return J(200, { access_token: "new-at", refresh_token: "new-rt", expires_in: 3599, scope: tokenScope });
    if (u.hostname === "oauth2.googleapis.com" && u.pathname === "/revoke") return J(200, {});
    if (u.pathname.endsWith("/profile")) return J(profileStatus, profileStatus === 200 ? profile : { error: { code: 403, errors: [{ reason: "accessNotConfigured" }], details: [{ reason: "SERVICE_DISABLED" }] } });
    const m = /\/drafts\/([^/?]+)$/.exec(u.pathname);
    if (u.pathname.endsWith("/drafts/send")) {
      const id = JSON.parse(init.body).id;
      if (!drafts[id]) return J(404, { error: { code: 404 } });
      delete drafts[id];
      return J(200, { id: "SENT1", threadId: "T1", labelIds: ["SENT"] });
    }
    if (m && (init.method || "GET") === "GET") {
      const d = drafts[m[1]];
      return d ? J(200, { id: m[1], message: { id: "M1", payload: { headers: d } } }) : J(404, { error: { code: 404 } });
    }
    if (m && init.method === "DELETE") { if (!drafts[m[1]]) return J(404, {}); delete drafts[m[1]]; return new Response(null, { status: 204 }); }
    return J(400, { error: { message: "unexpected" } });
  };
  return { f, calls, drafts };
}
const MEMBER = { member_id: ME, name: "Tyler", role: "owner" };

/* ---------------------------------------------------------------- state routing + callback */
test("sign-in state: purpose is signed; Gmail and Drive callbacks never accept each other's state", async () => {
  const secret = await G.secretFor(ENV, "state");
  const gm = await G.signPurposeState(ME, "nonce-gmail-abcdefghij", secret, "gmail");
  const dr = await G.signState(ME, "nonce-drive-abcdefghij", secret);
  assert.equal(await G.statePurpose(gm, secret), "gmail");
  assert.equal(await G.statePurpose(dr, secret), "drive");
  const [p, sig] = gm.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), p: undefined })).toString("base64url");
  assert.equal(await G.statePurpose(`${forged}.${sig}`, secret), null);
  // Verification still checks expiry and member for a purpose state.
  assert.deepEqual(await G.verifyState(gm, secret), { ok: true, member: ME, nonce: "nonce-gmail-abcdefghij" });
  const db = fakeDb();
  assert.equal(await G.handleCallback({ db, env: ENV, params: new URLSearchParams({ code: "c", state: gm }) }), G.backTo("bad_state"));
  assert.equal(await handleMailCallback({ db, env: ENV, params: new URLSearchParams({ code: "c", state: dr }) }), backToMail("bad_state"));
  // routeCallback: a Gmail state goes to the mail sign-in (denied → ?mail=denied#settings), a Drive one to Drive.
  const deny = await G.signPurposeState(ME, "nonce-deny-abcdefghijk", secret, "gmail");
  assert.equal(await routeCallback({ db, env: ENV, params: new URLSearchParams({ error: "access_denied", state: deny }) }), "https://wise-ai.au/os/?mail=denied#settings");
  assert.match(await routeCallback({ db, env: ENV, params: new URLSearchParams({ code: "c", state: "junk" }) }), /\?drive=bad_state#files$/);
  const old = await G.signPurposeState(ME, "nonce-old-abcdefghijkl", secret, "gmail", Math.floor(Date.now() / 1000) - 700);
  assert.equal(await routeCallback({ db, env: ENV, params: new URLSearchParams({ code: "c", state: old }) }), backToMail("expired"));
});

test("sign-in callback: saves the caller's own connection; API off, missing scope, account in use", async () => {
  const secret = await G.secretFor(ENV, "state");
  const st = (nonce, who = ME) => G.signPurposeState(who, nonce, secret, "gmail");
  let db = fakeDb();
  let g = fakeGmail();
  assert.equal(await handleMailCallback({ db, env: ENV, params: new URLSearchParams({ code: "c", state: await st("n-ok-abcdefghijklmn") }), fetchImpl: g.f }), backToMail("connected"));
  assert.equal(db.store.conns[ME].email, "owner@example.com");
  assert.equal(db.store.conns[ME].refresh_token, "new-rt");
  // The same state cannot be used twice.
  assert.equal(await handleMailCallback({ db, env: ENV, params: new URLSearchParams({ code: "c", state: await st("n-ok-abcdefghijklmn") }), fetchImpl: g.f }), backToMail("bad_state"));
  // Another member cannot connect the same Google account.
  assert.equal(await handleMailCallback({ db, env: ENV, params: new URLSearchParams({ code: "c", state: await st("n-other-abcdefghijk", OTHER) }), fetchImpl: g.f }), backToMail("in_use"));
  db = fakeDb();
  g = fakeGmail({ profileStatus: 403 });
  assert.equal(await handleMailCallback({ db, env: ENV, params: new URLSearchParams({ code: "c", state: await st("n-off-abcdefghijklm") }), fetchImpl: g.f }), backToMail("api_off"));
  assert.equal(db.store.conns[ME], undefined);
  g = fakeGmail({ tokenScope: "openid email" });
  assert.equal(await handleMailCallback({ db, env: ENV, params: new URLSearchParams({ code: "c", state: await st("n-scope-abcdefghijk") }), fetchImpl: g.f }), backToMail("scope_missing"));
  g = fakeGmail({ tokenScope: `${SCOPE_READ} openid email` });
  assert.equal(await handleMailCallback({ db, env: ENV, params: new URLSearchParams({ code: "c", state: await st("n-ro-abcdefghijklmn") }), fetchImpl: g.f }), backToMail("connected_read_only"));
});

/* ---------------------------------------------------------------- hub actions */
test("status and connect URL: own connection only; scopes; shared redirect URI; no Drive scope carried over", async () => {
  const db = fakeDb({ conns: { [OTHER]: conn({ member_id: OTHER, email: "staff@example.com" }) } });
  const s = await runMailAction({ db, env: ENV, member: MEMBER }, { action: "mail_status" });
  assert.deepEqual([s.status, s.body.connected, s.body.email], [200, false, null]);
  const c = await runMailAction({ db, env: ENV, member: MEMBER }, { action: "mail_connect_url" });
  const u = new URL(c.body.url);
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(u.searchParams.get("redirect_uri"), "https://adfgtlhryyyrqbbgbfmx.supabase.co/functions/v1/gdrive");
  const scopes = u.searchParams.get("scope").split(" ");
  for (const sc of [SCOPE_READ, SCOPE_COMPOSE, SCOPE_CALENDAR]) assert.ok(scopes.includes(sc), sc);
  assert.ok(!scopes.some((x) => /\/auth\/drive|gmail\.modify|mail\.google\.com|gmail\.send$/.test(x)));
  assert.equal(u.searchParams.get("include_granted_scopes"), null);
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(await G.statePurpose(u.searchParams.get("state"), await G.secretFor(ENV, "state")), "gmail");
  assert.ok(MAIL_ACTIONS.includes("mail_send"));
  assert.equal(mailAuthorizeUrl({ clientId: "c", redirectUri: "r", state: "s", challenge: "x", hint: "bad\r\nhint" }).includes("login_hint"), false);
});

test("disconnect: forgets the caller's own mailbox; revokes at Google unless it is the Drive account", async () => {
  let db = fakeDb({ conns: { [ME]: conn() } });
  let g = fakeGmail();
  let r = await runMailAction({ db, env: ENV, member: MEMBER, fetchImpl: g.f }, { action: "mail_disconnect" });
  assert.equal(r.body.revoked_at_google, true);
  assert.ok(g.calls.includes("POST /revoke"));
  assert.equal(db.store.conns[ME], undefined);
  db = fakeDb({ conns: { [ME]: conn() }, drive: { account_email: "OWNER@example.com" } });
  g = fakeGmail();
  r = await runMailAction({ db, env: ENV, member: MEMBER, fetchImpl: g.f }, { action: "mail_disconnect" });
  assert.equal(r.body.revoked_at_google, false);
  assert.ok(!g.calls.includes("POST /revoke"));
});

const row = (over = {}) => ({ id: "aaaaaaaa-0000-4000-8000-000000000001", member_id: ME, chat_id: null, gmail_draft_id: "r-123", gmail_draft_message_id: "abc123def", is_reply: false, to_addrs: ["sam@example.com.au"], cc_addrs: [], subject: "Thursday", status: "draft", created_at: new Date().toISOString(), sent_at: null, ...over });
const H = (to = "Sam <sam@example.com.au>", extra = []) => [{ name: "To", value: to }, { name: "Subject", value: "Thursday" }, ...extra];

test("send gate: only the caller's own assistant-made draft, recipients re-checked, once, 30 a day", async () => {
  const D = row();
  // Someone else's draft, or an unknown id: not found, nothing sent.
  let db = fakeDb({ tables: { mail_drafts: [{ ...D, member_id: OTHER }] }, conns: { [ME]: conn() } });
  let g = fakeGmail({ drafts: { "r-123": H() } });
  let r = await runMailAction({ db, env: ENV, member: MEMBER, fetchImpl: g.f }, { action: "mail_send", draft_id: D.id });
  assert.deepEqual([r.status, r.body.error], [404, "not_found"]);
  r = await runMailAction({ db, env: ENV, member: MEMBER, fetchImpl: g.f }, { action: "mail_send", draft_id: "not-a-uuid" });
  assert.equal(r.body.error, "bad_request");
  assert.ok(!g.calls.some((c) => c.includes("/send")));
  // Own draft: sent once; a second press is refused.
  db = fakeDb({ tables: { mail_drafts: [{ ...D }] }, conns: { [ME]: conn() } });
  g = fakeGmail({ drafts: { "r-123": H() } });
  r = await runMailAction({ db, env: ENV, member: MEMBER, fetchImpl: g.f }, { action: "mail_send", draft_id: D.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.draft.status, "sent");
  assert.deepEqual(r.body.draft.to, ["sam@example.com.au"]);
  assert.ok(r.body.draft.sent_at);
  assert.equal(db.tables.mail_drafts[0].gmail_message_id, "SENT1");
  r = await runMailAction({ db, env: ENV, member: MEMBER, fetchImpl: g.f }, { action: "mail_send", draft_id: D.id });
  assert.equal(r.body.error, "already_sent");
  assert.equal(g.calls.filter((c) => c.endsWith("/drafts/send")).length, 1);
  // A recipient added in Gmail who opted out (lead dnc, or the lead's number suppressed): not sent.
  db = fakeDb({ tables: { mail_drafts: [{ ...D }], leads: [{ id: "L1", email: "Bob@x.com", status: "dnc", phone: null }, { id: "L2", email: "amy@y.com", status: "new", phone: "+61400000000" }], suppressions: [{ phone: "+61400000000" }] }, conns: { [ME]: conn() } });
  g = fakeGmail({ drafts: { "r-123": H("Sam <sam@example.com.au>, bob@x.com", [{ name: "Bcc", value: "amy@y.com" }]) } });
  r = await runMailAction({ db, env: ENV, member: MEMBER, fetchImpl: g.f }, { action: "mail_send", draft_id: D.id });
  assert.equal(r.body.error, "blocked");
  assert.deepEqual(r.body.blocked.map((b) => b.address).sort(), ["amy@y.com", "bob@x.com"]);
  assert.equal(db.tables.mail_drafts[0].status, "draft");
  assert.ok(!g.calls.some((c) => c.endsWith("/drafts/send")));
  // Too many recipients after an edit in Gmail.
  g = fakeGmail({ drafts: { "r-123": H(Array.from({ length: 11 }, (_, i) => `p${i}@x.com`).join(", ")) } });
  db = fakeDb({ tables: { mail_drafts: [{ ...D }] }, conns: { [ME]: conn() } });
  r = await runMailAction({ db, env: ENV, member: MEMBER, fetchImpl: g.f }, { action: "mail_send", draft_id: D.id });
  assert.equal(r.body.error, "too_many");
  // Daily limit: 30 already sent today.
  const sentToday = Array.from({ length: DAILY_SENDS }, (_, i) => row({ id: `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}`, gmail_draft_id: `x${i}`, status: "sent", sent_at: new Date().toISOString() }));
  db = fakeDb({ tables: { mail_drafts: [{ ...D }, ...sentToday] }, conns: { [ME]: conn() } });
  g = fakeGmail({ drafts: { "r-123": H() } });
  r = await runMailAction({ db, env: ENV, member: MEMBER, fetchImpl: g.f }, { action: "mail_send", draft_id: D.id });
  assert.deepEqual([r.status, r.body.error], [429, "daily_limit"]);
  // Deleted in Gmail meanwhile: "gone", marked discarded.
  db = fakeDb({ tables: { mail_drafts: [{ ...D }] }, conns: { [ME]: conn() } });
  g = fakeGmail({ drafts: {} });
  r = await runMailAction({ db, env: ENV, member: MEMBER, fetchImpl: g.f }, { action: "mail_send", draft_id: D.id });
  assert.equal(r.body.error, "gone");
  assert.equal(db.tables.mail_drafts[0].status, "discarded");
  // Not connected.
  db = fakeDb({ tables: { mail_drafts: [{ ...D }] } });
  r = await runMailAction({ db, env: ENV, member: MEMBER }, { action: "mail_send", draft_id: D.id });
  assert.equal(r.body.error, "not_connected");
});

test("discard: deletes only the caller's own unsent draft", async () => {
  const D = row();
  const db = fakeDb({ tables: { mail_drafts: [{ ...D }] }, conns: { [ME]: conn() } });
  const g = fakeGmail({ drafts: { "r-123": H() } });
  const r = await runMailAction({ db, env: ENV, member: MEMBER, fetchImpl: g.f }, { action: "mail_discard", draft_id: D.id });
  assert.equal(r.body.draft.status, "discarded");
  assert.ok(g.calls.includes("DELETE /gmail/v1/users/me/drafts/r-123"));
  const again = await runMailAction({ db, env: ENV, member: MEMBER, fetchImpl: g.f }, { action: "mail_discard", draft_id: D.id });
  assert.equal(again.body.error, "discarded");
  const other = await runMailAction({ db, env: ENV, member: { ...MEMBER, member_id: OTHER }, fetchImpl: g.f }, { action: "mail_discard", draft_id: D.id });
  assert.equal(other.body.error, "not_found");
});

test("blocked recipients: matched through the lead, case-insensitive", async () => {
  const db = fakeDb({ tables: { leads: [{ id: "L", email: "Sam@Example.com", status: "dnc", phone: null }] } });
  assert.deepEqual(await blockedRecipients(db, ["sam@example.com", "jo@example.com"]), [{ address: "sam@example.com", why: "opted out (do not contact)" }]);
  assert.deepEqual(await blockedRecipients(db, []), []);
});

test("the model cannot send: no send tool, no send call in the assistant's mail code", () => {
  assert.deepEqual(MAIL_TOOL_DEFS.map((t) => t.name), MAIL_TOOL_NAMES.slice().sort());
  assert.ok(!MAIL_TOOL_NAMES.some((n) => /send|trash|delete|modify|label/.test(n)));
  const src = readFileSync(join(ROOT, "functions/agent/mail.ts"), "utf8");
  assert.ok(!/drafts\/send|messages\/send|"DELETE"|\/trash|\/modify/.test(src));
  const chat = readFileSync(join(ROOT, "functions/agent/chat.ts"), "utf8");
  assert.ok(!/mail_send|runMailAction|drafts\/send/.test(chat));
  const prompt = readFileSync(join(ROOT, "functions/agent/chat-prompt.ts"), "utf8");
  assert.ok(!/name: "send_email"|tool\("send/.test(prompt));
  assert.match(gmailDraftUrl("me@x.com", "18c1a2b3c4"), /^https:\/\/mail\.google\.com\/mail\/u\/\?authuser=me%40x\.com#drafts\?compose=18c1a2b3c4$/);
  assert.equal(gmailDraftUrl(null, "bad id!"), "https://mail.google.com/mail/u/#drafts");
});

test("containment: reading email holds every hub change until the next message; drafting still works", () => {
  for (const tool of MAIL_READ_TOOLS) assert.ok(taints(tool, {}, tool === "search_email" ? { count: 2 } : tool === "read_thread" ? { shown: 1 } : { body: "x" }), tool);
  assert.equal(taints("search_email", {}, { count: 0 }), false);
  const s = { tainted: true, writesAfterTaint: 0, mailTainted: true };
  for (const tool of ["save_lead", "save_task", "archive", "organise_file", "link_file", "new_folder"]) assert.match(taintCheck(tool, {}, s), /read email/);
  assert.match(taintCheck("remember", { scope: "me" }, s), /read email/);
  for (const tool of ["draft_email", "update_draft", "find", "get", "read_email"]) assert.equal(taintCheck(tool, {}, s), null, tool);
  // The next message starts clean: "yes, add them" then works.
  assert.equal(taintCheck("save_lead", {}, { tainted: false, writesAfterTaint: 0, mailTainted: false }), null);
  // Other untrusted reads keep the old, softer rule.
  assert.equal(taintCheck("save_lead", {}, { tainted: true, writesAfterTaint: 0 }), null);
});
