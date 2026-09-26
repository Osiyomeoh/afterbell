/**
 * US equity session times in New York, from the tz database (no dependencies).
 * Ported from Weekend Markets' sessions.ts.
 */

const NY = "America/New_York";

/** A year of regular sessions: 252 days of 6.5 hours. */
export const SESSION_SECS_PER_YEAR = 252 * 6.5 * 3600;

type NyDate = { y: number; m: number; d: number };

/** Unix seconds for a wall-clock time in New York on a NY calendar date. */
export function nyTimestamp(date: NyDate, hour: number, minute: number): number {
  const naive = Date.UTC(date.y, date.m - 1, date.d, hour, minute) / 1000;
  // New York's UTC offset that day (EDT -4 or EST -5), read from the tz database.
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: NY, timeZoneName: "shortOffset" })
    .formatToParts(new Date((naive + 5 * 3600) * 1000))
    .find((p) => p.type === "timeZoneName")!
    .value.replace("GMT", "");
  const [h, m = "0"] = (offset || "+0").split(":");
  return naive - (Number(h) * 3600 + Math.sign(Number(h) || 1) * Number(m) * 60);
}

function nyDate(unix: number): NyDate & { weekday: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "numeric", day: "numeric", weekday: "short" })
      .formatToParts(new Date(unix * 1000))
      .map((p) => [p.type, p.value]),
  );
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), weekday: parts.weekday! };
}

export const isoDate = (d: NyDate) => `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;

const isTradingDay = (d: NyDate & { weekday: string }, holidays: ReadonlySet<string>) =>
  d.weekday !== "Sat" && d.weekday !== "Sun" && !holidays.has(isoDate(d));

/**
 * The NY dates a Pyth market-hours schedule lists as closed, e.g. from
 * "America/New_York;0930-1600,...,C,C;0907/C,1126/C,1127/0930-1300".
 * Entries carry no year, so each is taken as its next occurrence on or after
 * `from`. Early-close days still open at 09:30, so they aren't included.
 */
export function scheduleHolidays(schedule: string, from: number): Set<string> {
  const today = nyDate(from);
  const out = new Set<string>();
  for (const entry of (schedule.split(";")[2] ?? "").split(",")) {
    const [mmdd = "", hours] = entry.trim().split("/");
    if (hours !== "C" || !/^\d{4}$/.test(mmdd)) continue;
    const m = Number(mmdd.slice(0, 2));
    const d = Number(mmdd.slice(2));
    const y = m * 100 + d >= today.m * 100 + today.d ? today.y : today.y + 1;
    out.add(isoDate({ y, m, d }));
  }
  return out;
}

/** The first 09:30 ET open on a trading day that is at least `leadSecs` after `now`. */
export function nextOpen(now: number, leadSecs: number, holidays: ReadonlySet<string> = new Set()): number {
  for (let day = 0; day < 14; day++) {
    const date = nyDate(now + day * 86_400);
    if (!isTradingDay(date, holidays)) continue;
    const ts = nyTimestamp(date, 9, 30);
    if (ts >= now + leadSecs) return ts;
  }
  throw new Error("no open in the next 14 days");
}

/**
 * Regular-session time left today (09:30 to 16:00 ET on a trading day), in
 * seconds; zero outside the session. Early closes aren't modeled, which only
 * overstates the risk left on those days.
 */
export function sessionSecsLeft(now: number, holidays: ReadonlySet<string> = new Set()): number {
  const date = nyDate(now);
  if (!isTradingDay(date, holidays)) return 0;
  const open = nyTimestamp(date, 9, 30);
  const close = nyTimestamp(date, 16, 0);
  return now >= open && now < close ? close - now : 0;
}
