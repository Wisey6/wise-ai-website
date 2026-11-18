// Pure rules for the assistant's email tools (agent/mail.ts): the Gmail search string built from
// structured fields, message bodies decoded and turned into plain text, compact rows, caps,
// draft checks and the MIME message for a draft. No Deno APIs, so Node unit-tests it
// (supabase/tests/mail.test.mjs).
import { Refusal } from "./chat-rules.ts";
import { type Addr, MAX_RECIPIENTS, parseAddress } from "../_shared/gmail.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
const fail = (m: string): never => { throw new Refusal(m); };

export const SEARCH_DEFAULT = 10;
export const SEARCH_MAX = 25;
export const SNIPPET_MAX = 160;
export const READ_MAX = 12_000;
export const THREAD_TOTAL_MAX = 16_000;
export const THREAD_MIN_PER = 1_500;
export const SUBJECT_MAX = 200;
export const BODY_MAX = 8_000;

/* ------------------------------------------------------------------ search */

/**
 * A Gmail search string from structured fields only. Every value the model gives is wrapped in
 * double quotes with quotes, braces, brackets and parentheses removed, so it is matched as text
 * and can never add an operator (in:trash, OR, -label:…, {…}). Only the operators below are ever
 * produced.
 */
export function quoteTerm(v: unknown, max = 120): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f"“”{}()[\]\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
  return s ? `"${s}"` : null;
}
export function buildGmailQuery(input: Row): string {
  const parts: string[] = [];
  const words = typeof input.query === "string" ? input.query : "";
  if (words.trim()) {
    // Free words: each word quoted on its own (all must match, any order).
    const ws = words.replace(/[\u0000-\u001f"“”{}()[\]\\]/g, " ").split(/\s+/).filter(Boolean).slice(0, 12);
    for (const w of ws) { const q = quoteTerm(w, 60); if (q) parts.push(q); }
  }
  for (const [field, op] of [["from", "from"], ["to", "to"], ["subject", "subject"]] as const) {
    if (input[field] === undefined || input[field] === null || input[field] === "") continue;
    const q = quoteTerm(input[field]);
    if (!q) fail(`${field} must be some text`);
    parts.push(`${op}:${q}`);
  }
  if (input.newer_than_days !== undefined && input.newer_than_days !== null) {
    const n = Number(input.newer_than_days);
    if (!Number.isInteger(n) || n < 1 || n > 3650) fail("newer_than_days must be a whole number of days from 1 to 3650");
    parts.push(`newer_than:${n}d`);
  }
  if (input.unread === true) parts.push("is:unread");
  if (input.unread === false) parts.push("is:read");
  if (input.has_attachment === true) parts.push("has:attachment");
  return parts.join(" ");
}
export function searchLimit(v: unknown): number {
  const n = Number.isInteger(v) ? Number(v) : SEARCH_DEFAULT;
  return Math.max(1, Math.min(SEARCH_MAX, n));
}

/* ------------------------------------------------------------------ decoding */

export function b64urlToBytes(data: string): Uint8Array {
  const s = String(data || "").replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/]/g, "");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
export function decodeBytes(bytes: Uint8Array, charset?: string | null): string {
  let label = String(charset || "utf-8").trim().replace(/^["']|["']$/g, "").toLowerCase();
  if (!label || label === "us-ascii" || label === "ascii") label = "utf-8";
  try { return new TextDecoder(label, { fatal: false }).decode(bytes); } catch { return new TextDecoder("utf-8", { fatal: false }).decode(bytes); }
}
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", bull: "•", middot: "·", eacute: "é", zwnj: "", zwj: "" };
export function decodeEntities(s: string): string {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}
/** HTML email → readable plain text (no tags, no scripts, styles or hidden head). */
export function htmlToText(html: string): string {
  let s = String(html ?? "");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|head|title|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<\/(p|div|tr|ul|ol|h[1-6]|table|blockquote|section|article|header|footer)\s*>/gi, "\n");
  s = s.replace(/<(p|div|tr|h[1-6]|table|blockquote)\b[^>]*>/gi, "\n");
  s = s.replace(/<\/t[dh]\s*>/gi, " ");
  s = s.replace(/<a\b[^>]*href\s*=\s*["']?(https?:[^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, href: string, label: string) => {
    const l = label.replace(/<[^>]+>/g, "").trim();
    return l && !l.includes(href) ? `${l} (${href})` : href;
  });
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return tidy(s);
}
export function tidy(s: string): string {
  return String(s ?? "").replace(/\r\n?/g, "\n").replace(/[\u200b\u200c\u200d\ufeff]/g, "").replace(/[ \t\u00a0]+/g, " ")
    .split("\n").map((l) => l.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export type Part = { mimeType?: string; filename?: string; headers?: { name: string; value: string }[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: Part[] };
export function headerOf(p: { headers?: { name: string; value: string }[] } | null | undefined, name: string): string {
  const h = (p?.headers ?? []).find((x) => String(x?.name).toLowerCase() === name.toLowerCase());
  return h ? String(h.value ?? "") : "";
}
const charsetOf = (p: Part) => /charset\s*=\s*"?([^";\s]+)/i.exec(headerOf(p, "Content-Type"))?.[1] ?? null;

/**
 * The text of a message: text/plain preferred, else the HTML part as text. Attachments are
 * listed by name and size only (their bytes are never fetched).
 */
export function extractBody(payload: Part | null | undefined): { text: string; format: "plain" | "html" | "none"; attachments: { name: string; size: number; type: string }[] } {
  const plains: string[] = [], htmls: string[] = [];
  const attachments: { name: string; size: number; type: string }[] = [];
  const walk = (p: Part | undefined, depth: number) => {
    if (!p || depth > 12) return;
    const mime = String(p.mimeType ?? "").toLowerCase();
    const disp = headerOf(p, "Content-Disposition").toLowerCase();
    if (p.filename || p.body?.attachmentId || disp.startsWith("attachment")) {
      if (p.filename || disp.startsWith("attachment")) attachments.push({ name: String(p.filename || "attachment").slice(0, 200), size: Number(p.body?.size) || 0, type: mime || "application/octet-stream" });
      return;
    }
    if (Array.isArray(p.parts) && p.parts.length) { for (const c of p.parts) walk(c, depth + 1); return; }
    if (!p.body?.data) return;
    const text = decodeBytes(b64urlToBytes(p.body.data), charsetOf(p));
    if (mime === "text/plain" || (!mime && depth === 0)) plains.push(text);
    else if (mime === "text/html") htmls.push(text);
  };
  walk(payload ?? undefined, 0);
  if (plains.join("").trim()) return { text: tidy(plains.join("\n\n")), format: "plain", attachments };
  if (htmls.length) return { text: htmlToText(htmls.join("\n")), format: "html", attachments };
  return { text: "", format: "none", attachments };
}

export function capText(text: string, max: number): { text: string; truncated: boolean; chars: number } {
  const t = String(text ?? "");
  return t.length > max ? { text: `${t.slice(0, max)}…`, truncated: true, chars: t.length } : { text: t, truncated: false, chars: t.length };
}
/** Each message's share when a thread is read (total capped). */
export function perMessageCap(count: number): number {
  return Math.max(THREAD_MIN_PER, Math.floor(THREAD_TOTAL_MAX / Math.max(1, count)));
}

function person(header: string): { name: string | null; address: string | null } {
  const raw = String(header ?? "").trim();
  const m = /^(.*?)<\s*([^<>\s]+)\s*>\s*$/.exec(raw);
  const address = (m ? m[2] : raw).trim().toLowerCase();
  const name = m ? decodeEntities(m[1].replace(/^["'\s]+|["'\s]+$/g, "")).trim() || null : null;
  return { name, address: address.includes("@") ? address.slice(0, 200) : null };
}
const isoOf = (msg: Row) => {
  const ms = Number(msg.internalDate);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
};

/** One search result row (the model sees addresses: it needs them to tell senders apart). */
export function compactMessage(msg: Row): Row {
  const p = (msg.payload ?? {}) as Part;
  const labels: string[] = Array.isArray(msg.labelIds) ? msg.labelIds : [];
  const from = person(headerOf(p, "From"));
  const snippet = decodeEntities(String(msg.snippet ?? "")).replace(/\s+/g, " ").trim();
  return {
    id: String(msg.id), thread_id: String(msg.threadId ?? ""),
    from_name: from.name, from_address: from.address,
    subject: headerOf(p, "Subject").replace(/\s+/g, " ").trim().slice(0, 200) || "(no subject)",
    date: isoOf(msg),
    snippet: snippet.length > SNIPPET_MAX ? `${snippet.slice(0, SNIPPET_MAX - 1)}…` : snippet,
    unread: labels.includes("UNREAD"),
    has_attachments: /^multipart\/mixed/i.test(String(p.mimeType ?? "")),
    ...(labels.includes("SENT") ? { sent_by_you: true } : {}),
    ...(labels.includes("DRAFT") ? { draft: true } : {}),
  };
}

/** One message read in full: headers, plain-text body (capped), attachment names and sizes. */
export function readableMessage(msg: Row, max = READ_MAX): Row {
  const p = (msg.payload ?? {}) as Part;
  const b = extractBody(p);
  const c = capText(b.text, max);
  const labels: string[] = Array.isArray(msg.labelIds) ? msg.labelIds : [];
  return {
    id: String(msg.id), thread_id: String(msg.threadId ?? ""),
    from: headerOf(p, "From").slice(0, 300), to: headerOf(p, "To").slice(0, 600), cc: headerOf(p, "Cc").slice(0, 600) || undefined,
    subject: headerOf(p, "Subject").slice(0, 300) || "(no subject)", date: isoOf(msg),
    unread: labels.includes("UNREAD"), ...(labels.includes("SENT") ? { sent_by_you: true } : {}),
    body_format: b.format, chars: c.chars, truncated: c.truncated,
    body: c.text || "(no text in this email)",
    attachments: b.attachments.map((a) => ({ name: a.name, size_kb: Math.max(1, Math.round(a.size / 1024)), type: a.type })),
  };
}

/* ------------------------------------------------------------------ drafts */

export type DraftInput = { to: Addr[]; cc: Addr[]; subject: string; body: string };

function addrList(v: unknown, field: string): Addr[] {
  if (v === undefined || v === null || v === "") return [];
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;]/) : fail(`${field} must be a list of email addresses`);
  const out: Addr[] = [];
  for (const raw of arr as unknown[]) {
    if (typeof raw === "string" && !raw.trim()) continue;
    const a = parseAddress(raw);
    if (!a) fail(`"${String(raw).slice(0, 80)}" in ${field} is not an email address the hub can use`);
    if (!out.some((x) => x.address === a!.address)) out.push(a!);
  }
  return out;
}
/** Checks a draft: real addresses, at most 10 recipients, subject ≤ 200, body ≤ 8,000, no attachments. */
export function checkDraft(input: Row, o: { reply?: boolean } = {}): DraftInput {
  if (input.attachments !== undefined || input.attachment !== undefined) fail("Attachments cannot be added from the hub yet. Say the person can add them in Gmail with Edit in Gmail.");
  const to = addrList(input.to, "to");
  const cc = addrList(input.cc, "cc").filter((a) => !to.some((t) => t.address === a.address));
  if (!o.reply && !to.length) fail("who is it to? give at least one email address in to");
  if (to.length + cc.length > MAX_RECIPIENTS) fail(`at most ${MAX_RECIPIENTS} recipients in one email; the hub does not bulk-mail`);
  const subject = typeof input.subject === "string" ? input.subject.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim() : "";
  if (!o.reply && !subject) fail("the email needs a subject");
  if (subject.length > SUBJECT_MAX) fail(`the subject is ${subject.length} characters; keep it to ${SUBJECT_MAX}`);
  const body = typeof input.body === "string" ? input.body.replace(/\r\n?/g, "\n").trim() : "";
  if (!body) fail("the email is empty");
  if (body.length > BODY_MAX) fail(`the email is ${body.length} characters; keep it to ${BODY_MAX.toLocaleString("en-AU")}`);
  return { to, cc, subject, body };
}
export function replySubject(original: string): string {
  const s = String(original ?? "").replace(/[\r\n\t]+/g, " ").trim();
  return /^re\s*:/i.test(s) ? s : `Re: ${s || "(no subject)"}`.slice(0, 300);
}

/* ------------------------------------------------------------------ MIME */

function utf8Base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function b64urlString(s: string): string {
  return utf8Base64(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const wrap76 = (b64: string) => b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();
/** RFC 2047 encoded word for a header value that is not plain ASCII. */
export function encodeHeader(v: string): string {
  const s = String(v ?? "").replace(/[\r\n]+/g, " ");
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  // Split into chunks so each encoded word stays short (whole characters per chunk).
  const chars = [...s];
  const words: string[] = [];
  for (let i = 0; i < chars.length; i += 15) words.push(`=?UTF-8?B?${utf8Base64(chars.slice(i, i + 15).join(""))}?=`);
  return words.join("\r\n ");
}
export function formatAddr(a: Addr): string {
  if (!a.name) return a.address;
  return /^[\x20-\x7e]*$/.test(a.name) ? `"${a.name.replace(/["\\]/g, "")}" <${a.address}>` : `${encodeHeader(a.name)} <${a.address}>`;
}
const MSGID = /^<[^<>\s]{1,250}>$/;
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
/**
 * The RFC 2822 message for a draft: plain text plus a minimal HTML alternative (line breaks
 * only), UTF-8, base64 bodies. For a reply, In-Reply-To and References carry the original's
 * Message-ID so Gmail and the recipient keep it in the same conversation.
 */
export function buildMime(d: DraftInput & { inReplyTo?: string | null; references?: string | null; boundary?: string }): string {
  const boundary = d.boundary ?? `wiseai_${crypto.getRandomValues(new Uint32Array(2)).join("_")}`;
  const lines = [
    `To: ${d.to.map(formatAddr).join(", ")}`,
    ...(d.cc.length ? [`Cc: ${d.cc.map(formatAddr).join(", ")}`] : []),
    `Subject: ${encodeHeader(d.subject)}`,
    "MIME-Version: 1.0",
  ];
  if (d.inReplyTo && MSGID.test(d.inReplyTo.trim())) {
    const refs = String(d.references ?? "").split(/\s+/).filter((x) => MSGID.test(x)).slice(-20);
    if (!refs.includes(d.inReplyTo.trim())) refs.push(d.inReplyTo.trim());
    lines.push(`In-Reply-To: ${d.inReplyTo.trim()}`, `References: ${refs.join(" ")}`);
  }
  const html = `<div dir="ltr">${escapeHtml(d.body).replace(/\n/g, "<br>")}</div>`;
  lines.push(
    `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
    `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", wrap76(utf8Base64(d.body)),
    `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", wrap76(utf8Base64(html)),
    `--${boundary}--`, "",
  );
  return lines.join("\r\n");
}
