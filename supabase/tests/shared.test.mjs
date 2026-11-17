// Unit checks for the pure shared helpers (no network, dummy secrets only).
// Run: node --test supabase/tests/   (Node >= 22.18, which strips TypeScript types natively)
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { normalisePhone, AU_MOBILE } from "../functions/_shared/phone.ts";
import { renderTemplate, ensureCompliance, hasOptOut, formatValue } from "../functions/_shared/template.ts";
import { twilioSignature, validTwilioSignature, calSignature, validCalSignature } from "../functions/_shared/crypto.ts";
import { localParts, startOfLocalDay, windowOpen } from "../functions/_shared/time.ts";

test("normalisePhone", () => {
  assert.equal(normalisePhone("0412 345 678"), "+61412345678");
  assert.equal(normalisePhone("(04) 1234-5678"), "+61412345678");
  assert.equal(normalisePhone("61412345678"), "+61412345678");
  assert.equal(normalisePhone("+61 0412 345 678"), "+61412345678");
  assert.equal(normalisePhone("+61412345678"), "+61412345678");
  assert.equal(normalisePhone("+61 7 3123 4567"), "+61731234567"); // valid E.164, not a mobile
  assert.equal(AU_MOBILE.test("+61731234567"), false);
  assert.equal(normalisePhone("07 3123 4567"), null);
  assert.equal(normalisePhone("hello"), null);
  assert.equal(normalisePhone(""), null);
  assert.equal(normalisePhone(null), null);
});

test("renderTemplate", () => {
  const s = { sender_name: "Wise AI", optout_text: "Reply STOP to opt out", booking_url: "https://x.au/b" };
  const lead = { contact_name: "  Jess  Smith", business: "Acme Plumbing", hook: "Saw your reviews.", est_monthly_value: 2400, suburb: "" };
  assert.equal(
    renderTemplate("Hi {first_name}, {hook} {business} {value} {suburb} {booking_url} {sender} {unknown}", lead, s),
    "Hi Jess, Saw your reviews. Acme Plumbing $2,400 https://x.au/b Wise AI {unknown}",
  );
  assert.equal(renderTemplate("Hi {first_name} at {business}{value}.", {}, s), "Hi there at your business.");
  assert.equal(formatValue(12345.6), "$12,346");
  assert.equal(formatValue(null), "");
});

test("compliance tail", () => {
  const s = { sender_name: "Wise AI", optout_text: "Reply STOP to opt out" };
  assert.equal(ensureCompliance("Hi Jess", s), "Hi Jess - Wise AI Reply STOP to opt out");
  assert.equal(ensureCompliance("Hi, wise ai here. Reply STOP to opt out", s), "Hi, wise ai here. Reply STOP to opt out");
  // "stop losing jobs" is not an opt-out instruction
  assert.equal(ensureCompliance("Wise AI can help you stop losing jobs", s), "Wise AI can help you stop losing jobs Reply STOP to opt out");
  assert.equal(hasOptOut("text stop to opt out"), true);
  assert.equal(hasOptOut("Send STOP"), true);
});

test("twilio signature (HMAC-SHA1, sorted params, base64)", async () => {
  const token = "dummy_auth_token_for_tests";
  const url = "https://adfgtlhryyyrqbbgbfmx.supabase.co/functions/v1/twilio-webhook";
  const params = new URLSearchParams({ To: "+61400000000", From: "+61412345678", Body: "Hi there", MessageSid: "SM123", AccountSid: "AC1" });
  // Independent reference implementation with node:crypto.
  const data = url + [...params.keys()].sort().map((k) => k + params.get(k)).join("");
  const expected = createHmac("sha1", token).update(data).digest("base64");
  assert.equal(await twilioSignature(token, url, params), expected);
  assert.equal(await validTwilioSignature(token, url, params, expected), true);
  assert.equal(await validTwilioSignature(token, url, params, expected.slice(0, -2) + "xx"), false);
  assert.equal(await validTwilioSignature(token, url + "?x=1", params, expected), false);
  assert.equal(await validTwilioSignature(undefined, url, params, expected), false);
  assert.equal(await validTwilioSignature(token, url, params, null), false);
  // Twilio's documented example
  const ex = new URLSearchParams({ CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" });
  assert.equal(await twilioSignature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", ex), "0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
});

test("cal signature (hex HMAC-SHA256 of raw body)", async () => {
  const secret = "dummy_cal_secret";
  const raw = JSON.stringify({ triggerEvent: "BOOKING_CREATED", payload: { uid: "abc" } });
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  assert.equal(await calSignature(secret, raw), expected);
  assert.equal(await validCalSignature(secret, raw, expected), true);
  assert.equal(await validCalSignature(secret, raw, expected.toUpperCase()), true);
  assert.equal(await validCalSignature(secret, raw + " ", expected), false);
  assert.equal(await validCalSignature(undefined, raw, expected), false);
  assert.equal(await validCalSignature(secret, raw, null), false);
});

test("timezone maths", () => {
  const tz = "Australia/Brisbane"; // UTC+10, no DST
  const t = new Date("2026-11-16T22:30:00Z"); // Tue 17 Nov 08:30 local
  const l = localParts(t, tz);
  assert.deepEqual([l.year, l.month, l.day, l.hour, l.isoWeekday], [2026, 11, 17, 8, 2]);
  assert.equal(startOfLocalDay(t, tz).toISOString(), "2026-11-16T14:00:00.000Z");
  const s = { timezone: tz, send_start_hour: 9, send_end_hour: 17, send_days: [1, 2, 3, 4, 5] };
  assert.equal(windowOpen(t, s), false); // 08:30
  assert.equal(windowOpen(new Date("2026-11-16T23:00:00Z"), s), true); // 09:00 Tue
  assert.equal(windowOpen(new Date("2026-11-17T07:00:00Z"), s), false); // 17:00 Tue
  assert.equal(windowOpen(new Date("2026-11-21T01:00:00Z"), s), false); // Sat 11:00
  // DST zone: Sydney on a DST day (UTC+11)
  assert.equal(startOfLocalDay(new Date("2026-11-17T05:00:00Z"), "Australia/Sydney").toISOString(), "2026-11-16T13:00:00.000Z");
  // the day DST starts in Sydney (4 Oct 2026, 02:00 -> 03:00): midnight was still UTC+10
  assert.equal(startOfLocalDay(new Date("2026-10-04T05:00:00Z"), "Australia/Sydney").toISOString(), "2026-10-03T14:00:00.000Z");
});
