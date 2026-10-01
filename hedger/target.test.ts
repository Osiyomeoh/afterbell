import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openingModel, type Opening } from "../pricing/model";
import { hedgeShares } from "../pricing/putSpread";
import { DEFAULT_BAND, exposure, rebalance, type HedgeRules, type OpenPosition } from "./target";

const TSLA: Opening[] = JSON.parse(readFileSync(join(import.meta.dirname, "..", "research", "data", "pyth-tsla-gaps.json"), "utf8")).gaps;
const model = openingModel(TSLA, { annualVol: 0.6, years: 0 });
const modelFor = () => model;

const OPEN = 1_790_000_000;
const NEXT = OPEN + 86_400;
// Strikes like Monday 28 Sep's five; the lower strikes are made up.
const book: OpenPosition[] = [
  { symbol: "TSLA", openTs: OPEN, shares: 1, upper: 370.32, lower: 340.09 },
  { symbol: "TSLA", openTs: OPEN, shares: 1, upper: 370.32, lower: 340.09 },
  { symbol: "TSLA", openTs: OPEN, shares: 2, upper: 364.56, lower: 335 },
  { symbol: "TSLA", openTs: OPEN, shares: 1, upper: 364.56, lower: 335 },
  { symbol: "TSLA", openTs: OPEN, shares: 3, upper: 364.15, lower: 335 },
  { symbol: "TSLA", openTs: NEXT, shares: 2, upper: 360, lower: 330 },
  { symbol: "QQQ", openTs: OPEN, shares: 50, upper: 600, lower: 550 },
];
const RULES: HedgeRules = { step: 0.001, ...DEFAULT_BAND, maxNotional: 10_000 };

describe("exposure", () => {
  it("sums each position's hedge in the stock, grouped by open, soonest first", () => {
    const e = exposure(OPEN - 3600, "TSLA", book, 371.76, modelFor);
    expect(e.opens.map((o) => [o.openTs, o.positions, o.shares])).toEqual([
      [OPEN, 5, 8],
      [NEXT, 1, 2],
    ]);
    expect(e.opens[0]!.maxPayout).toBeCloseTo(2 * 30.23 + 3 * 29.56 + 3 * 29.15, 9);
    const each = book.filter((p) => p.symbol === "TSLA").reduce((a, p) => a + hedgeShares(model, 371.76, p), 0);
    expect(e.hedge).toBeCloseTo(each, 12);
    expect(e.hedge).toBeGreaterThan(0);
  });

  it("drops positions once their open comes, settled or not", () => {
    const e = exposure(OPEN, "TSLA", book, 371.76, modelFor);
    expect(e.opens.map((o) => o.openTs)).toEqual([NEXT]);
    expect(exposure(NEXT, "TSLA", book, 371.76, modelFor)).toMatchObject({ opens: [], hedge: 0 });
  });

  it("grows as the price falls toward the strikes", () => {
    const at = (spot: number) => exposure(OPEN - 3600, "TSLA", book, spot, modelFor).hedge;
    expect(at(380)).toBeLessThan(at(371.76));
    expect(at(371.76)).toBeLessThan(at(365));
    expect(at(365)).toBeLessThan(at(360));
  });

  it("builds each open's model for that open", () => {
    const seen: number[] = [];
    exposure(OPEN - 3600, "TSLA", book, 371.76, (openTs) => (seen.push(openTs), model));
    expect(seen).toEqual([OPEN, NEXT]);
  });

  it("refuses to size a hedge without a price", () => {
    expect(() => exposure(OPEN - 3600, "TSLA", book, 0, modelFor)).toThrow();
  });
});

describe("rebalance", () => {
  it("sells up to the hedge, rounded to the size step", () => {
    expect(rebalance(1.1604, 0, 371.76, RULES)).toEqual({ target: 1.16, capped: false, trade: 1.16, reduceOnly: false, note: "sell 1.16 to short 1.16" });
  });

  it("holds inside the dead band: under 0.01 shares and under $10", () => {
    // At $371.76, $10 is 0.027 shares, so the band is 0.027.
    expect(rebalance(1.185, 1.16, 371.76, RULES)).toMatchObject({ trade: 0, target: 1.185 });
    expect(rebalance(1.19, 1.16, 371.76, RULES)).toMatchObject({ trade: 0.03 });
    expect(rebalance(1.16, 1.16, 371.76, RULES)).toMatchObject({ trade: 0, note: "hold: short 1.16, at the target" });
  });

  it("buys back reduce-only when the hedge shrinks", () => {
    expect(rebalance(0.5, 1.16, 371.76, RULES)).toMatchObject({ target: 0.5, trade: -0.66, reduceOnly: true, note: "buy back 0.66 to short 0.5" });
  });

  it("closes whatever is left once nothing needs hedging, however small", () => {
    expect(rebalance(0, 0.004, 371.76, RULES)).toMatchObject({ target: 0, trade: -0.004, reduceOnly: true, note: "buy back 0.004: nothing left to hedge" });
    expect(rebalance(0.0004, 0, 371.76, RULES)).toMatchObject({ target: 0, trade: 0 });
  });

  it("caps the short's notional, and says the hedge is partial", () => {
    // $300 at $371.76 is 0.806 shares.
    const r = rebalance(1.16, 0, 371.76, { ...RULES, maxNotional: 300 });
    expect(r).toMatchObject({ target: 0.806, capped: true, trade: 0.806 });
    expect(r.note).toContain("capped at $300");
    expect(rebalance(1.16, 1.16, 371.76, { ...RULES, maxNotional: 300 })).toMatchObject({ target: 0.806, trade: -0.354, reduceOnly: true });
  });

  it("gets back to short from a long, not reduce-only", () => {
    expect(rebalance(1, -0.5, 371.76, RULES)).toMatchObject({ trade: 1.5, reduceOnly: false });
  });

  it("rejects a negative hedge and a missing price", () => {
    expect(() => rebalance(-1, 0, 371.76, RULES)).toThrow();
    expect(() => rebalance(1, 0, 0, RULES)).toThrow();
  });
});
