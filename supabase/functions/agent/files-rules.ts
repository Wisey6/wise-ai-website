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
export function bulkCheck(doneThisTurn: number, _confirmed?: boolean): { ok: true } | { ok: false; message: string } {
  // A hard cap: the model's own "confirmed" is not a gate, so more than BULK_LIMIT moves or renames
  // always take another message from the person.
  if (doneThisTurn >= BULK_LIMIT) {
    return { ok: false, message: `At most ${BULK_LIMIT} files can be moved or renamed in one message. Stop now: say what you did, list the rest of the plan (each file and where it goes or its new name) and ask the person to say go in their next message.` };
  }
  return { ok: true };
}

/** True when an item (its own id plus its ancestors' ids) sits inside the home folder (or is it). No home: anything goes. */
export function insideHome(ids: string[], homeId: string | null): boolean {
  if (!homeId) return true;
  return ids.includes(homeId);
}

/** How to get plain text out of a file, by kind. */
export type ReadPlan = { how: "export"; mime: string } | { how: "media" } | { how: "docx" } | { how: "unsupported"; reason: string };
export function readPlan(kind: string, mime: string | null, size: number | null): ReadPlan {
  if (kind === "folder") return { how: "unsupported", reason: "It is a folder. Use find_files with this folder to list what is in it." };
  if (kind === "gdoc") return { how: "export", mime: "text/plain" };
  if (kind === "gslide") return { how: "export", mime: "text/plain" };
  if (kind === "gsheet") return { how: "export", mime: "text/csv" };
  const m = mime || "";
  if (kind === "word" && /wordprocessingml/.test(m)) {
    if (size !== null && size > 15_000_000) return { how: "unsupported", reason: "It is a Word file over 15 MB, too big to read here. Give the person the Open link." };
    return { how: "docx" };
  }
  const texty = kind === "text" || /^text\//.test(m) || /(json|xml|csv|markdown|yaml)/.test(m);
  if (texty) {
    if (size !== null && size > 5_000_000) return { how: "unsupported", reason: "It is a text file over 5 MB, too big to read here. Open it instead." };
    return { how: "media" };
  }
  if (kind === "pdf") return { how: "unsupported", reason: "PDFs cannot be read here yet. Give the person the Open link instead." };
  if (kind === "word" || kind === "excel" || kind === "powerpoint") {
    return { how: "unsupported", reason: "Older Word (.doc), Excel and PowerPoint files cannot be read here (Google Docs, Sheets, Slides, .docx and text files can). Give the person the Open link." };
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

// ------------------------------------------------------------------ .docx text (Word files)

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** One file out of a zip archive (stored or deflated), or null. Uses the central directory. */
export async function unzipEntry(zip: Uint8Array, want: string, maxOut = 20 * 1024 * 1024): Promise<Uint8Array | null> {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (u32(zip, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = u16(zip, eocd + 10);
  let p = u32(zip, eocd + 16);
  const dec = new TextDecoder();
  for (let n = 0; n < count && p + 46 <= zip.length; n++) {
    if (u32(zip, p) !== 0x02014b50) return null;
    const method = u16(zip, p + 10), csize = u32(zip, p + 20), usize = u32(zip, p + 24);
    const nameLen = u16(zip, p + 28), extraLen = u16(zip, p + 30), commentLen = u16(zip, p + 32), local = u32(zip, p + 42);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== want) continue;
    if (usize > maxOut || u32(zip, local) !== 0x04034b50) return null;
    const start = local + 30 + u16(zip, local + 26) + u16(zip, local + 28);
    const data = zip.subarray(start, start + csize);
    if (method === 0) return data.slice();
    if (method !== 8) return null;
    // Streamed, and stopped at maxOut whatever the header claims (a zip bomb lies about usize).
    const reader = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxOut) { await reader.cancel().catch(() => {}); return null; }
      parts.push(value);
    }
    const all = new Uint8Array(total);
    let o = 0;
    for (const v of parts) { all.set(v, o); o += v.length; }
    return all;
  }
  return null;
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
/** Plain text of a Word document's main XML: paragraphs on their own lines, tabs and breaks kept. */
export function docxXmlText(xml: string): string {
  return xml
    .replace(/<w:tab\/>/g, "\t").replace(/<w:(br|cr)\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n").replace(/<\/w:tr>/g, "\n").replace(/<\/w:tc>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") { const c = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(c) ? String.fromCodePoint(c) : m; }
      return ENT[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Text of a .docx file's bytes, or null when it is not a readable Word document. */
export async function docxText(bytes: Uint8Array): Promise<string | null> {
  const xml = await unzipEntry(bytes, "word/document.xml");
  return xml ? docxXmlText(new TextDecoder().decode(xml)) : null;
}
