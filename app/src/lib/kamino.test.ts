import { describe, expect, it } from "vitest";

import { kaminoBook, stockOf } from "./kamino";

describe("Kamino's tokenized-stock collateral", () => {
  it("reads an xStock's ticker from its token and leaves lent assets out", () => {
    expect(["SPYx", "TSLAx", "STRCx", "USDC", "cbBTC", "PYUSD"].map(stockOf)).toEqual(["SPY", "TSLA", "STRC", null, null, null]);
  });

  it("sums each stock over the markets, and counts what's borrowed against them", () => {
    // Two of the markets, as the API reported them on 28 Sep 2026 (rounded).
    const b = kaminoBook([
      { name: "xStocks Market", address: "a", reserves: [
        { liquidityToken: "SPYx", totalSupplyUsd: 4_306_210, totalBorrowUsd: 90_856 },
        { liquidityToken: "TSLAx", totalSupplyUsd: 2_721_131, totalBorrowUsd: 4_478 },
        { liquidityToken: "METAx", totalSupplyUsd: 0.6, totalBorrowUsd: 0 },
        { liquidityToken: "USDC", totalSupplyUsd: 5_626_020, totalBorrowUsd: 5_114_992 },
      ] },
      { name: "Sentora xStocks Market", address: "b", reserves: [
        { liquidityToken: "SPYx", totalSupplyUsd: 1_175_733, totalBorrowUsd: 0 },
        { liquidityToken: "PYUSD", totalSupplyUsd: 7_000_584, totalBorrowUsd: 1_073_336 },
      ] },
    ]);
    expect(b.collateral).toEqual([{ symbol: "SPY", usd: 5_481_943 }, { symbol: "TSLA", usd: 2_721_131 }]);
    expect(b.collateralUsd).toBe(8_203_074);
    expect(b.borrowedUsd).toBe(6_188_328);
  });
});
