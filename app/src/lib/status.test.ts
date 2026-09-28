import { describe, expect, it } from "vitest";

import type { LedgerRow } from "./api";
import { keeper } from "./status";

const MON = Date.parse("2026-09-28T13:30:00Z") / 1000;
const TUE = Date.parse("2026-09-29T13:30:00Z") / 1000;
const row = (over: Partial<LedgerRow>): LedgerRow => ({
  chain: "solana",
  series: "S",
  symbol: "TSLA",
  openTs: MON,
  state: "open",
  price: null,
  priceTime: null,
  settleTx: null,
  sales: 1,
  premiums: 8.62,
  maxPayouts: 297.5,
  paid: 0,
  claims: 0,
  ...over,
});
const GRACE = 20 * 60;

describe("keeper status", () => {
  it("is fine before and just after an open, and names what comes next", () => {
    expect(keeper([row({})], MON - 60, GRACE)).toEqual({ state: "ok", detail: "Nothing has settled yet. Next: TSLA at the Mon 28 Sep, 09:30 ET open." });
    expect(keeper([row({})], MON + GRACE, GRACE).state).toBe("ok");
  });

  it("flags a series still open past the grace period", () => {
    expect(keeper([row({})], MON + 3600, GRACE)).toEqual({
      state: "warn",
      detail: "TSLA's Mon 28 Sep, 09:30 ET series is 60 minutes past its open and not settled yet.",
    });
  });

  it("reports the last settlement with its transaction", () => {
    const settled = row({ state: "settled", price: 368.09007, settleTx: "2si1" });
    expect(keeper([settled, row({ openTs: TUE })], MON + 7200, GRACE)).toEqual({
      state: "ok",
      detail: "Last settled TSLA at $368.09 for the Mon 28 Sep, 09:30 ET open. Next: TSLA at the Tue 29 Sep, 09:30 ET open.",
      href: "https://explorer.solana.com/tx/2si1?cluster=devnet",
    });
  });
});
