// Pure routing rules for the chat (Node-testable): which tool groups to load for a message, which
// model answers it, and when a cheap model's answer is escalated to Sonnet.
import { TOOL_GROUPS, type ToolGroup } from "./chat-prompt.ts";

export const HAIKU = "claude-haiku-5-5";
export const SONNET = "claude-sonnet-5-5";
export const OPUS = "claude-opus-5-5";

/** settings.agent_chat_model values. 'auto' (default): Haiku, escalating to Sonnet when needed. */
export const CHAT_MODEL_SETTINGS = ["auto", "haiku", "sonnet", "opus"] as const;
export type ChatModelSetting = typeof CHAT_MODEL_SETTINGS[number];

/** The stored setting (short name, or an older full model id) as one of the four values. */
export function modelSetting(v: unknown): ChatModelSetting {
  const s = String(v ?? "").toLowerCase();
  if (s === "auto" || s === "") return "auto";
  if (s.includes("haiku")) return "haiku";
  if (s.includes("sonnet")) return "sonnet";
  if (s.includes("opus")) return "opus";
  return "auto";
}

const RX = (words: string[]) => new RegExp(`\\b(${words.join("|")})`, "i");

const FILES = RX(["file", "files", "folder", "drive", "document", "doc\\b", "docs", "spreadsheet", "sheet", "slides", "pdf", "receipt", "template", "contract", "proposal doc", "upload", "rename", "organi[sz]e", "tidy", "filing", "brief\\b", "read the", "pull up", "open the", "start here", "hub page"]);
const EMAIL = RX(["email", "e-mail", "emails", "mail\\b", "inbox", "gmail", "reply to", "replied", "draft (an|a|the)? ?(email|reply)", "write to", "send .{0,40}(email|note)", "unread", "cc\\b", "sent me", "wrote"]);
const CAL = RX(["calendar", "meeting", "meetings", "appointment", "event", "events", "schedule", "free time", "free slot", "availability", "available", "what'?s on", "book (a|in)", "invite", "diary", "tomorrow at", "at \\d{1,2}(:\\d\\d)? ?(am|pm)"]);
const RECORDS = RX(["client", "clients", "job\\b", "jobs", "project", "projects", "invoice", "invoices", "bill\\b", "cost", "costs", "subscription", "expense", "library", "playbook", "standard", "write (it|this|that) up", "save (it|this|that)", "archive", "hide", "remove", "delete", "get rid", "forget", "retainer", "paid", "gst", "won\\b"]);
const SCOUT = RX(["find (me )?(some |more |\\d+ )?(new )?(leads|prospects|businesses)", "lead scout", "scout", "prospect", "look for (new )?(leads|businesses)", "search (the web|online) for", "leads like"]);

/** Tool groups to load up front for this message (the model can still load others with load_tools). */
export function pickGroups(message: string, connected: { files: boolean; email: boolean; calendar: boolean }): ToolGroup[] {
  const m = message ?? "";
  const out = new Set<ToolGroup>();
  if (FILES.test(m) && connected.files) out.add("files");
  if (EMAIL.test(m) && connected.email) out.add("email");
  if (CAL.test(m) && connected.calendar) out.add("calendar");
  if (RECORDS.test(m)) out.add("records");
  if (SCOUT.test(m)) out.add("scout");
  return TOOL_GROUPS.filter((g) => out.has(g));
}

/** Work that needs planning: Sonnet from the start on 'auto'. Returns the reason, or null. */
export function needsPlanning(message: string, groups: ToolGroup[]): string | null {
  const m = (message ?? "").trim();
  if (m.length > 700) return "long request";
  if (/\b(draft|write|compose|prepare)\b.{0,60}\b(email|e-mail|reply|proposal|quote|letter|message to)\b/i.test(m)) return "drafting";
  if (/\b(proposal|quote)\b.{0,40}\b(for|to)\b/i.test(m) && /\b(draft|write|make|create|prepare|put together)\b/i.test(m)) return "drafting";
  if (groups.includes("files") && /\b(organi[sz]e|tidy|sort out|clean up|file (these|them|it|the)|move .{0,40} (files|into|to)|rename)\b/i.test(m)) return "file organising";
  // Several separate changes in one message ("create X, then Y and Z...").
  const verbs = m.match(/\b(add|create|make|set up|open|update|change|move|mark|log|record|book|archive|remove|delete|assign|rename)\b/gi) ?? [];
  const lines = m.split(/\n|;|\bthen\b|\balso\b/i).filter((x) => x.trim().length > 3).length;
  if (verbs.length >= 3 && lines >= 3) return "several changes";
  return null;
}

export type FirstChoice = { model: string; reason: string };

/** The model a turn starts on. */
export function firstModel(setting: ChatModelSetting, message: string, groups: ToolGroup[]): FirstChoice {
  if (setting === "haiku") return { model: HAIKU, reason: "setting" };
  if (setting === "sonnet") return { model: SONNET, reason: "setting" };
  if (setting === "opus") return { model: OPUS, reason: "setting" };
  const plan = needsPlanning(message, groups);
  return plan ? { model: SONNET, reason: plan } : { model: HAIKU, reason: "ordinary" };
}

export type TurnSignals = {
  finalText: string;
  declined: boolean;
  toolErrors: number;            // tool results with is_error this turn
  readCalls: number;             // find/get/numbers/... calls made this turn
  writeCalls: number;            // successful writes this turn
  message: string;               // the person's message
};

/**
 * After a Haiku turn on 'auto': should it be redone (or continued) on Sonnet? Returns the reason or null.
 * Only checks that are cheap and objective: refusals/empty answers, repeated tool errors, and a
 * clarifying question asked before looking anything up when the message names something to look up.
 */
export function escalation(s: TurnSignals): string | null {
  if (s.declined) return "declined";
  const text = (s.finalText ?? "").trim();
  if (!text && !s.writeCalls) return "empty";
  if (s.toolErrors >= 2) return "tool errors";
  if (s.readCalls === 0 && s.writeCalls === 0 && /\?\s*$/.test(text) && namesSomething(s.message)) return "asked before looking";
  return null;
}

/**
 * Does the message name something the hub can answer, so asking before looking is pointless?
 * A proper name after the first word ("chase Harbour Dental"), a quoted name, or a figure question.
 * Generic requests ("add a task to chase the invoice") are not: asking there is right.
 */
export function namesSomething(message: string): boolean {
  const m = (message ?? "").trim();
  if (m.length < 12) return false;
  if (/["“'][^"”']{3,}["”']/.test(m)) return true;
  if (/\b(how much|how many|what('?s| is) (overdue|due|owed|unpaid|our|my|the (pipeline|runway|total))|are we owed|runway|burn)\b/i.test(m)) return true;
  const COMMON = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun|January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Wise|Brisbane|Australia|Google|Gmail|Drive|The|Can|Could|Please|Thanks)$/;
  const words = m.split(/\s+/).slice(1).map((w) => w.replace(/[^A-Za-z'&-]/g, ""));
  return words.some((w) => /^[A-Z][a-z]{2,}/.test(w) && !COMMON.test(w));
}
