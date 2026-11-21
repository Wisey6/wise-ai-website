// Lead scout rules: phone numbers, de-duplication, candidate checks, schedule guard, settings patch and
// the signed email links (signature, tampering, expiry, single use). node --test supabase/tests/scout.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  auPhone, numberOnPage, nameKey, sameBusiness, hostOf, ownHost, duplicateOf, saysNoContact, checkCandidate, normUrl,
  nameOnPage, businessOnPage, scheduleDue, batchesFor, signLink, parseToken, checkLink, scoutRequest, checkScoutSettings, decideIds,
} from "../functions/agent/scout-rules.ts";

const KEY = "k".repeat(64);
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const MEMBER = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const CAND = "16fd2706-8baf-433b-82eb-8c7fada847da";

test("phones: Australian formats to E.164 and kind", () => {
  assert.deepEqual(auPhone("(07) 3123 4567"), { e164: "+61731234567", kind: "landline", national: "0731234567" });
  assert.equal(auPhone("0412 345 678").kind, "mobile");
  assert.equal(auPhone("+61 412 345 678").e164, "+61412345678");
  assert.equal(auPhone("61412345678").e164, "+61412345678");
  assert.equal(auPhone("1300 123 456").kind, "other");
  assert.equal(auPhone("13 12 34").e164, "+61131234");
  assert.equal(auPhone("+1 415 555 0100"), null);
  assert.equal(auPhone("12345"), null);
  assert.equal(auPhone(""), null);
  assert.equal(auPhone(null), null);
});

test("number on page: any spacing, +61, local landline without area code", () => {
  const p = auPhone("07 3123 4567");
  assert.ok(numberOnPage("Call us on (07) 3123-4567 today", p));
  assert.ok(numberOnPage("Phone +61 7 3123 4567", p));
  assert.ok(numberOnPage("Ph 3123 4567", p));
  assert.ok(!numberOnPage("Ph 3123 4568", p));
  const m = auPhone("0412 345 678");
  assert.ok(numberOnPage("Mob: 0412 345 678", m));
  assert.ok(!numberOnPage("Mob: 0412 345 679", m));
});

test("names and hosts: keys, fuzzy match, shared hosts never count", () => {
  assert.equal(nameKey("Smith Plumbing Pty Ltd", "Carina"), "plumbing smith|carina");
  assert.ok(sameBusiness({ business: "Smith Plumbing", suburb: "Carina" }, { business: "Smith Plumbing Pty Ltd", suburb: "carina" }));
  assert.ok(!sameBusiness({ business: "Smith Plumbing", suburb: "Carina" }, { business: "Smith Plumbing", suburb: "Bulimba" }));
  assert.ok(!sameBusiness({ business: "Smith Plumbing" }, { business: "Jones Plumbing" }));
  assert.ok(sameBusiness({ business: "Bright Smile Dental" }, { business: "Bright Smile Dental Studio Morningside" }));
  assert.equal(hostOf("https://www.Example.com.au/contact"), "example.com.au");
  assert.equal(hostOf("example.com.au"), "example.com.au");
  assert.equal(hostOf("not a url ::"), "");
  assert.equal(ownHost("https://www.facebook.com/smithplumbing"), "");
  assert.equal(ownHost("https://www.yellowpages.com.au/x"), "");
  assert.equal(ownHost("https://smithplumbing.com.au"), "smithplumbing.com.au");
});

test("duplicates: suppressed first, then phone, website, name", () => {
  const k = {
    phones: new Set(["+61731234567"]), hosts: new Set(["known.com.au"]), suppressed: new Set(["+61400000000"]),
    names: [{ business: "Acme Electrical", suburb: "Carina", what: "a lead" }],
  };
  assert.equal(duplicateOf({ phone: "+61400000000", business: "X" }, k), "suppressed");
  assert.equal(duplicateOf({ phone: "+61731234567", business: "X" }, k), "same phone");
  assert.equal(duplicateOf({ phone: "+61733333333", website_host: "known.com.au", business: "X" }, k), "same website");
  assert.equal(duplicateOf({ phone: "+61733333333", business: "Acme Electrical Pty Ltd", suburb: "Carina" }, k), "same business (a lead)");
  assert.equal(duplicateOf({ phone: "+61733333333", business: "New Co Painting", suburb: "Carina" }, k), null);
});

