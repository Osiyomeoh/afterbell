import { describe, expect, it } from "vitest";

import { openingModel, type Opening } from "../pricing/model";
import { hedgeShares, type Protection } from "../pricing/putSpread";
import { nyTime, type Candle } from "../research/lib";
import { backtestHedges, hedgeNight, nightPath, type PricePoint, type Strategy } from "./backtest";

const MIN = 60_000;
const HOUR = 60 * MIN;
const CLOSE = nyTime("2026-09-03", 16);
const OPEN = nyTime("2026-09-04", 9, 30);

/** 15-minute candles closing at `px(t)`, from `from` to `to`. */
function candles(from: number, to: number, px: (t: number) => number): Candle[] {
  const out: Candle[] = [];
  for (let t = from; t < to; t += 15 * MIN) out.push({ t, T: t + 15 * MIN - 1, c: px(t) });
  return out;
}

// A spread of past moves wide enough that the hedge has something to do.
const history: Opening[] = Array.from({ length: 20 }, (_, i) => ({ from: "d", to: "d", close: 100, open: 100 * (1 + (i - 10) * 0.004), weekend: false }));
const model = openingModel(history, { annualVol: 0.6, years: 0 });
const protection: Protection = { shares: 10, upper: 98, lower: 90 };
const rules = { step: 0.001, feeRate: 0.00009 };
const flat = (px: number, n: number): PricePoint[] => Array.from({ length: n }, (_, k) => ({ ts: CLOSE + k * 15 * MIN, px }));

describe("nightPath", () => {
  it("prices the close, every step through the night, and the open, each from the last candle before it", () => {
    const c = candles(CLOSE - HOUR, OPEN + HOUR, (t) => 100 + (t - CLOSE) / HOUR);
    const path = nightPath(c, CLOSE, OPEN, HOUR, 30 * MIN)!;
    expect(path[0]).toEqual({ ts: CLOSE, px: 99.75 });
    expect(path[1]).toEqual({ ts: CLOSE + HOUR, px: 100.75 });
    expect(path.at(-1)).toEqual({ ts: OPEN, px: 100 + (OPEN - CLOSE) / HOUR - 0.25 });
    // 16:00 to 09:30 is 17.5 hours: the close, 17 hourly moments, the open.
    expect(path).toHaveLength(19);
  });

  it("leaves out a moment with no recent trade, and gives up on a night without its close or open", () => {
    const gap = (t: number) => t < CLOSE + 3 * HOUR || t >= CLOSE + 5 * HOUR;
    const c = candles(CLOSE - HOUR, OPEN + HOUR, () => 100).filter((k) => gap(k.t));
    const path = nightPath(c, CLOSE, OPEN, HOUR, 30 * MIN)!;
    expect(path.map((p) => p.ts)).not.toContain(CLOSE + 4 * HOUR);
    expect(path.map((p) => p.ts)).toContain(CLOSE + 3 * HOUR);
    expect(nightPath(candles(CLOSE + HOUR, OPEN + HOUR, () => 100), CLOSE, OPEN, HOUR, 30 * MIN)).toBeNull();
    expect(nightPath(candles(CLOSE - HOUR, OPEN - 2 * HOUR, () => 100), CLOSE, OPEN, HOUR, 30 * MIN)).toBeNull();
  });
});

describe("hedgeNight", () => {
  it("on a still night, shorts the delta at the close, holds, and pays only the fees", () => {
    const h = hedgeNight(model, protection, flat(100, 12), { ...rules, everyMs: 15 * MIN });
    const short = Number(hedgeShares(model, 100, protection).toFixed(3));
    expect(short).toBeGreaterThan(0);
    expect(h.trades).toBe(2);
    expect(h.fees).toBeCloseTo(2 * short * 100 * 0.00009, 12);
    expect(h.pnl).toBeCloseTo(-h.fees, 12);
  });

  it("set at the close, makes the short times the fall; rebalanced, adds to it as the price falls", () => {
    const falling: PricePoint[] = Array.from({ length: 9 }, (_, k) => ({ ts: CLOSE + k * HOUR, px: 100 - k }));
    const atClose = hedgeNight(model, protection, falling, { ...rules, everyMs: null });
    const short = Number(hedgeShares(model, 100, protection).toFixed(3));
    expect(atClose.trades).toBe(2);
    expect(atClose.pnl + atClose.fees).toBeCloseTo(short * 8, 9);
    const rebalanced = hedgeNight(model, protection, falling, { ...rules, everyMs: HOUR });
    expect(rebalanced.trades).toBeGreaterThan(2);
    expect(rebalanced.pnl).toBeGreaterThan(atClose.pnl);
  });

  it("rebalances only as often as asked", () => {
    const wobble: PricePoint[] = Array.from({ length: 13 }, (_, k) => ({ ts: CLOSE + k * 15 * MIN, px: k % 2 ? 97 : 99 }));
    const hourly = hedgeNight(model, protection, wobble, { ...rules, everyMs: HOUR });
    const quarterly = hedgeNight(model, protection, wobble, { ...rules, everyMs: 15 * MIN });
    // Hourly sees 99 at every hour, so trades only at the close and the open.
    expect(hourly.trades).toBe(2);
    expect(quarterly.trades).toBe(13);
  });
});

describe("backtestHedges", () => {
  const strategies: Strategy[] = [
    { name: "none", unhedged: true },
    { name: "close", everyMs: null },
  ];
  const opts = { shares: 10, deductible: 0.02, depth: 0.1, annualVol: 0.6, margin: 0.15, step: 0.001, feeRate: 0, pathStepMs: 15 * MIN, maxStaleMs: 30 * MIN };
  // Just enough past openings for the model to use them, so the one night after them is the only one replayed.
  const past = history.filter((_, i) => i % 2 === 0);
  const pastModel = openingModel(past, { annualVol: 0.6, years: 0 });
  const nights: Opening[] = [...past, { from: "2026-09-03", to: "2026-09-04", close: 100, open: 95, weekend: false }];

  it("prices each out-of-sample night from earlier openings, pays it on the open, and adds each hedge", () => {
    const c = candles(CLOSE - HOUR, OPEN + HOUR, (t) => (t < OPEN - 15 * MIN ? 100 : 95));
    const r = backtestHedges(nights, c, strategies, opts);
    expect(r.skipped).toEqual([]);
    expect(r.nights).toHaveLength(1);
    const n = r.nights[0]!;
    // 10 shares from $98: the open at $95 pays $30.
    expect(n.paid).toBeCloseTo(30, 9);
    expect(n.pnl[0]).toBeCloseTo(n.premium - 30, 9);
    expect(n.hedge[0]).toBeNull();
    expect(n.pnl[1]).toBeCloseTo(n.premium - 30 + n.hedge[1]!.pnl, 9);
    expect(n.hedge[1]!.pnl).toBeCloseTo(Number(hedgeShares(pastModel, 100, { shares: 10, upper: 98, lower: 90 }).toFixed(3)) * 5, 9);
  });

  it("names a night it can't price instead of guessing", () => {
    expect(backtestHedges(nights, [], strategies, opts)).toEqual({ nights: [], skipped: ["2026-09-03 → 2026-09-04"] });
  });
});
