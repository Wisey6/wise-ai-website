// Unit checks for the calendar parts: local times, event bodies, rows, free times, what taints
// a turn, and the guest gate (cal_confirm). No network. Run: node --test supabase/tests/calendar.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  localToMs, localOf, windowOf, eventBody, whenText, eventRow, eventDetail, freeSlots, busyOf, hoursOf, calendarTaints, recreatable, beforeOf, hasOtherGuests,
} from "../functions/agent/calendar-rules.ts";
import { runCalAction, CAL_ACTIONS } from "../functions/_shared/gcal.ts";
import { SCOPES } from "../functions/_shared/gmail.ts";
import { CAL_TOOL_DEFS, CAL_TOOL_NAMES } from "../functions/agent/calendar.ts";
import { taintCheck } from "../functions/agent/chat-rules.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BNE = "Australia/Brisbane";
const SYD = "Australia/Sydney";
const ME = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
const ENV = (k) => ({ GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "cs", SUPABASE_SERVICE_ROLE_KEY: "svc" })[k];

test("local times: Brisbane (no daylight saving) and Sydney (daylight saving)", () => {
  assert.equal(new Date(localToMs("2026-11-20T09:30", BNE)).toISOString(), "2026-11-19T23:30:00.000Z");
  assert.equal(new Date(localToMs("2026-11-20T09:30", SYD)).toISOString(), "2026-11-19T22:30:00.000Z");
  assert.equal(new Date(localToMs("2026-07-20T09:30", SYD)).toISOString(), "2026-07-19T23:30:00.000Z");
  assert.equal(new Date(localToMs("2026-11-20", BNE)).toISOString(), "2026-11-19T14:00:00.000Z");
  assert.equal(localToMs("20/11/2026", BNE), null);
  assert.equal(localToMs("2026-13-01", BNE), null);
  assert.deepEqual(localOf(Date.parse("2026-11-19T23:30:00Z"), BNE), { date: "2026-11-20", time: "09:30", wd: "Fri" });
});

test("window: now to +14 days by default; a date 'to' includes that whole day", () => {
  const now = Date.parse("2026-11-18T00:00:00Z");
  const w = windowOf({}, BNE, now);
  assert.equal(w.timeMin, "2026-11-18T00:00:00.000Z");
  assert.equal(Date.parse(w.timeMax) - now, 14 * 86_400_000);
  assert.deepEqual(windowOf({ from: "2026-11-20", to: "2026-11-20" }, BNE, now), { timeMin: "2026-11-19T14:00:00.000Z", timeMax: "2026-11-20T14:00:00.000Z" });
  assert.throws(() => windowOf({ from: "tomorrow" }, BNE, now));
  assert.throws(() => windowOf({ from: "2026-11-20", to: "2026-11-19" }, BNE, now));
});

test("event body: checked values, local times with the zone, all-day end is the next day", () => {
  const a = eventBody({ title: "Site visit", start: "2026-11-20T09:00", duration_min: 45, location: "Manly" }, BNE, null);
  assert.deepEqual(a.body, { summary: "Site visit", location: "Manly", start: { dateTime: "2026-11-20T09:00:00", timeZone: BNE }, end: { dateTime: "2026-11-20T09:45:00", timeZone: BNE } });
  assert.equal(a.guests, undefined);
  const d = eventBody({ title: "Leave", start: "2026-11-23", end: "2026-11-25" }, BNE, null).body;
  assert.deepEqual([d.start, d.end], [{ date: "2026-11-23" }, { date: "2026-11-26" }]);
  assert.throws(() => eventBody({ start: "2026-11-20T09:00" }, BNE, null), /title/);
  assert.throws(() => eventBody({ title: "x" }, BNE, null), /start/);
  assert.throws(() => eventBody({ title: "x", start: "2026-11-20T09:00", end: "2026-11-20T08:00" }, BNE, null), /after/);
  assert.throws(() => eventBody({ title: "x", start: "2026-11-20T09:00", duration_min: 2 }, BNE, null), /duration/);
  assert.throws(() => eventBody({ title: "x", start: "2026-11-20T09:00", guests: ["not an email"] }, BNE, null), /guests/);
  assert.deepEqual(eventBody({ title: "x", start: "2026-11-20T09:00", guests: ["Sam <SAM@x.com>", "sam@x.com"] }, BNE, null).guests, ["sam@x.com"]);
  // A change touching only the title keeps everything else; the "before" holds just those fields.
  const ex = { id: "e1", summary: "Old", start: { dateTime: "2026-11-20T09:00:00+10:00" }, end: { dateTime: "2026-11-20T10:00:00+10:00" } };
  const up = eventBody({ title: "New" }, BNE, ex).body;
  assert.deepEqual(up, { summary: "New" });
  assert.deepEqual(beforeOf(ex, up), { summary: "Old" });
  assert.deepEqual(eventBody({ duration_min: 30 }, BNE, ex).body, { end: { dateTime: "2026-11-20T09:30:00", timeZone: BNE } });
});

