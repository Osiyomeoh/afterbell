/**
 * Pure helpers for the weekend-price proof: New York wall-clock time, the
 * price a candle series shows at a moment, and error statistics.
 */

export type Candle = {
  /** open time, ms */
  t: number;
  /** close time, ms (Hyperliquid reports t + interval - 1) */
  T: number;
  /** close price */
  c: number;
};

/** Epoch ms for a New York wall-clock time on an ISO date (YYYY-MM-DD). */
export function nyTime(date: string, hour: number, minute = 0): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  // Guess UTC, then correct by New York's offset at that instant. Two passes
  // settle the answer on both sides of a daylight-saving switch.
  let ts = Date.UTC(y, m - 1, d, hour, minute);
  for (let i = 0; i < 2; i++) ts = Date.UTC(y, m - 1, d, hour, minute) - nyOffsetMs(ts);
  return ts;
}

/** New York's offset from UTC at an instant, in ms (e.g. -4h during EDT). */
export function nyOffsetMs(ts: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ts));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wall - Math.floor(ts / 1000) * 1000;
}

/**
 * The last traded price at `ts`: the close of the latest candle that ended
 * before `ts`. Returns null if that candle ended more than `maxStaleMs` earlier,
 * so a gap in the data is never read as a price.
 */
export function priceAt(candles: readonly Candle[], ts: number, maxStaleMs: number): number | null {
  let lo = 0;
  let hi = candles.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.T < ts) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return null;
  const candle = candles[found]!;
  return ts - candle.T <= maxStaleMs ? candle.c : null;
}

/** Absolute error in basis points of `estimate` against `actual`. */
export const errBps = (estimate: number, actual: number) => (Math.abs(estimate / actual - 1) * 1e4);

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  return xs.reduce((a, x) => a + x, 0) / xs.length;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export type Comparison = {
  n: number;
  /** mean absolute error of the candidate price, bps */
  candidateMae: number;
  /** mean absolute error of the previous close on the same openings, bps */
  closeMae: number;
  /** share of openings where the candidate was strictly closer than the close */
  candidateCloser: number;
  /** 1 - candidateMae / closeMae: how much of the close's error the candidate removes */
  errorRemoved: number;
};

/** Compare a candidate estimate of the open against the previous close. */
export function compare(rows: readonly { candidate: number; close: number; open: number }[]): Comparison {
  const cand = rows.map((r) => errBps(r.candidate, r.open));
  const close = rows.map((r) => errBps(r.close, r.open));
  const candidateMae = mean(cand);
  const closeMae = mean(close);
  return {
    n: rows.length,
    candidateMae,
    closeMae,
    candidateCloser: rows.length ? cand.filter((e, i) => e < close[i]!).length / rows.length : NaN,
    errorRemoved: 1 - candidateMae / closeMae,
  };
}
