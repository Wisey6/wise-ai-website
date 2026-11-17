// Local-time maths in an IANA zone via Intl (no UTC shortcuts). Pure; Node-testable.

export type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; isoWeekday: number };

const WD: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function localParts(date: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour % 24, minute: +p.minute, second: +p.second,
    isoWeekday: WD[p.weekday] ?? 0,
  };
}

/** Offset (ms) of the zone from UTC at the given instant. */
function offsetAt(date: Date, timeZone: string): number {
  const l = localParts(date, timeZone);
  const asUtc = Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The UTC instant of local midnight (start of "today") in the zone. */
export function startOfLocalDay(now: Date, timeZone: string): Date {
  const l = localParts(now, timeZone);
  const midnightAsUtc = Date.UTC(l.year, l.month - 1, l.day);
  let guess = midnightAsUtc - offsetAt(now, timeZone);
  // Re-evaluate the offset at the guess in case a DST change happened since midnight.
  guess = midnightAsUtc - offsetAt(new Date(guess), timeZone);
  return new Date(guess);
}

export function windowOpen(
  now: Date,
  s: { timezone: string; send_start_hour: number; send_end_hour: number; send_days: number[] },
): boolean {
  const l = localParts(now, s.timezone || "Australia/Brisbane");
  return (s.send_days ?? []).includes(l.isoWeekday) && s.send_start_hour <= l.hour && l.hour < s.send_end_hour;
}
