import { describe, expect, it } from "vitest";

import data from "../research/data/pyth-tsla-gaps.json" with { type: "json" };
import type { Opening } from "../pricing/model";
import { gapReport } from "../quoter/gapReport";
import type { Market } from "../quoter/quoter";
import { describeGapReport } from "./tools";

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
