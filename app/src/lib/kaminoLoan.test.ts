import { describe, expect, it } from "vitest";

import { loanBand, loanRisk, toLoan, type KaminoObligation, type KaminoLoan } from "./kaminoLoan";

const SF = 2n ** 60n;
const sf = (usd: number) => (BigInt(Math.round(usd * 1e6)) * SF / 1_000_000n).toString();
const RESERVES = new Map([
  ["tsla-reserve", "TSLAx"],
  ["spy-reserve", "SPYx"],
  ["usdc-reserve", "USDC"],
]);

/** An obligation shaped as Kamino's API returns it, trimmed to what's read. */
const obligation = (deposits: [string, number][], debt: number, limit: number, total: number): KaminoObligation => ({
  obligationAddress: "obligation",
  state: {
    lendingMarket: "market",
    deposits: [...deposits.map(([r, v]) => ({ depositReserve: r, marketValueSf: sf(v) })), { depositReserve: "11111111111111111111111111111111", marketValueSf: "0" }],
  },
  refreshedStats: { userTotalBorrowBorrowFactorAdjusted: String(debt), borrowLiquidationLimit: String(limit), userTotalDeposit: String(total) },
});

const loan = (stocks: { symbol: string; usd: number }[], debtUsd: number, liquidationLimitUsd: number, depositUsd: number): KaminoLoan => ({
  obligation: "o",
  market: "m",
  debtUsd,
  liquidationLimitUsd,
  depositUsd,
  stocks,
});

describe("a Kamino loan", () => {
  it("values each stock deposit at its share of the current total", () => {
    // Deposits last refreshed at $6,000 and $2,000; they're worth $10,000 together now.
    const l = toLoan(obligation([["tsla-reserve", 6_000], ["usdc-reserve", 2_000]], 3_000, 4_000, 10_000), RESERVES);
    expect(l?.stocks.map((s) => ({ ...s, usd: Math.round(s.usd) }))).toEqual([{ symbol: "TSLA", usd: 7_500 }]);
    expect(l).toMatchObject({ debtUsd: 3_000, liquidationLimitUsd: 4_000, depositUsd: 10_000 });
  });

  it("isn't a loan without debt, with only dust, or without a tokenized stock", () => {
    expect(toLoan(obligation([["tsla-reserve", 5_000]], 0, 2_000, 5_000), RESERVES)).toBeNull();
    expect(toLoan(obligation([["tsla-reserve", 0.4]], 0.1, 0.16, 0.4), RESERVES)).toBeNull();
    expect(toLoan(obligation([["usdc-reserve", 5_000]], 1_000, 4_000, 5_000), RESERVES)).toBeNull();
  });

  it("finds the opening that liquidates it: $10,000 of TSLA at a 40% threshold, $3,000 borrowed", () => {
    // Liquidatable once 0.4 × 10,000 × (1 − g) < 3,000: g = 25%.
    expect(loanRisk(loan([{ symbol: "TSLA", usd: 10_000 }], 3_000, 4_000, 10_000)).together).toBeCloseTo(0.25);
  });

  it("counts only the stocks falling, and each stock alone", () => {
    // $6,000 TSLA, $2,000 SPY and $2,000 USDC at 50%: $5,000 limit, $1,000 of room.
    const r = loanRisk(loan([{ symbol: "TSLA", usd: 6_000 }, { symbol: "SPY", usd: 2_000 }], 4_000, 5_000, 10_000));
    expect(r.together).toBeCloseTo(0.25);
    expect(r.alone[0]!.gap).toBeCloseTo(1 / 3);
    // SPY alone would have to lose everything and more.
    expect(r.alone[1]!.gap).toBeNull();
  });

  it("is liquidatable already when the debt is past the limit", () => {
    expect(loanRisk(loan([{ symbol: "TSLA", usd: 10_000 }], 4_500, 4_000, 10_000)).together).toBe(0);
  });

  it("sizes protection down to the gap that liquidates it, or falls back to 2% to 10%", () => {
    expect(loanBand(0.2537)).toEqual({ start: 2, stop: 25.3, toLiquidation: true });
    expect(loanBand(0.031)).toEqual({ start: 1.5, stop: 3.1, toLiquidation: true });
    expect(loanBand(0.64)).toEqual({ start: 2, stop: 10, toLiquidation: false });
    expect(loanBand(null)).toEqual({ start: 2, stop: 10, toLiquidation: false });
    expect(loanBand(0)).toEqual({ start: 2, stop: 10, toLiquidation: false });
  });
});
