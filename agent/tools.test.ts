import { describe, expect, it } from "vitest";

import data from "../research/data/pyth-tsla-gaps.json" with { type: "json" };
import type { Opening } from "../pricing/model";
import { gapReport } from "../quoter/gapReport";
import type { Market } from "../quoter/quoter";
import { describeGapReport, describeLoans } from "./tools";

const FRIDAY_EVENING = Date.parse("2026-09-26T00:00:00Z") / 1000;
const TSLA: Market = { symbol: "TSLA", close: 380, live: 380, history: data.gaps as Opening[], annualVol: 0.6, holidays: new Set() };

describe("describeGapReport", () => {
  it("says what the book is worth, what protecting it costs, its worst night and what it left out", () => {
    const r = gapReport(FRIDAY_EVENING, [{ symbol: "TSLA", shares: 100 }, { symbol: "XYZ", shares: 1 }], new Map([["TSLA", TSLA]]), { deductible: 0.02, depth: 0.1 });
    const text = describeGapReport({ ...r, names: { TSLA: "Tesla" } });
    const l = r.lines[0]!;
    expect(text).toContain("The book is worth $38,000.00 across 1 stock.");
    expect(text).toContain("from 2% to 10% below each price, until Mon, Sep 28, 09:30 ET");
    expect(text).toContain("TSLA (Tesla): 100 shares");
    expect(text).toContain("on 2 of 46 openings since 2026-07-22; the worst was -8.8% on 2026-07-23");
    expect(text).toContain(`Protecting it costs $${"premium" in l.tonight ? l.tonight.premium.toFixed(2) : "?"}`);
    expect(text).toContain("Not in the report: XYZ (not covered).");
  });
});

describe("describeLoans", () => {
  it("says where the loan breaks, how often its stock has gone that far, and what cover down to it costs", () => {
    // $38,000 of TSLA at a 40% threshold with $11,400 borrowed: liquidatable 25% down.
    const r = gapReport(FRIDAY_EVENING, [{ symbol: "TSLA", value: 38_000 }], new Map([["TSLA", TSLA]]), { deductible: 0.02, depth: 0.25 }, undefined, [0.25]);
    const text = describeLoans({
      wallet: "wallet",
      readAt: FRIDAY_EVENING,
      loans: [
        {
          obligation: "obligation",
          market: "market",
          marketName: "xStocks Market",
          debtUsd: 11_400,
          liquidationLimitUsd: 15_200,
          depositUsd: 38_000,
          stocks: [{ symbol: "TSLA", usd: 38_000 }],
          risk: { together: 0.25, alone: [{ symbol: "TSLA", gap: 0.25 }] },
          band: { start: 2, stop: 25, toLiquidation: true },
          report: { ...r, names: { TSLA: "Tesla" } },
        },
      ],
    });
    expect(text).toContain("xStocks Market loan obligation: $11,400.00 borrowed against $38,000.00 of collateral (TSLA $38,000.00).");
    expect(text).toContain("It becomes liquidatable if its stocks open 25.0% below today's price together. Each alone: TSLA 25.0%.");
    expect(text).toContain("TSLA has opened that far down on 0 of 46 recorded openings (worst -8.8% on 2026-07-23), and the pricing model gives it less than a 0.01% chance of opening that far down tonight.");
    expect(text).toContain("Protection from 2% to 25% below each price, down to where the loan becomes liquidatable, until Mon, Sep 28, 09:30 ET");
    expect(text).toContain("it doesn't stop a liquidation");
  });

  it("says so when the wallet has no loan", () => {
    expect(describeLoans({ wallet: "w", readAt: 0, loans: [] })).toBe("w has no loan against tokenized stocks in Kamino's markets.");
  });
});
