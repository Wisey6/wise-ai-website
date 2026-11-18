// Pure rules for the assistant's calendar tools (agent/calendar.ts): local times in the hub's
// time zone, compact event rows, the event body for a create or change, free times, and which
// changes must wait for the person (guests). No Deno APIs, so Node unit-tests it.
import { Refusal } from "./chat-rules.ts";
import { htmlToText } from "./mail-rules.ts";
import { parseAddress } from "../_shared/gmail.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
const fail = (m: string): never => { throw new Refusal(m); };

export const FIND_DEFAULT = 20;
export const FIND_MAX = 50;
export const DEFAULT_DAYS = 14;
export const MAX_GUESTS = 20;
export const DESC_MAX = 4000;
export const DEFAULT_HOURS = { start: "08:30", end: "17:30" };

/* ------------------------------------------------------------------ local time */
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/;
function partsAt(ms: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, wd: p.weekday };
}
const offsetMs = (ms: number, tz: string) => { const p = partsAt(ms, tz); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000; };
/** "2026-11-20" or "2026-11-20T09:30" in the zone → the UTC instant (ms). Null when not a date. */
export function localToMs(v: unknown, tz: string): number | null {
  const m = typeof v === "string" ? LOCAL_RE.exec(v.trim()) : null;
  if (!m) return null;
  const [y, mo, d, h, mi] = [+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0)];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  let guess = asUtc - offsetMs(asUtc, tz);
  guess = asUtc - offsetMs(guess, tz);
  return guess;
}
export const isDateOnly = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim());
/** The local date "YYYY-MM-DD" and time "HH:MM" of an instant. */
export function localOf(ms: number, tz: string): { date: string; time: string; wd: string } {
  const p = partsAt(ms, tz);
  const z = (n: number) => String(n).padStart(2, "0");
  return { date: `${p.y}-${z(p.mo)}-${z(p.d)}`, time: `${z(p.h)}:${z(p.mi)}`, wd: p.wd };
}
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The window to look in: from/to as local dates or date-times; default now to +14 days. */
export function windowOf(input: Row, tz: string, now = Date.now()): { timeMin: string; timeMax: string } {
  const from = input.from ? localToMs(input.from, tz) : now;
  if (from === null) fail('from must be a local date "YYYY-MM-DD" or date and time "YYYY-MM-DDTHH:MM"');
  let to: number | null;
  if (input.to) {
    to = localToMs(isDateOnly(input.to) ? addDays(String(input.to).trim(), 1) : input.to, tz);   // a date "to" includes that whole day
    if (to === null) fail('to must be a local date "YYYY-MM-DD" or date and time "YYYY-MM-DDTHH:MM"');
  } else to = from! + DEFAULT_DAYS * 86_400_000;
  if (to! <= from!) fail("to must be after from");
  if (to! - from! > 400 * 86_400_000) fail("look at most about a year at a time");
  return { timeMin: new Date(from!).toISOString(), timeMax: new Date(to!).toISOString() };
}
export function findLimit(v: unknown): number {
  const n = Number.isInteger(v) ? Number(v) : FIND_DEFAULT;
  return Math.max(1, Math.min(FIND_MAX, n));
}