test("rows: local wording, guests by name, someone else's event marked, link back to the hub", () => {
  const ev = { id: "e1", summary: "Quote walk-through", start: { dateTime: "2026-11-20T09:00:00+10:00" }, end: { dateTime: "2026-11-20T10:30:00+10:00" }, location: "Manly",
    attendees: [{ email: "me@x.com", self: true }, { email: "sam@x.com", displayName: "Sam Lee" }, { email: "room@x.com", resource: true }], hangoutLink: "https://meet.google.com/abc",
    organizer: { email: "sam@x.com", displayName: "Sam Lee" }, extendedProperties: { private: { wiseai_kind: "client", wiseai_id: "c1" } }, description: "<p>Bring the <b>plans</b></p>" };
  const r = eventRow(ev, BNE);
  assert.equal(r.when, "Fri 20 Nov, 9:00 am to 10:30 am");
  assert.deepEqual(r.guests, ["Sam Lee"]);
  assert.equal(r.organiser, "Sam Lee");
  assert.deepEqual(r.linked, { kind: "client", id: "c1" });
  assert.equal(whenText({ start: { date: "2026-11-23" }, end: { date: "2026-11-24" } }, BNE), "Mon 23 Nov (all day)");
  assert.equal(whenText({ start: { date: "2026-11-23" }, end: { date: "2026-11-26" } }, BNE), "Mon 23 Nov to Wed 25 Nov (all day)");
  const det = eventDetail(ev, BNE);
  assert.match(det.description, /<calendar_text>\nBring the plans\n<\/calendar_text>/);
  assert.ok(hasOtherGuests(ev));
  assert.equal(hasOtherGuests({ attendees: [{ email: "me@x.com", self: true }] }), false);
  const copy = recreatable({ ...ev, etag: "x", iCalUID: "u", htmlLink: "h", created: "c" });
  assert.equal(copy.id, undefined);
  assert.equal(copy.etag, undefined);
  assert.deepEqual(copy.attendees, [{ email: "sam@x.com", displayName: "Sam Lee" }, { email: "room@x.com" }]);
});

test("free times: working hours, weekdays, busy events, declined and free events ignored", () => {
  const from = localToMs("2026-11-20T00:00", BNE);   // Friday
  const to = localToMs("2026-11-23T23:59", BNE);     // Monday
  const busy = busyOf([
    { start: { dateTime: "2026-11-20T09:00:00+10:00" }, end: { dateTime: "2026-11-20T12:00:00+10:00" } },
    { start: { dateTime: "2026-11-20T13:00:00+10:00" }, end: { dateTime: "2026-11-20T17:00:00+10:00" }, transparency: "transparent" },
    { start: { dateTime: "2026-11-20T14:00:00+10:00" }, end: { dateTime: "2026-11-20T15:00:00+10:00" }, attendees: [{ self: true, responseStatus: "declined" }] },
    { start: { dateTime: "2026-11-23T08:30:00+10:00" }, end: { dateTime: "2026-11-23T16:45:00+10:00" } },
    { start: { date: "2026-11-23" }, end: { date: "2026-11-24" } },
  ]);
  assert.equal(busy.length, 2);
  const slots = freeSlots(busy, from, to, 60, BNE);
  assert.deepEqual(slots.map((s) => s.when), ["Fri 20 Nov, 12:00 pm to 5:30 pm"]);
  assert.equal(freeSlots(busy, from, to, 30, BNE).length, 3);   // Fri 8:30-9, Fri 12-5:30, Mon 4:45-5:30
  assert.equal(freeSlots(busy, from, to, 30, BNE, undefined, { weekends: true }).length, 5);
  assert.deepEqual(hoursOf("7:00-15:00"), { start: "07:00", end: "15:00" });
  assert.throws(() => hoursOf("late"));
});

test("taint: other people's events and descriptions count like email; own plain events do not", () => {
  assert.equal(calendarTaints("find_events", { events: [{ title: "Gym" }] }), false);
  assert.equal(calendarTaints("find_events", { events: [{ title: "Quote", organiser: "Sam" }] }), true);
  assert.equal(calendarTaints("find_events", { events: [{ title: "Quote", guests: ["Sam"] }] }), true);
  assert.equal(calendarTaints("get_event", { description: "x", guests_detail: [] }), true);
  assert.equal(calendarTaints("free_times", { slots: [] }), false);
  const s = { tainted: true, writesAfterTaint: 0, mailTainted: true };
  for (const tool of ["find_events", "get_event", "free_times", "save_event"]) assert.equal(taintCheck(tool, {}, s), null, tool);
  assert.match(taintCheck("remove_event", {}, s), /calendar/);
});

