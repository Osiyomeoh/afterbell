import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { backtest } from "./backtest";
import { MIN_HISTORY, openingModel, type Opening, type OpeningModel } from "./model";
import { expectedPut, hedgeShares, normCdf, payout, priceProtection, probabilityBelow, putDelta, type Protection } from "./putSpread";

const TSLA: Opening[] = JSON.parse(readFileSync(join(import.meta.dirname, "..", "research", "data", "pyth-tsla-gaps.json"), "utf8")).gaps;

/** Deterministic uniform RNG (mulberry32), so the Monte Carlo check is repeatable. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleOpen(model: OpeningModel, spot: number, u: () => number): number {
  const c = model.components[Math.floor(u() * model.components.length)]!;
  const z = Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
  return spot * Math.exp(c.mean + c.sd * z);
}

describe("normCdf", () => {
  it("matches tabulated values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1)).toBeCloseTo(0.841344746, 6);
    expect(normCdf(-1.96)).toBeCloseTo(0.024997895, 6);
    expect(normCdf(3)).toBeCloseTo(0.998650102, 6);
  });
});

describe("openingModel", () => {
  it("falls back to a lognormal below MIN_HISTORY openings", () => {
    const m = openingModel(TSLA.slice(0, MIN_HISTORY - 1), { annualVol: 0.6, years: 3 / 365 });
    expect(m.source).toBe("lognormal");
    expect(m.components).toHaveLength(1);
    expect(m.sd).toBeCloseTo(0.6 * Math.sqrt(3 / 365), 12);
  });

  it("builds one kernel per past opening once the history is long enough", () => {
    const m = openingModel(TSLA, { annualVol: 0.6, years: 0 });
    expect(m.source).toBe("history");
    expect(m.components).toHaveLength(TSLA.length);
  });

  it("carries no drift in price: the expected open equals the price now", () => {
    for (const m of [openingModel(TSLA, { annualVol: 0.6, years: 0 }), openingModel([], { annualVol: 0.6, years: 1 })]) {
      const growth = m.components.reduce((a, c) => a + Math.exp(c.mean + c.sd ** 2 / 2), 0) / m.components.length;
      expect(growth).toBeCloseTo(1, 12);
    }
  });

  it("widens with regular-session time still to run", () => {
    const closed = openingModel(TSLA, { annualVol: 0.6, years: 0 });
    const midSession = openingModel(TSLA, { annualVol: 0.6, years: 0, sessionYears: 3.25 / (252 * 6.5) });
    expect(midSession.sd).toBeGreaterThan(closed.sd);
    expect(midSession.components[0]!.sd).toBeGreaterThan(closed.components[0]!.sd);
  });
});

describe("expectedPut", () => {
  it("equals Black-Scholes with zero rates for a single lognormal", () => {
    // S = K = 100, sigma = 20%, T = 1: put = 100 * (2 * N(0.1) - 1) = 7.965567...
    const m = openingModel([], { annualVol: 0.2, years: 1 });
    expect(expectedPut(m, 100, 100)).toBeCloseTo(7.965567, 4);
  });

  it("approaches strike minus spot deep in the money, and zero far out of it", () => {
    const m = openingModel(TSLA, { annualVol: 0.6, years: 0 });
    expect(expectedPut(m, 100, 1000)).toBeCloseTo(900, 6);
    expect(expectedPut(m, 100, 10)).toBeCloseTo(0, 10);
  });

  it("matches a Monte Carlo simulation of the same mixture", () => {
    const m = openingModel(TSLA, { annualVol: 0.6, years: 0 });
    const u = rng(42);
    const p: Protection = { shares: 1, upper: 99, lower: 95 };
    let sum = 0;
    const n = 400_000;
    for (let i = 0; i < n; i++) sum += payout(p, sampleOpen(m, 100, u));
    const exact = priceProtection(m, 100, p, 0).expectedPayout;
    expect(Math.abs(sum / n - exact) / exact).toBeLessThan(0.03);
  });
});

describe("protection", () => {
  const p: Protection = { shares: 10, upper: 360, lower: 340 };

  it("pays nothing above upper, the loss between, and at most the spread", () => {
    expect(payout(p, 365)).toBe(0);
    expect(payout(p, 360)).toBe(0);
    expect(payout(p, 355)).toBe(50);
    expect(payout(p, 340)).toBe(200);
    expect(payout(p, 300)).toBe(200);
  });

  it("prices between zero and the maximum payout, with the margin on top", () => {
    const m = openingModel(TSLA, { annualVol: 0.6, years: 0 });
    const fair = priceProtection(m, 371.54, p, 0);
    const withMargin = priceProtection(m, 371.54, p, 0.1);
    expect(fair.expectedPayout).toBeGreaterThan(0);
    expect(fair.expectedPayout).toBeLessThan(fair.maxPayout);
    expect(withMargin.premium).toBeCloseTo(fair.premium * 1.1, 10);
    expect(fair.probabilityOfPayout).toBeCloseTo(probabilityBelow(m, 371.54, 360), 12);
  });

  it("costs more the closer protection starts to the price", () => {
    const m = openingModel(TSLA, { annualVol: 0.6, years: 0 });
    const near = priceProtection(m, 100, { shares: 1, upper: 99, lower: 95 }, 0).premium;
    const far = priceProtection(m, 100, { shares: 1, upper: 97, lower: 93 }, 0).premium;
    expect(near).toBeGreaterThan(far);
  });

  it("never charges less than the minimum rate of the most it pays", () => {
    // A stock that never moved more than 0.1% overnight: the model alone prices 2%-10% cover at about nothing.
    const quiet: Opening[] = Array.from({ length: 40 }, (_, i) => ({ from: `d${i}`, to: `d${i + 1}`, close: 100, open: 100 * (1 + (i % 2 ? 0.001 : -0.001)), weekend: false }));
    const cover: Protection = { shares: 10, upper: 98, lower: 90 };
    const calm = priceProtection(openingModel(quiet, { annualVol: 0.15, years: 0 }), 100, cover, 0.15, 0.005);
    expect(calm.expectedPayout * 1.15).toBeLessThan(0.005 * calm.maxPayout);
    expect(calm.premium).toBeCloseTo(0.005 * calm.maxPayout, 12);
    // TSLA's own history prices well above the floor, so the floor changes nothing there.
    const m = openingModel(TSLA, { annualVol: 0.6, years: 0 });
    const tsla = priceProtection(m, 371.54, p, 0.15, 0.005);
    expect(tsla.premium).toBeCloseTo(tsla.expectedPayout * 1.15, 12);
    expect(() => priceProtection(m, 100, cover, 0.15, -0.01)).toThrow();
    expect(() => priceProtection(m, 100, cover, 0.15, 1)).toThrow();
  });

  it("rejects malformed protection", () => {
    const m = openingModel(TSLA, { annualVol: 0.6, years: 0 });
    expect(() => priceProtection(m, 100, { shares: 0, upper: 99, lower: 95 }, 0)).toThrow();
    expect(() => priceProtection(m, 100, { shares: 1, upper: 95, lower: 99 }, 0)).toThrow();
    expect(() => priceProtection(m, 100, { shares: 1, upper: 99, lower: 95 }, -0.1)).toThrow();
  });
});

describe("the hedge", () => {
  const m = openingModel(TSLA, { annualVol: 0.6, years: 0 });
  const p: Protection = { shares: 10, upper: 360, lower: 340 };

  it("is Black-Scholes' put delta for a single lognormal", () => {
    // S = K = 100, sigma = 20%, T = 1: delta = -N(-d1) with d1 = 0.1, and N(-0.1) = 0.460172
    const lognormal = openingModel([], { annualVol: 0.2, years: 1 });
    expect(putDelta(lognormal, 100, 100)).toBeCloseTo(0.460172, 5);
  });

  it("is how fast the expected payout rises as the price falls", () => {
    const h = 0.01;
    for (const spot of [330, 345, 355, 362, 375, 400]) {
      const slope = (priceProtection(m, spot - h, p, 0).expectedPayout - priceProtection(m, spot + h, p, 0).expectedPayout) / (2 * h);
      expect(hedgeShares(m, spot, p)).toBeCloseTo(slope, 3);
    }
  });

  it("is at most every share, most with the price inside the spread, and none far from it", () => {
    const at = (spot: number) => hedgeShares(m, spot, p);
    expect(at(350)).toBeGreaterThan(at(380));
    expect(at(350)).toBeGreaterThan(at(320));
    for (const spot of [300, 340, 350, 360, 380]) {
      expect(at(spot)).toBeGreaterThanOrEqual(0);
      expect(at(spot)).toBeLessThanOrEqual(p.shares);
    }
    expect(at(1000)).toBeCloseTo(0, 10);
    expect(at(100)).toBeCloseTo(0, 10);
  });

  it("is every share when the open is sure to land inside the spread", () => {
    const quiet = openingModel([], { annualVol: 0.001, years: 1 / 365 });
    expect(hedgeShares(quiet, 350, p)).toBeCloseTo(10, 6);
  });
});

describe("backtest", () => {
  const structure = { deductible: 0.01, depth: 0.05 };
  const opts = { shares: 10, annualVol: 0.6, margin: 0 };

  it("prices only from earlier openings: changing a later opening leaves earlier premiums alone", () => {
    const base = backtest(TSLA, structure, opts);
    const changed = TSLA.map((o, i) => (i === TSLA.length - 1 ? { ...o, open: o.open * 0.9 } : o));
    const again = backtest(changed, structure, opts);
    expect(again.nights.slice(0, -1).map((n) => n.premium)).toEqual(base.nights.slice(0, -1).map((n) => n.premium));
    expect(again.nights.at(-1)!.paid).toBeGreaterThan(base.nights.at(-1)!.paid);
  });

  it("covers every opening after the first MIN_HISTORY", () => {
    expect(backtest(TSLA, structure, opts).nights).toHaveLength(TSLA.length - MIN_HISTORY);
  });
});
