// Unit checks for the agent function's pure logic (no network, no model, no database).
// Run: node --test supabase/tests/agent.test.mjs   (Node >= 22.18 strips TypeScript types natively)
import test from "node:test";
import assert from "node:assert/strict";
import {
  DAILY_LIMITS, MAX_ACTIONS, addDays, addUsage, cleanResearch, costOf, dayWindowStart, emptyTotals, extractJson,
  decodeActions, filterLinked, hasContactDetails, hostOf, lastThree, localDate, monthStartUtc, normUrl, normaliseHistory,
  overBudget, overDailyLimit, referencedIds, scrubText, validateActions,
} from "../functions/agent/validate.ts";
import { allowedHashes, buildSnapshot, isEmptyHub, serialiseSnapshot } from "../functions/agent/snapshot.ts";
import { DOER_SCHEMA, RESEARCHER_SCHEMA } from "../functions/agent/prompts.ts";

// ------------------------------------------------------------------ fixtures

const L1 = "11111111-1111-4111-8111-111111111111";
const L2 = "22222222-2222-4222-8222-222222222222";
const LDNC = "33333333-3333-4333-8333-333333333333";
const LSUP = "44444444-4444-4444-8444-444444444444";
const C1 = "55555555-5555-4555-8555-555555555555";
const P1 = "66666666-6666-4666-8666-666666666666";
const D1 = "77777777-7777-4777-8777-777777777777";
const DWON = "88888888-8888-4888-8888-888888888888";
const UNKNOWN = "99999999-9999-4999-8999-999999999999";

const NOW = new Date("2026-11-16T22:30:00Z"); // Tue 17 Nov 2026, 08:30 in Brisbane
const TODAY = "2026-11-17";

const SECRETS = [
  "+61412345678", "0412 345 678", "0412345678", "412345678", "(07) 3123 4567", "07 3123 4567",
  "jess@acmeplumbing.com.au", "owner@example.com", "tyler@wise-ai.au",
  "https://acmeplumbing.com.au", "acmeplumbing.com.au", "www.acmeplumbing.com.au", "https://maps.google.com/?cid=123",
  "https://cal.com/meet/xyz", "yellowpages.com.au",
];