/* ------------------------------------------------------------------ rows */
const TIME_FMT = (tz: string) => new Intl.DateTimeFormat("en-AU", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true });
const DAY_FMT = (tz: string) => new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "short", day: "numeric", month: "short" });
/** "Fri 21 Nov, 9:00 am to 10:00 am", or "Fri 21 Nov (all day)". */
export function whenText(ev: Row, tz: string): string {
  const s = ev?.start ?? {}, e = ev?.end ?? {};
  if (s.date) {
    const first = DAY_FMT("UTC").format(new Date(`${s.date}T12:00:00Z`)).replace(",", "");
    const lastDate = e.date ? addDays(e.date, -1) : s.date;
    return lastDate > s.date ? `${first} to ${DAY_FMT("UTC").format(new Date(`${lastDate}T12:00:00Z`)).replace(",", "")} (all day)` : `${first} (all day)`;
  }
  const a = Date.parse(s.dateTime), b = Date.parse(e.dateTime);
  if (!Number.isFinite(a)) return "";
  const day = DAY_FMT(tz).format(new Date(a)).replace(",", "");
  const t = (ms: number) => TIME_FMT(tz).format(new Date(ms)).replace(/\s?([ap])\.?m\.?/i, " $1m").toLowerCase();
  if (!Number.isFinite(b)) return `${day}, ${t(a)}`;
  const sameDay = localOf(a, tz).date === localOf(b, tz).date;
  return sameDay ? `${day}, ${t(a)} to ${t(b)}` : `${day}, ${t(a)} to ${DAY_FMT(tz).format(new Date(b)).replace(",", "")}, ${t(b)}`;
}
const guestsOf = (ev: Row) => (Array.isArray(ev?.attendees) ? ev.attendees as Row[] : []).filter((a) => !a.self && !a.resource);
/** Does this event have guests other than the person (changes to it would notify them)? */
export const hasOtherGuests = (ev: Row) => guestsOf(ev).length > 0;
const guestName = (a: Row) => String(a.displayName || a.email || "").slice(0, 120);

/** A compact row for find_events (and the hub's event tiles). */
export function eventRow(ev: Row, tz: string): Row {
  const allDay = Boolean(ev?.start?.date);
  const link = ev?.extendedProperties?.private ?? {};
  return {
    id: String(ev.id), title: String(ev.summary ?? "").slice(0, 200) || "(no title)",
    start: allDay ? ev.start.date : ev?.start?.dateTime ?? null, end: allDay ? ev?.end?.date ?? null : ev?.end?.dateTime ?? null,
    all_day: allDay, when: whenText(ev, tz),
    ...(ev.location ? { location: String(ev.location).slice(0, 200) } : {}),
    ...(guestsOf(ev).length ? { guests: guestsOf(ev).slice(0, 12).map(guestName) } : {}),
    ...(ev.hangoutLink ? { meet_link: ev.hangoutLink } : {}),
    ...(ev.organizer && ev.organizer.self !== true ? { organiser: String(ev.organizer.displayName || ev.organizer.email || "someone else").slice(0, 120) } : {}),
    ...(ev.status === "tentative" ? { tentative: true } : {}),
    ...(link.wiseai_kind && link.wiseai_id ? { linked: { kind: link.wiseai_kind, id: link.wiseai_id } } : {}),
  };
}
/** One event in full (description as plain text, capped). */
export function eventDetail(ev: Row, tz: string): Row {
  const desc = typeof ev.description === "string" ? htmlToText(ev.description).slice(0, DESC_MAX) : "";
  return {
    ...eventRow(ev, tz),
    ...(desc ? { description: `<calendar_text>\n${desc}\n</calendar_text>` } : {}),
    guests_detail: guestsOf(ev).slice(0, MAX_GUESTS).map((a) => ({ name: a.displayName ?? null, email: a.email ?? null, response: a.responseStatus ?? null })),
    my_response: (Array.isArray(ev.attendees) ? ev.attendees.find((a: Row) => a.self)?.responseStatus : null) ?? null,
    calendar_link: typeof ev.htmlLink === "string" && /^https:\/\/www\.google\.com\/calendar\//.test(ev.htmlLink) ? ev.htmlLink : null,
  };
}
/** Did this calendar result put text written by someone else in front of the model? */
export function calendarTaints(tool: string, out: Row | null | undefined): boolean {
  if (!out) return false;
  if (tool === "get_event") return Boolean(out.description) || Boolean(out.organiser) || Array.isArray(out.guests_detail) && out.guests_detail.length > 0;
  if (tool === "find_events") return Array.isArray(out.events) && out.events.some((e: Row) => e.organiser || e.guests);
  return false;
}

