// Unit checks for removals: what can be removed, the per-message gate, containment, and the copy
// Undo puts back. Run: node --test supabase/tests/removals.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { REMOVABLE, REMOVE_SOFT_CAP, REMOVE_HARD_CAP, KIND_LABEL, removalBlocked, removalCap, restoreRow, taintCheck } from "../functions/agent/chat-rules.ts";
import { CHAT_TOOLS } from "../functions/agent/chat-prompt.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("what can be removed: never clients, never an opted-out lead, nothing other records point at", () => {
  assert.ok(!("clients" in REMOVABLE));
  assert.match(removalBlocked("clients", {}, {}), /archived/);
  assert.equal(removalBlocked("tasks", { id: "t" }, {}), null);
  assert.equal(removalBlocked("library", {}, {}), null);
  assert.equal(removalBlocked("costs", {}, {}), null);
  assert.match(removalBlocked("leads", { status: "dnc" }, {}), /opted out/);
  assert.match(removalBlocked("leads", { status: "new" }, { messages: 2 }), /2 messages.*archive/);
  assert.match(removalBlocked("leads", { status: "new" }, { bookings: 1, deals: 1 }), /bookings.*deals/);
  assert.equal(removalBlocked("leads", { status: "new" }, { messages: 0, bookings: 0 }), null);
  assert.match(removalBlocked("deals", {}, { projects: 1 }), /jobs/);
  assert.match(removalBlocked("projects", {}, { income: 1 }), /invoice/);
  assert.match(removalBlocked("projects", {}, { tasks: 3 }), /3 task\(s\).*with_tasks/);
  assert.equal(removalBlocked("projects", {}, { tasks: 3 }, true), null);
  assert.match(removalBlocked("invoices", { status: "paid" }, {}), /draft/);
  assert.equal(removalBlocked("invoices", { status: "draft" }, {}), null);
  assert.match(removalBlocked("proposals", { status: "sent" }, {}), /draft/);
  assert.match(removalBlocked("suppressions", {}, {}), /cannot remove/);
  assert.equal(KIND_LABEL.projects, "Job");
});

test("the gate: 3 a message, 20 only after the person says yes to a listed plan", () => {
  const plan = "These would go:\n- Call Sam\n- Send quote\n- Book visit\n- Chase invoice\nRemove all four?";
  assert.equal(removalCap("remove the four old tasks", null), REMOVE_SOFT_CAP);
  assert.equal(removalCap("yes", plan), REMOVE_HARD_CAP);
  assert.equal(removalCap("Yes please, remove them", plan), REMOVE_HARD_CAP);
  assert.equal(removalCap("yes", "Sure, which ones?"), REMOVE_SOFT_CAP);
  assert.equal(removalCap("no, keep them", plan), REMOVE_SOFT_CAP);
  assert.equal(removalCap(`yes ${"and also ".repeat(30)}`, plan), REMOVE_SOFT_CAP);
});

test("containment: no removal in a message that read outside text (lead notes, files, email, calendar)", () => {
  assert.match(taintCheck("remove", { kind: "tasks" }, { tainted: true, writesAfterTaint: 0 }), /removals/);
  assert.match(taintCheck("remove", { kind: "tasks" }, { tainted: true, writesAfterTaint: 0, mailTainted: true }), /read email/);
  assert.equal(taintCheck("remove", { kind: "tasks" }, { tainted: false, writesAfterTaint: 0 }), null);
});

test("undo copy: the same id and original timestamps, bookkeeping dropped", () => {
  const before = { id: "11111111-2222-4333-8444-555555555555", title: "Call Sam", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-02T00:00:00Z", _children: { events: [{ id: 1 }] } };
  assert.deepEqual(restoreRow(before), { id: before.id, title: "Call Sam", created_at: before.created_at, updated_at: before.updated_at });
  assert.equal(restoreRow(null), null);
  assert.equal(restoreRow({ title: "no id" }), null);
});

test("the remove tool exists, is described with Undo, and goes through one audited path", () => {
  const t = CHAT_TOOLS.find((x) => x.name === "remove");
  assert.ok(t);
  assert.deepEqual(t.input_schema.properties.kind.enum.sort(), Object.keys(REMOVABLE).sort());
  assert.ok(!t.input_schema.properties.kind.enum.includes("clients"));
  assert.equal(t.defer_loading, true, "remove loads with the records group");
  const src = readFileSync(join(ROOT, "functions/agent/chat.ts"), "utf8");
  // Only deleteAudited deletes a hub record on the model's behalf (undo's own-insert removal aside).
  const deletes = src.match(/\.delete\(\)\.eq\("id", row\.id\)/g) || [];
  assert.equal(deletes.length, 1);
  assert.match(src, /op: "delete", before, after: null/);
  assert.match(src, /if \(ch\.op === "delete"\) return await undoRemoval/);
});