function fixtureRows() {
  return {
    settings: {
      timezone: "Australia/Brisbane", business_name: "Wise AI", monthly_target: 10000, owner_draw: 4300, cash_on_hand: 5200,
      cash_as_of: "2026-11-10", tax_rate: 0.25, gst_registered: false, avg_deal_value: 3000,
      notify_email: "tyler@wise-ai.au", booking_url: "https://wise-ai.au/book.html", abn: "12345678901",
    },
    leadStatuses: ["new", "contacted", "replied", "dnc", "new"],
    leads: [
      {
        id: L1, business: "Acme Plumbing (acmeplumbing.com.au)", contact_name: "Jess Smith", phone: "+61412345678",
        email: "jess@acmeplumbing.com.au", website: "https://acmeplumbing.com.au", number_source_url: "https://maps.google.com/?cid=123",
        suburb: "Paddington", industry: "Plumbing", status: "replied", hook: "Saw your reviews", est_monthly_value: 2400,
        last_contacted_at: "2026-11-10T01:00:00Z", last_reply_at: "2026-11-16T03:00:00Z", next_followup_at: "2026-11-17T23:00:00Z",
        unread: true, updated_at: "2026-11-16T03:00:00Z", notes: "call 0412 345 678 or jess@acmeplumbing.com.au",
      },
      {
        id: L2, business: "Bright Dental", contact_name: "owner@example.com", phone: "0412 345 678", email: "owner@example.com",
        website: "www.acmeplumbing.com.au", suburb: "Toowong", industry: "Dental", status: "new", hook: null,
        updated_at: "2026-11-01T00:00:00Z",
      },
    ],
    lastInbound: { [L1]: "Sure, ring me on (07) 3123 4567 or email jess@acmeplumbing.com.au, see https://cal.com/meet/xyz. Thursday 2026-11-20 works" },
    deals: [
      { id: D1, title: "Acme booking bot — 07 3123 4567", stage: "proposal", value: 3000, monthly_value: 300, probability: 50,
        next_step: "Send revised quote to jess@acmeplumbing.com.au", next_step_on: "2026-11-18", lead_id: L1, updated_at: "2026-11-15T00:00:00Z" },
    ],
    clients: [
      { id: C1, name: "Gully Cafe", contact_name: "Sam Lee", email: "sam@gully.com", phone: "+61400000001", website: "https://gully.com",
        status: "active", industry: "Cafe", suburb: "Ashgrove", monthly_value: 500, started_on: "2026-06-01" },
    ],
    tasks: [{ id: "t1", title: "Fix the form on yellowpages.com.au listing", state: "todo", priority: "high", due_on: "2026-11-16", client_id: C1 }],
    projects: [{ id: P1, name: "Gully ordering", status: "active", due_on: "2026-12-01", value: 2000, client_id: C1 }],
    invoices: [
      { id: "i1", client_id: C1, description: "November retainer", amount: 500, kind: "retainer", status: "invoiced",
        invoice_no: "WA-2026-014", issued_on: "2026-11-01", due_on: "2026-11-15" },
    ],
    costs: [{ name: "Twilio", vendor: "Twilio", category: "software", amount: 30, cadence: "monthly", next_due: "2026-12-01" }],
    bookings: [{ id: "b1", title: "Intro call", starts_at: "2026-11-18T00:00:00Z", status: "booked", attendee_name: "Jess Smith",
      attendee_email: "jess@acmeplumbing.com.au", attendee_phone: "+61412345678", meeting_url: "https://cal.com/meet/xyz", lead_id: L1 }],
    proposals: [{ id: "p1", number: "WA-2026-015", title: "Booking bot", status: "sent", recipient_business: "Acme Plumbing",
      line_items: [{ label: "Setup", amount: 3000 }, { label: "Monthly", amount: 300 }], sent_on: "2026-11-12", lead_id: L1, updated_at: "2026-11-12T00:00:00Z" }],
  };
}

function ctx(extra = {}) {
  return {
    today: TODAY,
    leads: new Map([
      [L1, { status: "replied", suppressed: false }],
      [L2, { status: "new", suppressed: false }],
      [LDNC, { status: "dnc", suppressed: true }],
      [LSUP, { status: "contacted", suppressed: true }],
    ]),
    clients: new Set([C1]),
    projects: new Set([P1]),
    deals: new Map([[D1, { stage: "proposal" }], [DWON, { stage: "won" }]]),
    ...extra,
  };
}

const act = (kind, payload, extra = {}) => ({ kind, payload, summary: `Do ${kind}`, reason: "because", ...extra });
const one = (a) => validateActions([a], ctx());

// ------------------------------------------------------------------ snapshot

test("snapshot never contains phone numbers, emails or URLs", () => {
  const snap = buildSnapshot(fixtureRows(), NOW);
  const text = serialiseSnapshot(snap);
  for (const s of SECRETS) assert.equal(text.includes(s), false, `snapshot leaked ${s}`);
  assert.equal(/@/.test(text), false, "no @ at all");
  assert.equal(/https?:|www\./i.test(text), false, "no links");
  assert.equal(/\.com\b|\.au\b/i.test(text), false, "no bare domains");
  // No run of 8+ digits outside ISO dates / uuids.
  const stripped = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "").replace(/\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?/g, "");
  assert.equal(hasContactDetails(stripped), false, "no phone-like numbers");
  const digits = stripped.match(/\d[\d\s().-]*\d/g) ?? [];
  assert.ok(digits.every((m) => m.replace(/\D/g, "").length < 8), `long digit run: ${digits.find((m) => m.replace(/\D/g, "").length >= 8)}`);
  // contact columns are not even present as keys
  for (const k of ['"phone"', '"email"', '"website"', '"number_source_url"', '"meeting_url"', '"attendee_email"', '"attendee_phone"', '"notes"', '"abn"', '"notify_email"', '"booking_url"']) {
    assert.equal(text.includes(k), false, `key ${k} present`);
  }
});

