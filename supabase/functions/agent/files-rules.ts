// Pure rules for the assistant's file tools (no network, no Deno): unit-tested in Node
// (supabase/tests/chat-files.test.mjs). The Drive calls live in files.ts.
//
// RULES
//  - The tools never delete or trash anything (there is no such call anywhere).
//  - More than 3 files moved or renamed in one turn needs the person's yes to a listed plan.
//  - File contents go to the model wrapped as data, capped at 20,000 characters.

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const READ_MAX = 20_000;
export const READ_DEFAULT = 12_000;
export const BULK_LIMIT = 3;
export const BULK_CONFIRMED_LIMIT = 20;
export const FILE_KINDS = ["any", "document", "spreadsheet", "slides", "pdf", "image", "folder"] as const;
export const ORIENT_TTL_MS = 3_600_000;

/** Hub deep link for a file or folder (the Files page opens it). */
export const hubLink = (id: string) => `#files/${encodeURIComponent(id)}`;

const STOP = new Set(("a an and are as at be by for from has have i in is it its me my of on or our the this that to was we with " +
  "file files doc docs document documents folder folders find show pull up open please can you where whats what's which " +
  "one some about any copy latest last recent new old version").split(" "));

/** Search words from a vague description: lower-case, no stop words, at most 5, longest first kept in order. */
export function searchWords(q: unknown): string[] {
  if (typeof q !== "string") return [];
  const words = q.toLowerCase().replace(/[\u0000-\u001f]/g, " ").split(/[^a-z0-9&'@._-]+/i)
    .map((w) => w.replace(/^[._'-]+|[._'-]+$/g, "")).filter((w) => w.length >= 2 && !STOP.has(w));
  const uniq = [...new Set(words)];
  if (uniq.length <= 5) return uniq;
  const keep = new Set([...uniq].sort((a, b) => b.length - a.length).slice(0, 5));
  return uniq.filter((w) => keep.has(w));
}

/** A value inside a Drive query literal. */
export const qv = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** Drive query clause for a kind of file ("" for any). */
export function kindClause(kind: unknown): string {
  switch (kind) {
    case "document": return `(mimeType = 'application/vnd.google-apps.document' or mimeType = 'application/msword' or mimeType contains 'wordprocessingml' or mimeType = 'text/plain' or mimeType = 'text/markdown')`;
    case "spreadsheet": return `(mimeType = 'application/vnd.google-apps.spreadsheet' or mimeType contains 'spreadsheetml' or mimeType = 'application/vnd.ms-excel' or mimeType = 'text/csv')`;
    case "slides": return `(mimeType = 'application/vnd.google-apps.presentation' or mimeType contains 'presentationml' or mimeType = 'application/vnd.ms-powerpoint')`;
    case "pdf": return `mimeType = 'application/pdf'`;
    case "image": return `mimeType contains 'image/'`;
    case "folder": return `mimeType = '${FOLDER_MIME}'`;
    default: return "";
  }
}

/**
 * Drive search query: every word must appear in the name or text ("all"), or any word ("any",
 * the looser second try). Never matches trashed files.
 */
export function buildQuery(words: string[], kind: unknown, mode: "all" | "any"): string | null {
  if (!words.length) return null;
  const parts = words.map((w) => `(name contains '${qv(w)}' or fullText contains '${qv(w)}')`);
  const text = parts.length === 1 ? parts[0] : `(${parts.join(mode === "all" ? " and " : " or ")})`;
  const k = kindClause(kind);
  return [text, k, "trashed = false"].filter(Boolean).join(" and ");
}

/** How well an item matches the words: name hits count most. Used to order search results. */
export function scoreItem(item: { name: string; modified?: string | null }, words: string[]): number {
  const n = item.name.toLowerCase();
  let s = 0;
  for (const w of words) if (n.includes(w)) s += 10;
  if (words.length && words.every((w) => n.includes(w))) s += 15;
  return s;
}

/** Folder path given by the person → segments. "WiseAI/Clients/Acme", "Clients > Acme", "/My Drive/X". */
export function splitPath(raw: unknown, homeName: string | null): { fromRoot: boolean; parts: string[] } {
  let s = typeof raw === "string" ? raw.trim() : "";
  let fromRoot = false;
  if (/^my drive\b/i.test(s)) { fromRoot = true; s = s.replace(/^my drive\s*/i, ""); }
  else if (s.startsWith("/")) fromRoot = true;
  const parts = s.split(/\s*(?:\/|>|›|\\)\s*/).map((p) => p.trim()).filter(Boolean);
  // A leading business-folder name means "inside the business folder" (it may repeat: WiseAI / WiseAI).
  if (!fromRoot && homeName) while (parts.length && parts[0].toLowerCase() === homeName.toLowerCase()) parts.shift();
  return { fromRoot, parts };
}

/** One path segment against the sub-folders of a folder: exact name, then a single partial match. */
export function matchFolder<T extends { name: string }>(want: string, folders: T[]):
  { ok: true; folder: T } | { ok: false; error: "none" | "ambiguous"; candidates: T[] } {
  const w = want.trim().toLowerCase();
  const exact = folders.filter((f) => f.name.trim().toLowerCase() === w);
  if (exact.length === 1) return { ok: true, folder: exact[0] };
  if (exact.length > 1) return { ok: false, error: "ambiguous", candidates: exact };
  const part = folders.filter((f) => f.name.toLowerCase().includes(w) || w.includes(f.name.toLowerCase()));
  if (part.length === 1) return { ok: true, folder: part[0] };
  if (part.length > 1) return { ok: false, error: "ambiguous", candidates: part };
  return { ok: false, error: "none", candidates: folders };
}

/**
 * Ancestor chain (nearest parent first, ending at the drive root) → path relative to the
 * business folder, and whether the item is inside it.
 */
export function placeOf(chain: { id: string; name: string }[], homeId: string | null, homeName: string | null): { inside: boolean; path: string } {
  if (!homeId) return { inside: true, path: ["My Drive", ...[...chain].reverse().slice(1).map((c) => c.name)].join(" / ") };
  const i = chain.findIndex((c) => c.id === homeId);
  if (i < 0) return { inside: false, path: ["My Drive", ...[...chain].reverse().slice(1).map((c) => c.name)].join(" / ") };
  const inner = chain.slice(0, i).reverse().map((c) => c.name);
  return { inside: true, path: [homeName || "Business folder", ...inner].join(" / ") };
}

/** Whether another move/rename is allowed this turn. */
export function bulkCheck(doneThisTurn: number, confirmed: boolean): { ok: true } | { ok: false; message: string } {
  if (!confirmed && doneThisTurn >= BULK_LIMIT) {
    return { ok: false, message: `That would be more than ${BULK_LIMIT} files moved or renamed in one go. Stop, list the whole plan (each file and where it goes or its new name) and ask the person to confirm. Only after they say yes, redo it with confirmed: true.` };
  }
  if (doneThisTurn >= BULK_CONFIRMED_LIMIT) return { ok: false, message: `At most ${BULK_CONFIRMED_LIMIT} file changes per message. Stop and tell the person what is left.` };
  return { ok: true };
}

/** How to get plain text out of a file, by kind. */
export type ReadPlan = { how: "export"; mime: string } | { how: "media" } | { how: "unsupported"; reason: string };
export function readPlan(kind: string, mime: string | null, size: number | null): ReadPlan {
  if (kind === "folder") return { how: "unsupported", reason: "It is a folder. Use find_files with this folder to list what is in it." };
  if (kind === "gdoc") return { how: "export", mime: "text/plain" };
  if (kind === "gslide") return { how: "export", mime: "text/plain" };
  if (kind === "gsheet") return { how: "export", mime: "text/csv" };
  const m = mime || "";
  const texty = kind === "text" || /^text\//.test(m) || /(json|xml|csv|markdown|yaml)/.test(m);
  if (texty) {
    if (size !== null && size > 5_000_000) return { how: "unsupported", reason: "It is a text file over 5 MB, too big to read here. Open it instead." };
    return { how: "media" };
  }
  if (kind === "pdf") return { how: "unsupported", reason: "PDFs cannot be read here yet. Give the person the Open link instead." };
  if (kind === "word" || kind === "excel" || kind === "powerpoint") {
    return { how: "unsupported", reason: "Word, Excel and PowerPoint files cannot be read here (only Google Docs, Sheets, Slides and text files). Give the person the Open link." };
  }
  if (kind === "image" || kind === "video" || kind === "audio") return { how: "unsupported", reason: `It is ${kind === "image" ? "an image" : `a ${kind} file`}; there is no text to read. Give the person the Open link.` };
  return { how: "unsupported", reason: "That type of file cannot be read here. Give the person the Open link." };
}

/** Text for the model: whitespace tidied, capped, flagged as data. */
export function capText(text: string, maxChars: unknown): { text: string; truncated: boolean; chars: number } {
  const max = Math.min(READ_MAX, Math.max(500, Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : READ_DEFAULT));
  const clean = text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return clean.length > max ? { text: clean.slice(0, max), truncated: true, chars: clean.length } : { text: clean, truncated: false, chars: clean.length };
}

/** Compact item for the model. */
export function fileRow(it: Row, path: string | null): Row {
  const out: Row = { id: it.id, name: it.name, kind: it.folder ? "folder" : it.kind };
  if (path) out.path = path;
  if (it.modified) out.modified = String(it.modified).slice(0, 10);
  if (it.modified_by) out.modified_by = it.modified_by;
  if (!it.folder && it.size) out.size_kb = Math.max(1, Math.round(Number(it.size) / 1024));
  out.open = hubLink(it.id);
  if (it.web_url) out.drive_url = it.web_url;
  return out;
}

/** The change entry a file change adds to the chat response (kind 'file'; undo with the same id). */
export function fileChange(ch: Row, chatId: string): Row {
  return {
    id: ch.id, kind: "file", at: ch.at, chat_id: chatId, table_name: "file_changes", row_id: ch.item_id, op: ch.op,
    summary: String(ch.summary ?? "").slice(0, 300), open: hubLink(String(ch.item_id)), undone_at: ch.undone_at ?? null,
    undoable: ch.op === "move" || ch.op === "rename",
  };
}

/** Orientation line for the context block. */
export function orientation(o: { connected: boolean; reconnect?: boolean; homeName: string | null; homePath: string | null; folders: string[]; looseFiles: number }): string {
  if (!o.connected) return o.reconnect
    ? "Business files (Google Drive): needs signing in again (the owner does it on the Files page). File tools will fail until then."
    : "Business files (Google Drive): not connected (it is set up on the Files page). File tools will fail until then.";
  const where = o.homeName ? `the "${o.homeName}" folder${o.homePath ? ` (${o.homePath})` : ""}` : "the top level of the Drive (no business folder chosen)";
  const list = o.folders.length ? o.folders.slice(0, 30).join(", ") + (o.folders.length > 30 ? `, and ${o.folders.length - 30} more` : "") : "none";
  return `Business files (Google Drive): all work lives in ${where}. Its top-level folders: ${list}. Loose files at its top level: ${o.looseFiles}.`;
}
