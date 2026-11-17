// Template rendering + the compliance tail for a lead who has never replied.
// Pure functions (no Deno APIs) so they can be unit-tested under Node.

export type LeadLike = {
  contact_name?: string | null;
  business?: string | null;
  suburb?: string | null;
  industry?: string | null;
  hook?: string | null;
  pain?: string | null;
  est_monthly_value?: number | string | null;
};

export type SettingsLike = {
  sender_name?: string | null;
  optout_text?: string | null;
  booking_url?: string | null;
};

export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  return "$" + Math.round(n).toLocaleString("en-AU");
}

export function firstName(lead: LeadLike): string {
  const w = String(lead.contact_name ?? "").trim().split(/\s+/)[0];
  return w || "there";
}

export function renderTemplate(body: string, lead: LeadLike, settings: SettingsLike): string {
  const vars: Record<string, string> = {
    first_name: firstName(lead),
    business: String(lead.business ?? "").trim() || "your business",
    suburb: String(lead.suburb ?? "").trim(),
    industry: String(lead.industry ?? "").trim(),
    hook: String(lead.hook ?? "").trim(),
    pain: String(lead.pain ?? "").trim(),
    value: formatValue(lead.est_monthly_value),
    sender: String(settings.sender_name ?? "").trim(),
    booking_url: String(settings.booking_url ?? "").trim(),
  };
  const out = String(body ?? "").replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
  // An empty variable (e.g. no {suburb}) must not leave double spaces behind.
  return out.replace(/[ \t]{2,}/g, " ").replace(/ +([,.?!])/g, "$1").trim();
}

/**
 * True when the text already carries an opt-out instruction. The contract says "contains STOP
 * (case-insensitive)", but the seeded first-touch template says "stop losing jobs", which would
 * then skip the opt-out. So we accept an upper-case STOP word, or "reply/text/txt/send/sms stop"
 * in any case.
 */
export function hasOptOut(body: string): boolean {
  return /\bSTOP\b/.test(body) || /\b(reply|text|txt|send|sms)\s+stop\b/i.test(body);
}

/** For a lead who has never replied: make sure the sender is named and the opt-out is present. */
export function ensureCompliance(body: string, settings: SettingsLike): string {
  let out = body.trim();
  const sender = String(settings.sender_name ?? "").trim();
  if (sender && !out.toLowerCase().includes(sender.toLowerCase())) out += ` - ${sender}`;
  const optout = String(settings.optout_text ?? "").trim() || "Reply STOP to opt out";
  if (!hasOptOut(out)) out += ` ${optout}`;
  return out;
}