test("snapshot keeps what the agents need", () => {
  const snap = buildSnapshot(fixtureRows(), NOW);
  assert.equal(snap.today, TODAY);
  assert.equal(snap.weekday, "Tuesday");
  const l1 = snap.leads.find((l) => l.id === L1);
  assert.equal(l1.first_name, "Jess");
  assert.equal(l1.business, "Acme Plumbing ([link])");
  assert.equal(l1.has_hook, true);
  assert.equal(l1.unread, true);
  assert.equal(l1.next_followup_at, "2026-11-18 09:00"); // local time
  assert.match(l1.last_inbound, /\[number\]/);
  assert.match(l1.last_inbound, /2026-11-20/); // dates survive scrubbing
  assert.equal(l1.inbox, `#inbox/${L1}`);
  const l2 = snap.leads.find((l) => l.id === L2);
  assert.equal(l2.first_name, undefined); // contact_name was an email
  assert.equal(snap.counts.leads_total, 5);
  assert.deepEqual(snap.counts.leads_by_status, { contacted: 1, dnc: 1, new: 2, replied: 1 });
  assert.equal(snap.invoices[0].overdue, true);
  assert.equal(snap.proposals[0].total, 3300);
  assert.equal(snap.leads[0].id, L1); // most recently active first
  assert.equal(isEmptyHub(snap), false);
});

test("snapshot serialisation is stable regardless of input order", () => {
  const a = fixtureRows();
  const b = fixtureRows();
  b.leads.reverse(); b.leadStatuses.reverse();
  assert.equal(serialiseSnapshot(buildSnapshot(a, NOW)), serialiseSnapshot(buildSnapshot(b, NOW)));
});

test("snapshot of an empty hub is empty", () => {
  const rows = { settings: {}, leadStatuses: [], leads: [], lastInbound: {}, deals: [], clients: [], tasks: [], projects: [], invoices: [], costs: [], bookings: [], proposals: [] };
  const snap = buildSnapshot(rows, NOW);
  assert.equal(isEmptyHub(snap), true);
  // costs alone make a hub non-empty (the briefing has something to say about them)
  assert.equal(isEmptyHub(buildSnapshot({ ...rows, costs: [{ name: "x", amount: 1, cadence: "monthly" }] }, NOW)), false);
  // ...even when none of them is in the snapshot's cost list (only old one-offs)
  assert.equal(isEmptyHub(buildSnapshot({ ...rows, costCount: 16 }, NOW)), false);
  assert.equal(isEmptyHub(buildSnapshot({ ...rows, leadStatuses: ["dnc"] }, NOW)), false);
});

test("allowed hashes come only from the snapshot", () => {
  const snap = buildSnapshot(fixtureRows(), NOW);
  const h = allowedHashes(snap);
  for (const x of [`#leads/${L1}`, `#inbox/${L1}`, `#pipeline/${D1}`, `#clients/${C1}`, `#income/i1`, "#income", "#projects/tasks", `#proposals/p1`]) assert.ok(h.has(x), x);
  assert.equal(h.has(`#inbox/${L2}`), false); // no conversation
  assert.equal(h.has(`#leads/${UNKNOWN}`), false);
});

