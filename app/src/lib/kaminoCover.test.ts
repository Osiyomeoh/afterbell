import { describe, expect, it } from "vitest";

import { coverPayout, coverPlan, shortfall } from "./kaminoCover";
import type { KaminoLoan } from "./kaminoLoan";

// $1,000 of stock at an 80% threshold: limit $800; $600 borrowed leaves $200 of room, a 25% gap.
const loan: KaminoLoan = {
  obligation: "o",
  market: "m",
  debtUsd: 600,
  liquidationLimitUsd: 800,
  depositUsd: 1000,
  stocks: [
    { symbol: "TSLA", usd: 600 },
    { symbol: "NVDA", usd: 400 },
  ],
};

describe("coverPlan", () => {
  it("starts every stock at the gap that liquidates the loan, sized by the threshold", () => {
    const p = coverPlan(loan);
    expect(p.action).toBe("cover");
    if (p.action !== "cover") return;
    expect(p.gap).toBeCloseTo(0.25);
    expect(p.lines).toEqual([
      { symbol: "TSLA", startBps: 2500, depthBps: 1000, notionalUsd: 480 },
      { symbol: "NVDA", startBps: 2500, depthBps: 1000, notionalUsd: 320 },
    ]);
  });

  it("pays back exactly the shortfall through the band", () => {
    const p = coverPlan(loan);
    if (p.action !== "cover") throw new Error("expected cover");
    for (const drop of [0.1, 0.25, 0.3, 0.35]) expect(coverPayout(p.lines, drop)).toBeCloseTo(shortfall(loan, drop));
    expect(coverPayout(p.lines, 0.5)).toBeCloseTo(80);
  });

  it("covers one stock falling alone, which liquidates deeper", () => {
    const p = coverPlan(loan);
    if (p.action !== "cover") throw new Error("expected cover");
    const tsla = p.lines.filter((l) => l.symbol === "TSLA");
    // TSLA alone liquidates at 200 / (0.8 × 600) ≈ 41.7%; at 45% the shortfall is 0.8 × 600 × 0.45 − 200 = 16.
    expect(coverPayout(tsla, 0.45)).toBeGreaterThanOrEqual(0.8 * 600 * 0.45 - 200);
  });

  it("caps the depth at what's priced and leaves out stocks it can't cover", () => {
    const deep = { ...loan, debtUsd: 800 - 0.8 * 1000 * 0.45 };
    const p = coverPlan(deep, { covered: (s) => s === "TSLA" });
    if (p.action !== "cover") throw new Error("expected cover");
    expect(p.lines).toEqual([{ symbol: "TSLA", startBps: 4500, depthBps: 500, notionalUsd: 480 }]);
  });

  it("skips loans it can't help", () => {
    expect(coverPlan({ ...loan, debtUsd: 900 }).action).toBe("skip");
    expect(coverPlan({ ...loan, debtUsd: 100 }).action).toBe("skip");
    expect(coverPlan(loan, { covered: () => false })).toEqual({ action: "skip", reason: "none of its stocks are covered" });
  });
});