test("the assistant's own calendar calls never email anyone; only cal_confirm sends updates", () => {
  const src = readFileSync(join(ROOT, "functions/agent/calendar.ts"), "utf8");
  assert.ok(!/sendUpdates=all/.test(src));
  assert.ok((src.match(/sendUpdates=none/g) || []).length >= 5);
  const shared = readFileSync(join(ROOT, "functions/_shared/gcal.ts"), "utf8");
  assert.equal((shared.match(/`[^`]*sendUpdates=all`/g) || []).length, 3);
  assert.ok(SCOPES.includes("https://www.googleapis.com/auth/calendar.events"));
  assert.ok(!/auth\/calendar(\s|$)/.test(SCOPES));
  assert.deepEqual(CAL_TOOL_DEFS.map((t) => t.name), [...CAL_TOOL_NAMES].sort());
  assert.deepEqual(CAL_ACTIONS, ["cal_confirm", "cal_cancel"]);
});

/* ---------------------------------------------------------------- cal_confirm */
function fakeDb(proposals) {
  const tables = { calendar_proposals: proposals };
  const conns = { [ME]: { member_id: ME, email: "me@x.com", refresh_token: "rt", access_token: "at", access_expires_at: new Date(Date.now() + 3600e3).toISOString(), scope: SCOPES, needs_reconnect: false } };
  const q = (t) => {
    const f = []; let op = "select", payload = null;
    const apply = () => tables[t].filter((r) => f.every((x) => x(r)));
    const b = {
      select() { return b; }, eq(k, v) { f.push((r) => r[k] === v); return b; }, update(p) { op = "update"; payload = p; return b; },
      run() { const hit = apply(); if (op === "update") hit.forEach((r) => Object.assign(r, payload)); return hit; },
      maybeSingle() { return Promise.resolve({ data: b.run()[0] ?? null, error: null }); },
      then(res, rej) { return Promise.resolve({ data: b.run(), error: null }).then(res, rej); },
    };
    return b;
  };
  return { tables, from: q, rpc(name, a) { if (name === "gmail_get") return Promise.resolve({ data: conns[a.p_member] ?? null, error: null }); return Promise.resolve({ data: { ok: true }, error: null }); } };
}
function fakeCal() {
  const calls = [];
  const f = async (url, init = {}) => { const u = new URL(url); calls.push(`${init.method || "GET"} ${u.pathname}?${u.searchParams.get("sendUpdates")}`); return new Response(JSON.stringify({ id: "NEWEV" }), { status: 200, headers: { "content-type": "application/json" } }); };
  return { f, calls };
}
const P = (over = {}) => ({ id: "aaaaaaaa-0000-4000-8000-000000000009", member_id: ME, action: "create", event_id: null, payload: { body: { summary: "Walk-through", attendees: [{ email: "sam@x.com" }] } }, title: "Walk-through", when_text: "Fri 20 Nov, 9:00 am", guests: ["sam@x.com"], status: "pending", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600e3).toISOString(), ...over });

test("cal_confirm: only the person's own pending proposal, once, within 24 hours, with sendUpdates=all", async () => {
  const member = { member_id: ME, name: "Tyler", role: "owner" };
  let db = fakeDb([P()]);
  let g = fakeCal();
  let r = await runCalAction({ db, env: ENV, member: { ...member, member_id: OTHER }, fetchImpl: g.f }, { action: "cal_confirm", proposal_id: P().id });
  assert.deepEqual([r.status, r.body.error], [404, "not_found"]);
  assert.equal(g.calls.length, 0);
  r = await runCalAction({ db, env: ENV, member, fetchImpl: g.f }, { action: "cal_confirm", proposal_id: P().id });
  assert.equal(r.status, 200);
  assert.equal(r.body.proposal.status, "done");
  assert.deepEqual(g.calls, ["POST /calendar/v3/calendars/primary/events?all"]);
  assert.equal(db.tables.calendar_proposals[0].result_event_id, "NEWEV");
  r = await runCalAction({ db, env: ENV, member, fetchImpl: g.f }, { action: "cal_confirm", proposal_id: P().id });
  assert.equal(r.body.error, "done");
  assert.equal(g.calls.length, 1);
  db = fakeDb([P({ expires_at: new Date(Date.now() - 1000).toISOString() })]);
  r = await runCalAction({ db, env: ENV, member, fetchImpl: g.f }, { action: "cal_confirm", proposal_id: P().id });
  assert.equal(r.body.error, "expired");
  db = fakeDb([P({ action: "remove", event_id: "ev123" })]);
  g = fakeCal();
  r = await runCalAction({ db, env: ENV, member, fetchImpl: g.f }, { action: "cal_cancel", proposal_id: P().id });
  assert.equal(r.body.proposal.status, "cancelled");
  assert.equal(g.calls.length, 0);
  db = fakeDb([P({ action: "remove", event_id: "ev123" })]);
  r = await runCalAction({ db, env: ENV, member, fetchImpl: g.f }, { action: "cal_confirm", proposal_id: P().id });
  assert.deepEqual(g.calls, ["DELETE /calendar/v3/calendars/primary/events/ev123?all"]);
  assert.equal((await runCalAction({ db, env: ENV, member }, { action: "cal_confirm", proposal_id: "x" })).body.error, "bad_request");
});