test("briefing hashes not in the link map are dropped", () => {
  const allowed = new Set(["#income", `#inbox/${L1}`]);
  const r = filterLinked([
    { text: "Chase Gully", hash: "#income" },
    { text: "Reply to Jess", hash: `#inbox/${L1}` },
    { text: "Made up", hash: `#inbox/${UNKNOWN}` },
    { text: "", hash: "#income" },
    { text: "No hash" },
    { text: "javascript", hash: "javascript:alert(1)" },
  ], allowed, 5);
  assert.deepEqual(r.kept.map((k) => k.text), ["Chase Gully", "Reply to Jess"]);
  assert.equal(r.dropped, 4);
  assert.equal(filterLinked(Array(6).fill({ text: "x", hash: "#income" }), allowed, 5).kept.length, 5);
  assert.equal(filterLinked("nope", allowed, 5).kept.length, 0);
  // ask links use "label"
  assert.deepEqual(filterLinked([{ label: "Income", hash: "#income" }], allowed, 5, "label").kept, [{ text: "Income", hash: "#income" }]);
});

// ------------------------------------------------------------------ scrubbing

test("scrubText", () => {
  assert.equal(scrubText("call 0412 345 678 now"), "call [number] now");
  assert.equal(scrubText("call +61 412 345 678"), "call [number]");
  assert.equal(scrubText("(07) 3123 4567"), "[number]");
  assert.equal(scrubText("mail a.b+c@d.com.au please"), "mail [email] please");
  assert.equal(scrubText("see https://x.com/a?b=1 or www.y.org"), "see [link] or [link]");
  assert.equal(scrubText("acme.com.au/contact"), "[link]");
  assert.equal(scrubText("on 2026-11-20 at 3pm, $12,500 for 4 staff"), "on 2026-11-20 at 3pm, $12,500 for 4 staff");
  assert.equal(scrubText("x".repeat(300), 10).length, 10);
  assert.equal(scrubText(null), "");
  assert.equal(lastThree("+61412345678"), "678");
  assert.equal(lastThree(null), "");
  assert.equal(lastThree("12"), "");
});

test("ask history rules", () => {
  assert.deepEqual(normaliseHistory(undefined), []);
  assert.equal(normaliseHistory(Array(11).fill({ role: "user", text: "x" })), null);
  assert.equal(normaliseHistory([{ role: "system", text: "x" }]), null);
  assert.equal(normaliseHistory([{ role: "user", text: "x".repeat(2001) }]), null);
  assert.equal(normaliseHistory("nope"), null);
  assert.deepEqual(normaliseHistory([
    { role: "assistant", text: "leading" }, { role: "user", text: "a" }, { role: "user", text: "ring 0412 345 678" }, { role: "assistant", text: "b" },
  ]), [{ role: "user", text: "a\n\nring [number]" }, { role: "assistant", text: "b" }]);
});

// ------------------------------------------------------------------ doer allowlist: each kind

test("doer: every allowed kind passes with a good payload", () => {
  const good = [
    act("lead.set_status", { lead_id: L1, status: "interested" }),
    act("lead.set_followup", { lead_id: L1, date: "2026-11-20" }),
    act("lead.set_hook", { lead_id: L2, hook: "Saw you opened a second clinic" }),
    act("note.add", { lead_id: L1, text: "Prefers Thursdays" }),
    act("note.add", { client_id: C1, text: "Happy with the bot" }),
    act("task.create", { title: "Write case study", client_id: C1, project_id: P1, due_on: "2026-11-30", priority: "high" }),
    act("task.create", { title: "Just a title" }),
    act("deal.create", { title: "Bright Dental reception bot", lead_id: L2, value: 2500, monthly_value: 250, next_step: "Book a call" }),
    act("deal.create", { title: "Gully upsell", client_id: C1 }),
    act("deal.update", { deal_id: D1, stage: "negotiation", next_step: "Call Jess", next_step_on: "2026-11-19", probability: 70 }),
    act("message.draft", { lead_id: L1, body: "Thursday at 10 works for me. Talk then." }),
    act("invoice.draft", { client_id: C1, description: "December retainer", amount: 500, kind: "retainer" }),
  ];
  const r = validateActions(good, ctx());
  assert.deepEqual(r.rejected, []);
  assert.equal(r.valid.length, good.length);
});

