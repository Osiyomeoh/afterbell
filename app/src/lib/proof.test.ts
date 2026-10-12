import { describe, expect, it } from "vitest";

import type { KaminoLoan } from "./kaminoLoan";
import { headToHead } from "./proof";

// $10,000 of TSLA at 65%: limit $6,500; $6,000 borrowed goes under past a 7.7% gap.
const loan: KaminoLoan = {
  obligation: "o",
  market: "m",
  debtUsd: 6000,
  liquidationLimitUsd: 6500,
  depositUsd: 10_000,
  stocks: [{ symbol: "TSLA", usd: 10_000 }],
};

describe("headToHead", () => {
  it("covers a weeknight liquidation that weekend cover misses, and shows a weekend payout with nothing to repay", () => {
    const p = headToHead(
      loan,
      [
        { from: "a", to: "b", gap: -0.088, weekend: false },
        { from: "c", to: "d", gap: -0.04, weekend: true },
        { from: "e", to: "f", gap: 0.02, weekend: false },
      ],
      { trigger: 0.03, binaryUsd: 500 },
    );
    expect(p.openings).toBe(3);
    expect(p.liquidations).toBe(1);
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0]!.shortfall).toBeCloseTo(72);
    expect(p.rows[0]!.banded).toBeCloseTo(72, 0);
    expect(p.rows[0]!.binary).toBe(0);
    expect(p.rows[1]).toMatchObject({ shortfall: 0, banded: 0, binary: 500 });
    expect(p.bandedCovered).toBe(1);
    expect(p.binaryCovered).toBe(0);
  });
});
