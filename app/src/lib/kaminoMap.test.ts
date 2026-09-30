import { describe, expect, it } from "vitest";

import { limitAfter, liquidatable, liquidationCurve, type MapLoan } from "./kaminoMap";

// $10,000 of TSLA at a 40% threshold with $3,000 borrowed: liquidatable once TSLA opens 25% down.
const tsla: MapLoan = { market: "m", debt: 3_000, deposits: [{ symbol: "TSLA", value: 10_000, liquidationLtv: 0.4 }] };
// $6,000 of SPY and $4,000 of USDC at 50%, $4,000 borrowed: the $5,000 limit falls $3,000 × gap, so 1/3.
const mixed: MapLoan = {
  market: "m",
  debt: 4_000,
  deposits: [
    { symbol: "SPY", value: 6_000, liquidationLtv: 0.5 },
    { symbol: null, value: 4_000, liquidationLtv: 0.5 },
  ],
};
// Past its limit already.
const underwater: MapLoan = { market: "m", debt: 5_000, deposits: [{ symbol: "NVDA", value: 10_000, liquidationLtv: 0.4 }] };

describe("the liquidation map", () => {
  it("lowers only the stocks' part of a loan's limit", () => {
    expect(limitAfter(mixed, () => 0.1)).toBeCloseTo(2_700 + 2_000, 9);
  });

  it("counts a loan once its stocks open far enough down, and the rest not yet", () => {
    expect(liquidatable([tsla, mixed], () => 0.2)).toEqual({ loans: 0, debt: 0, collateral: 0 });
    expect(liquidatable([tsla, mixed], () => 0.26)).toEqual({ loans: 1, debt: 3_000, collateral: 10_000 });
    expect(liquidatable([tsla, mixed], () => 0.34)).toEqual({ loans: 2, debt: 7_000, collateral: 20_000 });
  });

  it("takes each stock's own gap, such as its worst recorded opening", () => {
    const worst: Record<string, number> = { TSLA: 0.3, SPY: 0.01 };
    expect(liquidatable([tsla, mixed], (s) => worst[s] ?? 0)).toMatchObject({ loans: 1, debt: 3_000 });
  });

  it("starts the curve with what's liquidatable already, and only grows", () => {
    const curve = liquidationCurve([tsla, mixed, underwater], [0, 0.1, 0.3, 0.5]);
    expect(curve.map((r) => r.loans)).toEqual([1, 1, 2, 3]);
    expect(curve[0]).toEqual({ gap: 0, loans: 1, debt: 5_000, collateral: 10_000 });
  });
});