test("doer: payloads are rebuilt from allowlisted keys only", () => {
  const r = one(act("lead.set_status", { lead_id: L1, status: "won", send: true, phone: "+61412345678" }));
  assert.deepEqual(r.valid[0].payload, { lead_id: L1, status: "won" });
  const t = one(act("invoice.draft", { client_id: C1, description: "x", amount: "250", kind: "one_off", status: "paid" }));
  assert.deepEqual(t.valid[0].payload, { client_id: C1, description: "x", amount: 250, kind: "one_off" });
});

const reject = (a, why) => {
  const r = one(a);
  assert.equal(r.valid.length, 0, `expected rejection: ${JSON.stringify(a)}`);
  if (why) assert.match(r.rejected[0].why, why);
};

test("doer: unknown kinds are dropped", () => {
  for (const kind of ["message.send", "lead.delete", "invoice.send", "settings.update", "lead.set_dnc", "", "deal.close", "income.mark_paid"]) {
    reject(act(kind, { lead_id: L1 }), /kind not allowed/);
  }
  reject({ payload: { lead_id: L1 }, summary: "x" }, /kind not allowed/);
});

test("doer: unknown ids are dropped", () => {
  reject(act("lead.set_status", { lead_id: UNKNOWN, status: "new" }), /unknown lead/);
  reject(act("lead.set_status", { lead_id: "not-a-uuid", status: "new" }), /unknown lead/);
  reject(act("note.add", { client_id: UNKNOWN, text: "x" }), /unknown client/);
  reject(act("task.create", { title: "x", project_id: UNKNOWN }), /unknown project/);
  reject(act("task.create", { title: "x", client_id: UNKNOWN }), /unknown client/);
  reject(act("deal.update", { deal_id: UNKNOWN, stage: "proposal" }), /unknown deal/);
  reject(act("deal.create", { title: "x", lead_id: UNKNOWN }), /unknown lead/);
  reject(act("invoice.draft", { client_id: UNKNOWN, description: "x", amount: 1, kind: "one_off" }), /unknown client/);
  reject(act("message.draft", { lead_id: UNKNOWN, body: "hi" }), /unknown lead/);
});

test("doer: dnc leads are never touched", () => {
  for (const a of [
    act("lead.set_status", { lead_id: LDNC, status: "new" }),
    act("lead.set_followup", { lead_id: LDNC, date: TODAY }),
    act("lead.set_hook", { lead_id: LDNC, hook: "x" }),
    act("note.add", { lead_id: LDNC, text: "x" }),
    act("deal.create", { title: "x", lead_id: LDNC }),
    act("message.draft", { lead_id: LDNC, body: "hi" }),
  ]) reject(a, /do-not-contact/);
  reject(act("lead.set_status", { lead_id: L1, status: "dnc" }), /status not allowed/);
  reject(act("lead.set_status", { lead_id: L1, status: "spam" }), /status not allowed/);
  reject(act("message.draft", { lead_id: LSUP, body: "hi" }), /suppressed/);
  // a suppressed (but not dnc) lead can still get a follow-up date
  assert.equal(one(act("lead.set_followup", { lead_id: LSUP, date: TODAY })).valid.length, 1);
});

test("doer: over-long text is dropped", () => {
  reject(act("lead.set_hook", { lead_id: L1, hook: "x".repeat(161) }), /160/);
  assert.equal(one(act("lead.set_hook", { lead_id: L1, hook: "x".repeat(160) })).valid.length, 1);
  reject(act("note.add", { lead_id: L1, text: "x".repeat(501) }), /500/);
  reject(act("message.draft", { lead_id: L1, body: "x".repeat(601) }), /600/);
  assert.equal(one(act("message.draft", { lead_id: L1, body: "x".repeat(600) })).valid.length, 1);
  reject(act("task.create", { title: "x".repeat(201) }), /200/);
  reject(act("deal.create", { title: "x".repeat(201) }), /200/);
  reject(act("deal.update", { deal_id: D1, next_step: "x".repeat(201) }), /200/);
  reject(act("invoice.draft", { client_id: C1, description: "x".repeat(201), amount: 1, kind: "one_off" }), /200/);
  reject(act("lead.set_hook", { lead_id: L1, hook: "   " }), /empty/);
  reject(act("note.add", { lead_id: L1, text: "x" }, { summary: "s".repeat(201) }), /summary/);
  reject(act("note.add", { lead_id: L1, text: "x" }, { summary: "" }), /summary/);
});