test("no-contact wording on a page", () => {
  assert.ok(saysNoContact("Please note: no unsolicited sales calls."));
  assert.ok(saysNoContact("We do not contact for marketing... Do not call us regarding sales"));
  assert.ok(saysNoContact("No soliciting"));
  assert.ok(!saysNoContact("Call us for a free quote"));
});

const goodRaw = () => ({
  business: "ZZSCOUT Test Plumbing", suburb: "Carina", industry: "Plumber", website: "zzscout-test.example.com",
  phone: "(07) 3123 4567", phone_source_url: "https://zzscout-test.example.com/contact",
  contact_first_name: "Jess", observations: [{ text: "Bookings by phone only", source_url: "https://zzscout-test.example.com/contact" }, { text: "made up", source_url: "https://elsewhere.example.com/" }],
  hook: "Saw you take bookings by phone only", pain: "Missed calls", est_monthly_value: 1200.4, value_reasoning: "4 calls x $300",
  first_text: "Hi, Tyler at Wise AI here. Quick question?", score: 140, score_reason: "fits", no_contact: false,
});
const read = new Set([normUrl("https://zzscout-test.example.com/contact")]);

test("candidate check: keeps only what pages it read show", () => {
  const r = checkCandidate(goodRaw(), read);
  assert.equal(r.ok, true);
  assert.equal(r.c.phone, "+61731234567");
  assert.equal(r.c.website, "https://zzscout-test.example.com");
  assert.equal(r.c.website_host, "zzscout-test.example.com");
  assert.equal(r.c.observations.length, 1, "observation citing an unread page is dropped");
  assert.equal(r.c.score, 100);
  assert.equal(r.c.est_monthly_value, 1200);
  assert.equal(checkCandidate({ ...goodRaw(), phone_source_url: "https://other.example.com/" }, read).why, "phone source page was not read in this run");
  assert.equal(checkCandidate({ ...goodRaw(), phone: "555" }, read).why, "no valid Australian phone");
  assert.equal(checkCandidate({ ...goodRaw(), no_contact: true }, read).why, "page says no unsolicited contact");
  assert.equal(checkCandidate({ ...goodRaw(), observations: [] }, read).why, "no observation from a page it read");
  assert.equal(checkCandidate({ ...goodRaw(), business: " " }, read).why, "no business name");
  assert.equal(checkCandidate(null, read).ok, false);
  assert.equal(checkCandidate({ ...goodRaw(), hook: "Hi there, saw your site" }, read).c.hook, null, "greeting hooks dropped");
  assert.equal(checkCandidate({ ...goodRaw(), first_text: "Visit https://x.y" }, read).c.first_text, null, "no links in a first text");
  assert.equal(checkCandidate({ ...goodRaw(), contact_first_name: "jess smith" }, read).c.contact_first_name, null);
});

test("page checks: contact name and business name must be on the page", () => {
  assert.equal(nameOnPage("Owner: Jess", "Jess"), "Jess");
  assert.equal(nameOnPage("Owner: Jessica", "Jess"), null);
  assert.equal(nameOnPage("anything", null), null);
  assert.ok(businessOnPage("Welcome to ZZSCOUT Test Plumbing in Carina", "ZZSCOUT Test Plumbing"));
  assert.ok(!businessOnPage("Welcome to another business", "ZZSCOUT Test Plumbing"));
});

test("schedule: off, weekday, hour window, local day", () => {
  const s = { scout_enabled: true, scout_days: [1, 2, 3, 4, 5], scout_hour: 7, timezone: "Australia/Brisbane" };
  // Fri 20 Nov 2026 08:00 Brisbane = 22:00 UTC Thu
  const fri8 = new Date("2026-11-19T22:00:00Z");
  assert.deepEqual(scheduleDue(fri8, s), { due: true, why: "due", day: "2026-11-20" });
  assert.equal(scheduleDue(fri8, { ...s, scout_enabled: false }).why, "off");
  assert.equal(scheduleDue(fri8, { ...s, scout_hour: 9 }).why, "too early");
  assert.equal(scheduleDue(new Date("2026-11-20T08:30:00Z"), s).why, "too late"); // 18:30 local
  assert.equal(scheduleDue(new Date("2026-11-20T22:00:00Z"), s).why, "not a scout day"); // Sat 08:00
  assert.equal(scheduleDue(fri8, {}).why, "off", "missing switch means off");
  assert.equal(batchesFor(10), 3);
  assert.equal(batchesFor(1), 2);
  assert.equal(batchesFor(30), 6);
});