/* ------------------------------------------------------------------ changes */
function text(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") return fail(`${field} must be text`);
  const t = v.replace(/\r\n?/g, "\n").trim();
  if (t.length > max) fail(`${field} is over ${max} characters`);
  return t || null;
}
function guestList(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) fail("guests must be a list of email addresses");
  const out: string[] = [];
  for (const g of v as unknown[]) {
    const a = parseAddress(g);
    if (!a) fail(`"${String(g).slice(0, 80)}" in guests is not an email address`);
    if (!out.includes(a!.address)) out.push(a!.address);
  }
  if (out.length > MAX_GUESTS) fail(`at most ${MAX_GUESTS} guests`);
  return out;
}

/**
 * The event body for events.insert / events.patch from the tool input, every value checked.
 * Times are local to the hub's zone and sent with that zone. `guests` (when given) is returned
 * separately: adding or changing guests always waits for the person.
 */
export function eventBody(input: Row, tz: string, existing: Row | null): { body: Row; guests: string[] | undefined } {
  const body: Row = {};
  const title = text(input.title, "title", 200);
  if (title) body.summary = title;
  else if (!existing) fail("the event needs a title");
  const loc = text(input.location, "location", 300);
  if (loc !== null) body.location = loc;
  else if (input.location === "") body.location = "";
  const desc = text(input.description, "description", DESC_MAX);
  if (desc !== null) body.description = desc;
  const allDay = input.all_day === true || (input.all_day !== false && isDateOnly(input.start));
  if (input.start !== undefined && input.start !== null && input.start !== "") {
    if (allDay) {
      if (!isDateOnly(input.start)) fail('for an all-day event give start as "YYYY-MM-DD"');
      const lastDay = input.end ? String(input.end).trim().slice(0, 10) : String(input.start).trim();
      if (!isDateOnly(lastDay) || lastDay < String(input.start).trim()) fail('end must be a date "YYYY-MM-DD" on or after start');
      body.start = { date: String(input.start).trim() };
      body.end = { date: addDays(lastDay, 1) };   // Google's end date is the day after
    } else {
      const s = localToMs(input.start, tz);
      if (s === null || isDateOnly(input.start)) fail('start must be a local date and time "YYYY-MM-DDTHH:MM"');
      let e: number | null = null;
      if (input.end) { e = localToMs(input.end, tz); if (e === null || isDateOnly(input.end)) fail('end must be a local date and time "YYYY-MM-DDTHH:MM"'); }
      else {
        const mins = input.duration_min === undefined || input.duration_min === null ? 60 : Number(input.duration_min);
        if (!Number.isInteger(mins) || mins < 5 || mins > 1440) fail("duration_min must be 5 to 1440 minutes");
        e = s! + mins * 60_000;
      }
      if (e! <= s!) fail("the end must be after the start");
      if (e! - s! > 14 * 86_400_000) fail("an event can be at most 14 days long");
      const fmt = (ms: number) => { const l = localOf(ms, tz); return `${l.date}T${l.time}:00`; };
      body.start = { dateTime: fmt(s!), timeZone: tz };
      body.end = { dateTime: fmt(e!), timeZone: tz };
    }
  } else if (!existing) fail("the event needs a start");
  else if (input.end || input.duration_min) {
    // A new length for an existing timed event, keeping its start.
    const s = Date.parse(existing?.start?.dateTime);
    if (!Number.isFinite(s)) fail("give start as well when changing an all-day event");
    const e = input.end ? localToMs(input.end, tz) : s + Number(input.duration_min) * 60_000;
    if (e === null || !(e > s)) fail("the end must be after the start");
    const l = localOf(e!, tz);
    body.end = { dateTime: `${l.date}T${l.time}:00`, timeZone: tz };
  }
  return { body, guests: guestList(input.guests) };
}