test("doer: bad dates are dropped", () => {
  reject(act("lead.set_followup", { lead_id: L1, date: "2026-11-16" }), /today to 90/); // yesterday
  assert.equal(one(act("lead.set_followup", { lead_id: L1, date: TODAY })).valid.length, 1);
  assert.equal(one(act("lead.set_followup", { lead_id: L1, date: addDays(TODAY, 90) })).valid.length, 1);
  reject(act("lead.set_followup", { lead_id: L1, date: addDays(TODAY, 91) }), /today to 90/);
  reject(act("lead.set_followup", { lead_id: L1, date: "2026-02-30" }));
  reject(act("lead.set_followup", { lead_id: L1, date: "20/11/2026" }));
  reject(act("lead.set_followup", { lead_id: L1, date: "2026-11-20T09:00:00Z" }));
  reject(act("lead.set_followup", { lead_id: L1 }));
  reject(act("task.create", { title: "x", due_on: "tomorrow" }), /due date/);
  reject(act("deal.update", { deal_id: D1, next_step_on: "2025-01-01" }), /next step date/);
});

test("doer: amounts, stages and other rules", () => {
  reject(act("invoice.draft", { client_id: C1, description: "x", amount: 0, kind: "one_off" }), /amount/);
  reject(act("invoice.draft", { client_id: C1, description: "x", amount: -5, kind: "one_off" }), /amount/);
  reject(act("invoice.draft", { client_id: C1, description: "x", amount: 50001, kind: "one_off" }), /amount/);
  assert.equal(one(act("invoice.draft", { client_id: C1, description: "x", amount: 50000, kind: "one_off" })).valid.length, 1);
  reject(act("invoice.draft", { client_id: C1, description: "x", amount: 10, kind: "weekly" }), /kind/);
  reject(act("deal.update", { deal_id: D1, stage: "won" }), /closing a deal/);
  reject(act("deal.update", { deal_id: D1, stage: "lost" }), /closing a deal/);
  reject(act("deal.update", { deal_id: DWON, next_step: "x" }), /closed/);
  reject(act("deal.update", { deal_id: D1 }), /nothing to change/);
  reject(act("deal.update", { deal_id: D1, probability: 101 }), /probability/);
  reject(act("deal.update", { deal_id: D1, probability: 33.5 }), /probability/);
  reject(act("deal.create", { title: "x", lead_id: L1, client_id: C1 }), /both/);
  reject(act("deal.create", { title: "x", value: -1 }), /value/);
  reject(act("note.add", { lead_id: L1, client_id: C1, text: "x" }), /exactly one/);
  reject(act("note.add", { text: "x" }), /exactly one/);
  reject(act("task.create", { title: "x", priority: "urgent" }), /priority/);
  reject(act("lead.set_status", null), /payload/);
  reject(act("lead.set_status", [L1]), /payload/);
});

test("doer: at most 20 actions, duplicates dropped, junk tolerated", () => {
  const many = Array.from({ length: 25 }, (_, i) => act("task.create", { title: `Task ${i}` }));
  const r = validateActions(many, ctx());
  assert.equal(MAX_ACTIONS, 20);
  assert.equal(r.valid.length, 20);
  assert.equal(r.rejected.length, 5);
  assert.ok(r.rejected.every((x) => /more than 20/.test(x.why)));
  const dup = validateActions([act("task.create", { title: "Same" }), act("task.create", { title: "Same" })], ctx());
  assert.equal(dup.valid.length, 1);
  assert.equal(dup.rejected[0].why, "duplicate");
  assert.deepEqual(validateActions("nope", ctx()), { valid: [], rejected: [] });
  assert.equal(validateActions([null, 5, "x"], ctx()).rejected.length, 3);
});