test("settings patch: only known keys, ranges, owner-only cap handled by caller", () => {
  assert.deepEqual(checkScoutSettings({ scout_enabled: true, scout_daily_max: 5 }), { ok: true, patch: { scout_enabled: true, scout_daily_max: 5 } });
  assert.deepEqual(checkScoutSettings({ scout_days: [5, 1, 1, 3] }).patch, { scout_days: [1, 3, 5] });
  assert.deepEqual(checkScoutSettings({ scout_brief: "  Plumbers in Carina  " }).patch, { scout_brief: "Plumbers in Carina" });
  assert.deepEqual(checkScoutSettings({ scout_brief: "" }).patch, { scout_brief: null });
  assert.equal(checkScoutSettings({ scout_enabled: "yes" }).ok, false);
  assert.equal(checkScoutSettings({ scout_daily_max: 31 }).ok, false);
  assert.equal(checkScoutSettings({ scout_daily_max: 2.5 }).ok, false);
  assert.equal(checkScoutSettings({ scout_days: [0] }).ok, false);
  assert.equal(checkScoutSettings({ scout_hour: 24 }).ok, false);
  assert.equal(checkScoutSettings({ scout_monthly_cap_usd: 101 }).ok, false);
  assert.equal(checkScoutSettings({ scout_monthly_cap_usd: "5" }).ok, false);
  assert.equal(checkScoutSettings({ scout_brief: "x".repeat(2001) }).ok, false);
  assert.match(checkScoutSettings({ notify_email: "a" }).detail, /unknown setting/);
  assert.equal(checkScoutSettings({}).detail, "nothing to change");
  assert.equal(checkScoutSettings([]).ok, false);
});

test("decide ids: one or many uuids, max 50, deduped", () => {
  assert.deepEqual(decideIds({ candidate_id: CAND }), [CAND]);
  assert.deepEqual(decideIds({ candidate_ids: [CAND, CAND.toUpperCase()] }), [CAND]);
  assert.equal(decideIds({ candidate_ids: [] }), null);
  assert.equal(decideIds({ candidate_ids: ["nope"] }), null);
  assert.equal(decideIds({ candidate_ids: Array(51).fill(CAND) }), null);
  assert.equal(decideIds({}), null);
});

test("links: sign, verify, tamper, wrong key, expiry, single use", async () => {
  const row = { id: ID, action: "approve", candidate_id: CAND, run_id: null, member_id: MEMBER, expires_at: "2026-11-27T00:00:00Z", used_at: null };
  const now = new Date("2026-11-20T00:00:00Z");
  const tok = await signLink(KEY, row);
  assert.ok(parseToken(tok));
  assert.equal(await checkLink(KEY, tok, row, now), null);
  assert.equal(await checkLink("z".repeat(64), tok, row, now), "bad_link", "another key");
  assert.equal(await checkLink(KEY, tok, { ...row, action: "skip" }, now), "bad_link", "signature binds the action");
  assert.equal(await checkLink(KEY, tok, { ...row, candidate_id: ID }, now), "bad_link", "and the candidate");
  assert.equal(await checkLink(KEY, tok, { ...row, member_id: CAND }, now), "bad_link", "and the recipient");
  const flipped = tok.slice(0, -1) + (tok.endsWith("A") ? "B" : "A");
  assert.equal(await checkLink(KEY, flipped, row, now), "bad_link");
  assert.equal(await checkLink(KEY, tok, null, now), "bad_link");
  assert.equal(await checkLink(KEY, "garbage", row, now), "bad_link");
  assert.equal(await checkLink(KEY, tok, row, new Date("2026-11-27T00:00:00Z")), "expired");
  assert.equal(await checkLink(KEY, tok, { ...row, used_at: "2026-11-21T00:00:00Z" }, now), "used");
  await assert.rejects(() => signLink("short", row), /link key missing/);
});

test("scout request: brief, rejected kinds and known names are data blocks", () => {
  const s = scoutRequest({ brief: "Plumbers", count: 4, known: ["A (Carina)"], rejected: [{ industry: "Gym", suburb: null, reason: "not a fit" }], today: "2026-11-20" });
  assert.match(s, /Find 4 businesses/);
  assert.match(s, /<brief>\nPlumbers\n<\/brief>/);
  assert.match(s, /- Gym: not a fit/);
  assert.match(s, /A \(Carina\)/);
});
