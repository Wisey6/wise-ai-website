// Unit checks for the assistant's file tools' pure parts (no network, no Drive, no model).
// Run: node --test supabase/tests/chat-files.test.mjs   (Node >= 22.18 strips TypeScript types natively)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as R from "../functions/agent/files-rules.ts";
import { CHAT_SYSTEM, CHAT_TOOLS } from "../functions/agent/chat-prompt.ts";

test("search words drop filler and keep at most five", () => {
  assert.deepEqual(R.searchWords("can you find the proposal for the dental clinic"), ["proposal", "dental", "clinic"]);
  assert.deepEqual(R.searchWords("  "), []);
  assert.deepEqual(R.searchWords(42), []);
  const many = R.searchWords("alpha bravo charlie delta echo foxtrot golfing");
  assert.equal(many.length, 5);
  assert.ok(many.includes("foxtrot") && many.includes("golfing"));
});

test("Drive queries escape quotes, AND or OR the words, add the kind and never match trash", () => {
  const q = R.buildQuery(["o'brien", "quote"], "pdf", "all");
  assert.equal(q, "((name contains 'o\\'brien' or fullText contains 'o\\'brien') and (name contains 'quote' or fullText contains 'quote')) and mimeType = 'application/pdf' and trashed = false");
  assert.match(R.buildQuery(["a1", "b2"], "any", "any"), / or \(name contains 'b2'/);
  assert.equal(R.buildQuery([], "any", "all"), null);
  assert.match(R.kindClause("spreadsheet"), /spreadsheet/);
  assert.equal(R.kindClause("any"), "");
  assert.equal(R.kindClause("rm -rf"), "");
});

test("results with every word in the name rank first", () => {
  const w = ["dental", "proposal"];
  assert.ok(R.scoreItem({ name: "Dental proposal v2" }, w) > R.scoreItem({ name: "Proposal template" }, w));
  assert.equal(R.scoreItem({ name: "notes" }, w), 0);
});

test("folder paths are read inside the business folder", () => {
  assert.deepEqual(R.splitPath("Clients/Acme", "WiseAI"), { fromRoot: false, parts: ["Clients", "Acme"] });
  assert.deepEqual(R.splitPath("WiseAI / WiseAI / Clients > Acme", "WiseAI"), { fromRoot: false, parts: ["Clients", "Acme"] });
  assert.deepEqual(R.splitPath("My Drive/ZZ test/Sub", "WiseAI"), { fromRoot: true, parts: ["ZZ test", "Sub"] });
  assert.deepEqual(R.splitPath("/Top", null), { fromRoot: true, parts: ["Top"] });
  assert.deepEqual(R.splitPath("", "WiseAI"), { fromRoot: false, parts: [] });
});

test("a folder name matches exactly, then by a single partial; else candidates", () => {
  const f = [{ name: "Clients" }, { name: "Client templates" }, { name: "Receipts" }];
  assert.equal(R.matchFolder("clients", f).folder.name, "Clients");
  assert.equal(R.matchFolder("receipt", f).folder.name, "Receipts");
  const amb = R.matchFolder("client", f);
  assert.equal(amb.ok, false);
  assert.equal(amb.error, "ambiguous");
  assert.equal(amb.candidates.length, 2);
  assert.equal(R.matchFolder("Invoices", f).error, "none");
});

test("place of an item: inside the business folder or not, with a readable path", () => {
  const chain = [{ id: "c", name: "Acme" }, { id: "b", name: "Clients" }, { id: "home", name: "WiseAI" }, { id: "w", name: "WiseAI" }, { id: "root", name: "My Drive" }];
  assert.deepEqual(R.placeOf(chain, "home", "WiseAI"), { inside: true, path: "WiseAI / Clients / Acme" });
  const out = [{ id: "x", name: "Other" }, { id: "root", name: "My Drive" }];
  assert.deepEqual(R.placeOf(out, "home", "WiseAI"), { inside: false, path: "My Drive / Other" });
  assert.deepEqual(R.placeOf(out, null, null), { inside: true, path: "My Drive / Other" });
});

test("more than 3 file moves or renames in one turn needs a confirmed plan", () => {
  assert.equal(R.bulkCheck(0, false).ok, true);
  assert.equal(R.bulkCheck(2, false).ok, true);
  const no = R.bulkCheck(3, false);
  assert.equal(no.ok, false);
  assert.match(no.message, /list the whole plan/);
  assert.equal(R.bulkCheck(3, true).ok, true);
  assert.equal(R.bulkCheck(R.BULK_CONFIRMED_LIMIT, true).ok, false);
});

test("read plans: Google files export, text downloads, the rest is said plainly", () => {
  assert.deepEqual(R.readPlan("gdoc", "application/vnd.google-apps.document", null), { how: "export", mime: "text/plain" });
  assert.deepEqual(R.readPlan("gsheet", null, null), { how: "export", mime: "text/csv" });
  assert.deepEqual(R.readPlan("gslide", null, null), { how: "export", mime: "text/plain" });
  assert.deepEqual(R.readPlan("text", "text/plain", 1000), { how: "media" });
  assert.deepEqual(R.readPlan("file", "application/json", 1000), { how: "media" });
  assert.equal(R.readPlan("text", "text/plain", 9_000_000).how, "unsupported");
  for (const k of ["pdf", "word", "excel", "image", "folder", "file"]) {
    const p = R.readPlan(k, k === "pdf" ? "application/pdf" : "application/octet-stream", 10);
    assert.equal(p.how, "unsupported", k);
    assert.ok(p.reason.length > 10);
  }
});

test("file text is tidied and capped at 20,000 characters", () => {
  const long = "x".repeat(30_000);
  assert.equal(R.capText(long, 99_999).text.length, R.READ_MAX);
  assert.equal(R.capText(long, undefined).text.length, R.READ_DEFAULT);
  assert.equal(R.capText(long, 10).text.length, 500);
  const c = R.capText("a  \r\n\r\n\r\n\r\nb\u0000", 1000);
  assert.deepEqual(c, { text: "a\n\nb", truncated: false, chars: 4 });
});

test("file rows and file changes have the documented shapes", () => {
  const it = { id: "abcDEF1234567890xyz", name: "Plan.gdoc", folder: false, kind: "gdoc", modified: "2026-11-01T02:03:04Z", size: 2048, web_url: "https://docs.google.com/x" };
  assert.deepEqual(R.fileRow(it, "WiseAI / Plans"), {
    id: it.id, name: "Plan.gdoc", kind: "gdoc", path: "WiseAI / Plans", modified: "2026-11-01", size_kb: 2, open: "#files/abcDEF1234567890xyz", drive_url: "https://docs.google.com/x",
  });
  const ch = R.fileChange({ id: "c1", at: "2026-11-18T00:00:00Z", item_id: "abcDEF1234567890xyz", op: "move", summary: "Moved Plan from A to B" }, "chat1");
  assert.deepEqual(ch, {
    id: "c1", kind: "file", at: "2026-11-18T00:00:00Z", chat_id: "chat1", table_name: "file_changes", row_id: "abcDEF1234567890xyz", op: "move",
    summary: "Moved Plan from A to B", open: "#files/abcDEF1234567890xyz", undone_at: null, undoable: true,
  });
  assert.equal(R.fileChange({ id: "c2", item_id: "f", op: "create_folder" }, "c").undoable, false);
});

test("orientation line: connected, not connected, needs reconnecting", () => {
  const on = R.orientation({ connected: true, homeName: "WiseAI", homePath: "My Drive / WiseAI / WiseAI", folders: ["Clients", "Receipts"], looseFiles: 2 });
  assert.match(on, /"WiseAI" folder \(My Drive \/ WiseAI \/ WiseAI\)/);
  assert.match(on, /Clients, Receipts/);
  assert.match(R.orientation({ connected: false, homeName: null, homePath: null, folders: [], looseFiles: 0 }), /not connected .*Files page/);
  assert.match(R.orientation({ connected: false, reconnect: true, homeName: null, homePath: null, folders: [], looseFiles: 0 }), /signing in again/);
  const many = R.orientation({ connected: true, homeName: "H", homePath: null, folders: Array.from({ length: 40 }, (_, i) => `F${i}`), looseFiles: 0 });
  assert.match(many, /and 10 more/);
});

test("the prompt knows the business folder and the file tools are defined and strict-safe", () => {
  assert.match(CHAT_SYSTEM, /ONE Google Drive folder/);
  assert.match(CHAT_SYSTEM, /never delete or trash a file/);
  assert.match(CHAT_SYSTEM, /more than 3 files/i);
  const names = CHAT_TOOLS.map((t) => t.name);
  for (const n of ["find_files", "open_file", "read_file", "organise_file", "new_folder", "link_file"]) assert.ok(names.includes(n), n);
  assert.deepEqual(names, [...names].sort(), "tools sorted for a stable prompt cache");
  // The API allows at most 24 optional parameters across strict tools.
  const optional = CHAT_TOOLS.filter((t) => t.strict).reduce((n, t) => n + Object.keys(t.input_schema.properties).length - t.input_schema.required.length, 0);
  assert.ok(optional <= 24, `strict optional params ${optional}`);
  // Nothing in the file tools deletes or trashes.
  const src = readFileSync(new URL("../functions/agent/files.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /trashed\s*[:=]\s*true|\.delete\(|"DELETE"/);
});