test("doer: payload_json is decoded, bad JSON becomes a rejected action", () => {
  const decoded = decodeActions([
    { kind: "lead.set_followup", payload_json: `{"lead_id":"${L1}","date":"2026-11-20"}`, summary: "Follow up Acme", reason: "quiet" },
    { kind: "task.create", payload_json: "{not json", summary: "x", reason: "" },
    null,
  ]);
  assert.deepEqual(decoded[0], { kind: "lead.set_followup", payload: { lead_id: L1, date: "2026-11-20" }, summary: "Follow up Acme", reason: "quiet" });
  const r = validateActions(decoded, ctx());
  assert.equal(r.valid.length, 1);
  assert.deepEqual(r.rejected.map((x) => x.why), ["payload missing", "kind not allowed"]);
  assert.deepEqual(decodeActions("nope"), []);
});

test("referencedIds collects only uuids, first 20", () => {
  const r = referencedIds([act("note.add", { lead_id: L1, client_id: C1 }), act("deal.update", { deal_id: D1 }), act("task.create", { project_id: "x" })]);
  assert.deepEqual(r, { leads: [L1], clients: [C1], projects: [], deals: [D1] });
});

// ------------------------------------------------------------------ researcher output rules

test("researcher: observations must cite a page that was read; hooks need observations", () => {
  const read = new Set([normUrl("https://acme.com.au/"), normUrl("https://acme.com.au/services")]);
  const raw = {
    observations: [
      { text: "Offers 24/7 emergency callouts", source_url: "https://www.acme.com.au" },
      { text: "Guessed from search", source_url: "https://other.com/page" },
      { text: "Lists 3 vans", source_url: "https://acme.com.au/services/" },
    ],
    hooks: ["Saw you offer 24/7 callouts, which means a lot of after-hours calls.", "Hi Jess, love the site", "x".repeat(141)],
    pain: "Missed after-hours calls", opted_out: false, opted_out_evidence: "",
    number_published: "yes", number_evidence_url: "https://acme.com.au/contact", could_not_read: "",
  };
  const r = cleanResearch(raw, read);
  assert.equal(r.result.observations.length, 2);
  assert.deepEqual(r.result.hooks, ["Saw you offer 24/7 callouts, which means a lot of after-hours calls."]);
  assert.equal(r.result.number_published, "unknown"); // evidence page was not read
  assert.equal(r.result.number_evidence_url, "");
  assert.equal(r.dropped, 3);

  const nothing = cleanResearch({ ...raw, observations: [{ text: "x", source_url: "https://nope.com" }] }, read);
  assert.deepEqual(nothing.result.hooks, []);
  assert.equal(nothing.result.pain, "");
  assert.notEqual(nothing.result.could_not_read, "");
  assert.equal(cleanResearch(null, read), null);
  const many = cleanResearch({ observations: Array(7).fill({ text: "a", source_url: "https://acme.com.au" }), hooks: ["a", "b", "c", "d"] }, read);
  assert.equal(many.result.observations.length, 5);
  assert.equal(many.result.hooks.length, 3);
  assert.equal(many.result.number_published, "unknown");
});

test("url helpers", () => {
  assert.equal(normUrl("https://WWW.Acme.com.au/a/#x"), "https://acme.com.au/a");
  assert.equal(normUrl("nope"), "");
  assert.equal(hostOf("www.acme.com.au/contact"), "acme.com.au");
  assert.equal(hostOf("https://maps.google.com/?cid=1"), "maps.google.com");
  assert.equal(hostOf(""), "");
});

test("extractJson", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('I looked. {"a":{"b":3}}'), { a: { b: 3 } });
  assert.equal(extractJson("no json"), undefined);
});

// ------------------------------------------------------------------ money and limits