/** A copy of a removed event that can be created again (ids, links and Google's own fields dropped). */
export function recreatable(ev: Row): Row {
  const keep = ["summary", "description", "location", "start", "end", "recurrence", "colorId", "transparency", "visibility", "reminders", "extendedProperties", "attendees"];
  const out: Row = {};
  for (const k of keep) if (ev?.[k] !== undefined) out[k] = ev[k];
  if (Array.isArray(out.attendees)) out.attendees = out.attendees.filter((a: Row) => !a.self).map((a: Row) => ({ email: a.email, ...(a.displayName ? { displayName: a.displayName } : {}) }));
  return out;
}
/** The fields a change touched, as they were (for Undo of an update). */
export function beforeOf(ev: Row, patch: Row): Row {
  const out: Row = {};
  for (const k of Object.keys(patch)) out[k] = ev?.[k] ?? (k === "location" || k === "description" ? "" : null);
  return out;
}

/* ------------------------------------------------------------------ free times */
export type Busy = { start: number; end: number };
/** Busy spans from events: not cancelled, not "free" (transparent), not declined by the person. All-day events count only when marked busy. */
export function busyOf(events: Row[]): Busy[] {
  const out: Busy[] = [];
  for (const ev of events) {
    if (ev.status === "cancelled" || ev.transparency === "transparent") continue;
    if ((Array.isArray(ev.attendees) ? ev.attendees : []).some((a: Row) => a.self && a.responseStatus === "declined")) continue;
    if (ev.start?.date) continue;
    const s = Date.parse(ev.start?.dateTime), e = Date.parse(ev.end?.dateTime);
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) out.push({ start: s, end: e });
  }
  return out.sort((a, b) => a.start - b.start);
}
const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export function hoursOf(v: unknown): { start: string; end: string } {
  if (v === undefined || v === null || v === "") return DEFAULT_HOURS;
  const m = typeof v === "string" ? /^\s*(\d{1,2}:\d{2})\s*[-–to]+\s*(\d{1,2}:\d{2})\s*$/.exec(v) : null;
  const pad = (x: string) => x.padStart(5, "0");
  if (!m || !HM.test(pad(m[1])) || !HM.test(pad(m[2])) || pad(m[2]) <= pad(m[1])) fail('within_hours must look like "08:30-17:30"');
  return { start: pad(m![1]), end: pad(m![2]) };
}
/**
 * Free slots of at least `minutes` inside working hours (Mon to Fri unless `weekends`), between
 * from and to, avoiding busy spans. At most `max` slots, each as {start, end} ISO instants.
 */
export function freeSlots(busy: Busy[], fromMs: number, toMs: number, minutes: number, tz: string, hours = DEFAULT_HOURS, o: { weekends?: boolean; max?: number } = {}): { start: string; end: string; when: string }[] {
  const out: { start: string; end: string; when: string }[] = [];
  const need = minutes * 60_000;
  let day = localOf(fromMs, tz).date;
  const lastDay = localOf(toMs, tz).date;
  for (let i = 0; i < 400 && day <= lastDay && out.length < (o.max ?? 20); i++, day = addDays(day, 1)) {
    const wd = localOf(localToMs(`${day}T12:00`, tz)!, tz).wd;
    if (!o.weekends && (wd === "Sat" || wd === "Sun")) continue;
    let cur = Math.max(localToMs(`${day}T${hours.start}`, tz)!, fromMs);
    const end = Math.min(localToMs(`${day}T${hours.end}`, tz)!, toMs);
    for (const b of busy) {
      if (b.end <= cur || b.start >= end) continue;
      if (b.start - cur >= need) out.push(slot(cur, b.start, tz));
      cur = Math.max(cur, b.end);
      if (out.length >= (o.max ?? 20)) break;
    }
    if (end - cur >= need && out.length < (o.max ?? 20)) out.push(slot(cur, end, tz));
  }
  return out;
}
function slot(a: number, b: number, tz: string) {
  return { start: new Date(a).toISOString(), end: new Date(b).toISOString(), when: whenText({ start: { dateTime: new Date(a).toISOString() }, end: { dateTime: new Date(b).toISOString() } }, tz) };
}
