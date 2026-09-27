import { describe, expect, it } from "vitest";

import data from "../research/data/pyth-tsla-gaps.json" with { type: "json" };
import { backtest } from "../pricing/backtest";
import type { Opening } from "../pricing/model";
import { formatBook, gapReport, parseBook } from "./gapReport";
import { DEFAULT_QUOTER_CONFIG, priceQuote, type Market } from "./quoter";

// Friday 25 Sep 2026, 20:00 EDT: the exchange is shut until Monday's open.
const FRIDAY_EVENING = Date.parse("2026-09-26T00:00:00Z") / 1000;
const TSLA: Market = { symbol: "TSLA", close: 380, live: 380, history: data.gaps as Opening[], annualVol: 0.6, holidays: new Set() };
const MARKETS = new Map<string, Market | null>([["TSLA", TSLA]]);
const TWO_TO_TEN = { deductible: 0.02, depth: 0.1 };

describe("gapReport", () => {
  it("counts how TSLA has opened on the recorded openings, and finds the worst", () => {
    const [l] = gapReport(FRIDAY_EVENING, [{ symbol: "TSLA", shares: 100 }], MARKETS, TWO_TO_TEN).lines;
    expect(l!.history.openings).toBe(46);
    expect(l!.history.downAtLeast).toEqual([
      { move: 0.01, nights: 11 },
      { move: 0.02, nights: 2 },
      { move: 0.05, nights: 1 },
    ]);
    expect(l!.history.worst.to).toBe("2026-07-23");
    expect(l!.history.worst.gap).toBeCloseTo(-0.08806, 4);
  });

  it("applies the worst opening to the position at today's price, with what the protection pays that night", () => {
    const [l] = gapReport(FRIDAY_EVENING, [{ symbol: "TSLA", shares: 100 }], MARKETS, TWO_TO_TEN).lines;
    const gap = l!.history.worst.gap;
    expect(l!.value).toBe(38_000);
    expect(l!.worstNight.loss).toBeCloseTo(-gap * 38_000, 6);
    // Opens 8.8% down: inside 2%–10%, so it pays from $372.40 down to the open, on every share.
    expect(l!.worstNight.protectionPays).toBeCloseTo(100 * (372.4 - 380 * (1 + gap)), 6);
  });

  it("prices tonight exactly as a quote would, and past the per-quote limit for a whole book", () => {
    const small = gapReport(FRIDAY_EVENING, [{ symbol: "TSLA", shares: 10 }], MARKETS, TWO_TO_TEN).lines[0]!.tonight;
    const quote = priceQuote(FRIDAY_EVENING, TSLA, { shares: 10, upper: 372.4, lower: 342 });
    expect(small).toEqual({ openTs: quote.openTs, premium: quote.premium, maxPayout: quote.maxPayout, probabilityOfPayout: quote.probabilityOfPayout, upper: 372.4, lower: 342 });

    const book = gapReport(FRIDAY_EVENING, [{ symbol: "TSLA", shares: 5_000 }], MARKETS, TWO_TO_TEN).lines[0]!.tonight;
    expect(5_000).toBeGreaterThan(DEFAULT_QUOTER_CONFIG.maxShares);
    expect("premium" in book && book.premium).toBeCloseTo(quote.premium * 500, 6);
  });

  it("adds lines for the same stock, taking dollars at the price it's priced from", () => {
    const r = gapReport(FRIDAY_EVENING, [{ symbol: "tsla", shares: 10 }, { symbol: "TSLA", value: 3_800 }], MARKETS, TWO_TO_TEN);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.shares).toBeCloseTo(20, 9);
    expect(r.totals.value).toBeCloseTo(7_600, 6);
  });

  it("skips what it can't cover and totals the rest", () => {
    const r = gapReport(FRIDAY_EVENING, [{ symbol: "TSLA", shares: 10 }, { symbol: "XYZ", shares: 5 }, { symbol: "NVDA", value: 1_000 }], new Map([...MARKETS, ["NVDA", null]]), TWO_TO_TEN);
    expect(r.lines.map((l) => l.symbol)).toEqual(["TSLA"]);
    expect(r.skipped).toEqual([
      { symbol: "XYZ", reason: "not covered" },
      { symbol: "NVDA", reason: "not covered" },
    ]);
    const t = r.lines[0]!.tonight;
    expect("premium" in t && r.totals.premium).toBe("premium" in t && t.premium);
    expect(r.totals.worstNightLoss).toBe(r.lines[0]!.worstNight.loss);
  });

  it("values the book at the live price and prices nothing while sales are paused", () => {
    const moved = new Map([["TSLA", { ...TSLA, live: 350 }]]); // 7.9% below the close
    const [l] = gapReport(FRIDAY_EVENING, [{ symbol: "TSLA", shares: 10 }], moved, TWO_TO_TEN).lines;
    expect(l!.value).toBe(3_500);
    expect(l!.tonight).toEqual({ unavailable: expect.stringContaining("sales paused") });
  });

  it("replays the protection as the backtest does", () => {
    const [l] = gapReport(FRIDAY_EVENING, [{ symbol: "TSLA", shares: 1 }], MARKETS, TWO_TO_TEN).lines;
    const r = backtest(TSLA.history, TWO_TO_TEN, { shares: 1, annualVol: 0.6, margin: DEFAULT_QUOTER_CONFIG.margin });
    expect(l!.replay).toEqual({ nights: r.nights.length, paidNights: r.paidNights, paidPerDollar: r.paidPerDollar });
  });

  it("refuses protection that stops above where it starts", () => {
    expect(() => gapReport(FRIDAY_EVENING, [{ symbol: "TSLA", shares: 1 }], MARKETS, { deductible: 0.1, depth: 0.05 })).toThrow("further below");
  });
});

describe("parseBook", () => {
  it("reads shares and dollar values, and writes them back", () => {
    const book = parseBook(" TSLA:100, nvda:$25000 ,QQQ:2.5");
    expect(book).toEqual([
      { symbol: "TSLA", shares: 100 },
      { symbol: "NVDA", value: 25_000 },
      { symbol: "QQQ", shares: 2.5 },
    ]);
    expect(parseBook(formatBook(book))).toEqual(book);
  });

  it("refuses anything else", () => {
    for (const bad of ["", "TSLA", "TSLA:-1", "TSLA:0", "TSLA:1e3", "TSLA:$", "TSLA:100;NVDA:1"]) expect(() => parseBook(bad)).toThrow();
  });
});
