// Routing rules for the chat: tool groups, first model, escalation. node --test supabase/tests/chat-route.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { escalation, firstModel, modelSetting, namesSomething, needsPlanning, pickGroups, HAIKU, SONNET, OPUS } from "../functions/agent/chat-route.ts";
import { resultJson, stripWeekdays, weekdayOf } from "../functions/agent/chat-rules.ts";

const all = { files: true, email: true, calendar: true };

test("model setting: four values, older full ids still map", () => {
  assert.equal(modelSetting("auto"), "auto");
  assert.equal(modelSetting(undefined), "auto");
  assert.equal(modelSetting("claude-sonnet-5-5"), "sonnet");
  assert.equal(modelSetting("claude-haiku-5-5"), "haiku");
  assert.equal(modelSetting("opus"), "opus");
  assert.equal(modelSetting("nonsense"), "auto");
});

test("tool groups load only for what the message needs (and only when connected)", () => {
  assert.deepEqual(pickGroups("What are our running costs this month and is anything ending soon?", all), []);
  assert.deepEqual(pickGroups("How much are we owed?", all), []);
  assert.deepEqual(pickGroups("Create a client ZZCHAT Bakery", all), ["records"]);
  assert.deepEqual(pickGroups("Delete the ZZCHAT task", all), ["records"]);
  assert.deepEqual(pickGroups("Mark INV-002 as paid", all), ["records"]);
  assert.deepEqual(pickGroups("Any reply from the dentist in my email?", all), ["email"]);
  assert.deepEqual(pickGroups("Any reply from the dentist in my email?", { ...all, email: false }), []);
  assert.deepEqual(pickGroups("What is on tomorrow?", all), ["calendar"]);
  assert.deepEqual(pickGroups("Pull up the Harbour Dental proposal pdf", all), ["files"]);
  assert.deepEqual(pickGroups("Find me 10 new leads like Harbour Dental", all), ["scout"]);
});

test("first model: Haiku for ordinary turns on auto, Sonnet for planning, settings pin a model", () => {
  assert.equal(firstModel("auto", "Update ZZCHAT Smith's suburb to Carina", []).model, HAIKU);
  assert.equal(firstModel("auto", "Draft an email to Sam about the quote", ["email"]).reason, "drafting");
  assert.equal(firstModel("auto", "Organise the receipts in Inbox into Money", ["files"]).model, SONNET);
  const multi = "Create a client ZZCHAT Bakery in Wynnum, a job for their website due 12 Dec, then add a task for me to send the brief";
  assert.equal(firstModel("auto", multi, ["records"]).reason, "several changes");
  assert.equal(firstModel("auto", "Add a task to chase the invoice for the client", []).model, HAIKU);
  assert.equal(firstModel("sonnet", "hi there", []).model, SONNET);
  assert.equal(firstModel("haiku", multi, []).model, HAIKU);
  assert.equal(firstModel("opus", "hi", []).model, OPUS);
  assert.equal(needsPlanning("x".repeat(800), []), "long request");
});

test("escalation: refusals, empty answers, repeated tool errors, asking before looking", () => {
  const base = { finalText: "Done.", declined: false, toolErrors: 0, readCalls: 1, writeCalls: 1, message: "mark it done" };
  assert.equal(escalation(base), null);
  assert.equal(escalation({ ...base, declined: true }), "declined");
  assert.equal(escalation({ ...base, finalText: "", writeCalls: 0 }), "empty");
  assert.equal(escalation({ ...base, toolErrors: 2 }), "tool errors");
  // Asked a question without looking anything up, when the message names a record: pointless.
  assert.equal(escalation({ ...base, readCalls: 0, writeCalls: 0, finalText: "Which client is that?", message: "Is Harbour Dental overdue on anything?" }), "asked before looking");
  // A generic request where asking is right stays on Haiku.
  assert.equal(escalation({ ...base, readCalls: 0, writeCalls: 0, finalText: "Which client's invoice, who should chase it, and when?", message: "Add a task to chase the invoice" }), null);
  assert.equal(namesSomething("hi"), false);
  assert.equal(namesSomething("Set it for Friday please"), false);
  assert.equal(namesSomething("How much are we owed?"), true);
});

test("weekdays are computed in code: results carry them, inputs drop them", () => {
  assert.equal(weekdayOf("2026-11-30"), "Mon");
  assert.equal(weekdayOf("2026-12-15"), "Tue");
  assert.equal(resultJson({ d: "2026-11-30", t: "2026-11-29T23:30:00Z" }, "Australia/Brisbane"), '{"d":"Mon 2026-11-30","t":"Mon 2026-11-30 09:30"}');
  assert.deepEqual(stripWeekdays({ due_on: "Mon 2026-11-30", start: "Fri 2026-11-20 09:00", title: "Mon meeting" }),
    { due_on: "2026-11-30", start: "2026-11-20T09:00", title: "Mon meeting" });
});
