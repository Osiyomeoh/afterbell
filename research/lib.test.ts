import { describe, expect, it } from "vitest";

import { compare, errBps, median, nyTime, priceAt, type Candle } from "./lib";

describe("nyTime", () => {
  it("converts New York wall-clock time during daylight saving (UTC-4)", () => {
    expect(new Date(nyTime("2026-09-21", 9, 30)).toISOString()).toBe("2026-09-21T13:30:00.000Z");
  });

  it("converts New York wall-clock time in winter (UTC-5)", () => {
    expect(new Date(nyTime("2026-12-14", 9, 30)).toISOString()).toBe("2026-12-14T14:30:00.000Z");
  });

  it("handles the days daylight saving starts and ends", () => {
    // 2026-03-08: clocks jump 02:00 -> 03:00; 2026-11-01: 02:00 -> 01:00.
    expect(new Date(nyTime("2026-03-08", 9, 30)).toISOString()).toBe("2026-03-08T13:30:00.000Z");
    expect(new Date(nyTime("2026-11-01", 9, 30)).toISOString()).toBe("2026-11-01T14:30:00.000Z");
  });
});

describe("priceAt", () => {
  const hour = 3_600_000;
  const candles: Candle[] = [0, 1, 2].map((i) => ({ t: i * hour, T: (i + 1) * hour - 1, c: 100 + i }));

  it("returns the close of the last candle that ended before the moment", () => {
    expect(priceAt(candles, 2 * hour, hour)).toBe(101);
    expect(priceAt(candles, 2 * hour + 30 * 60_000, hour)).toBe(101);
    expect(priceAt(candles, 3 * hour, hour)).toBe(102);
  });

  it("ignores a candle still open at the moment", () => {
    // The candle covering [2h, 3h) has not closed at 2h30, so its close is in the future.
    expect(priceAt(candles, 2.5 * hour, 2 * hour)).toBe(101);
  });

  it("returns null before the first candle closes", () => {
    expect(priceAt(candles, hour - 1, hour)).toBeNull();
  });

  it("returns null when the last candle is older than the staleness limit", () => {
    expect(priceAt(candles, 10 * hour, hour)).toBeNull();
    expect(priceAt([], 10 * hour, hour)).toBeNull();
  });
});

describe("statistics", () => {
  it("measures error in basis points", () => {
    expect(errBps(101, 100)).toBeCloseTo(100);
    expect(errBps(99, 100)).toBeCloseTo(100);
  });

  it("takes the median of odd and even lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("compares a candidate estimate of the open against the previous close", () => {
    const c = compare([
      { candidate: 99, close: 100, open: 98 }, // candidate 1.02% off, close 2.04% off
      { candidate: 100, close: 100, open: 100 }, // tie: not counted as closer
    ]);
    expect(c.n).toBe(2);
    expect(c.candidateCloser).toBe(0.5);
    expect(c.candidateMae).toBeCloseTo((1e4 / 98) / 2);
    expect(c.closeMae).toBeCloseTo((2e4 / 98) / 2);
    expect(c.errorRemoved).toBeCloseTo(0.5);
  });
});