test("cost maths", () => {
  let t = emptyTotals();
  t = addUsage(t, { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 10000, cache_creation_input_tokens: 2000, server_tool_use: { web_search_requests: 2 } });
  t = addUsage(t, { input_tokens: 1000, output_tokens: 500 });
  assert.deepEqual(t, { input: 2000, cacheWrite: 2000, cacheRead: 10000, output: 1000, searches: 2 });
  // Sonnet 5.5: (2000*2 + 2000*2.5 (cache write) + 10000*0.1 (cache read) + 1000*10)/1e6 + 2*0.01 = 0.02 + 0.02
  assert.equal(costOf("claude-sonnet-5-5", t), 0.04);
  // Haiku 5.5: (2000*0.1 + 2000*0.125 + 10000*0.01 + 1000*0.5)/1e6 = 0.00105 + searches 0.02
  assert.equal(costOf("claude-haiku-5-5", t), 0.02105);
  // Opus 5.5: (2000*4 + 2000*5 + 10000*0.2 + 1000*20)/1e6 = 0.04 + 0.02
  assert.equal(costOf("claude-opus-5-5", t), 0.06);
  assert.equal(costOf("claude-sonnet-5", emptyTotals()), 0);
  assert.equal(addUsage(emptyTotals(), null).input, 0);
});

test("budget and daily limits", () => {
  assert.deepEqual(DAILY_LIMITS, { researcher: 40, briefing: 4, ask: 150, doer: 30, chat: 300 });
  assert.equal(overDailyLimit("chat", 299), false);
  assert.equal(overDailyLimit("chat", 300), true);
  assert.equal(overDailyLimit("briefing", 3), false);
  assert.equal(overDailyLimit("briefing", 4), true);
  assert.equal(overDailyLimit("researcher", 39), false);
  assert.equal(overDailyLimit("researcher", 40), true);
  assert.equal(overDailyLimit("ask", 150), true);
  assert.equal(overDailyLimit("doer", 29), false);
  assert.equal(overBudget(0, 0), true);   // a cap of 0 blocks everything
  assert.equal(overBudget(24.99, 25), false);
  assert.equal(overBudget(25, 25), true);
  assert.equal(overBudget(0, NaN), true);
});

test("day and month windows", () => {
  // 08:30 Tue 17 Nov in Brisbane: the day started at 14:00Z on the 16th
  assert.equal(dayWindowStart(NOW, "Australia/Brisbane"), "2026-11-16T14:00:00.000Z");
  assert.equal(localDate(NOW, "Australia/Brisbane"), TODAY);
  // 23:59 local still the same day; 00:00 local next day starts a new window
  assert.equal(dayWindowStart(new Date("2026-11-17T13:59:00Z"), "Australia/Brisbane"), "2026-11-16T14:00:00.000Z");
  assert.equal(dayWindowStart(new Date("2026-11-17T14:00:00Z"), "Australia/Brisbane"), "2026-11-17T14:00:00.000Z");
  // DST zone
  assert.equal(dayWindowStart(new Date("2026-11-17T05:00:00Z"), "Australia/Sydney"), "2026-11-16T13:00:00.000Z");
  assert.equal(dayWindowStart(NOW, ""), "2026-11-16T14:00:00.000Z"); // default zone
  // monthly budget counts from the 1st, UTC
  assert.equal(monthStartUtc(NOW), "2026-11-01T00:00:00.000Z");
  assert.equal(monthStartUtc(new Date("2026-12-01T00:00:00Z")), "2026-12-01T00:00:00.000Z");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("schemas are strict objects", () => {
  const walk = (s) => {
    if (s && typeof s === "object") {
      if (s.type === "object") assert.equal(s.additionalProperties, false);
      Object.values(s).forEach(walk);
    }
  };
  walk(RESEARCHER_SCHEMA);
  walk(DOER_SCHEMA);
  assert.equal(DOER_SCHEMA.properties.actions.items.properties.kind.enum.length, 9);
});
