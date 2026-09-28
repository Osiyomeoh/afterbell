import { describe, expect, it } from "vitest";

import type { LedgerRow } from "./api";
import { bookResult } from "./book";
import { signedUsd } from "./format";

const MON = Date.parse("2026-09-28T13:30:00Z") / 1000;
const row = (over: Partial<LedgerRow>): LedgerRow => ({
  chain: "solana",
  series: "S",
  symbol: "TSLA",
  openTs: MON,
  state: "settled",
  price: 368.09007,
  priceTime: MON,
  settleTx: null,
  sales: 1,
  premiums: 0,
  maxPayouts: 0,
  paid: 0,
  claims: 0,
  ...over,
});
// Monday 28 Sep, as it settled: both Solana vaults on one opening, and the hedge's first session.
const monday = [row({ premiums: 8.61989 }), row({ series: "V1", sales: 5, premiums: 8.262678, paid: 4.45986, claims: 5 })];
const hedge = { since: MON - 86_400, fills: [], trades: 16, fees: 0.319352, closedPnl: 5.214921, funding: 0, fundingPayments: 0 };

describe("the book's result", () => {
  it("counts an opening settled in both vaults once, and adds the hedge's closed trades less fees", () => {
    const b = bookResult(monday, hedge);
    expect(b.openings).toBe(1);
    expect(b.premiums).toBeCloseTo(16.882568, 6);
    expect(b.paidOut).toBeCloseTo(4.45986, 6);
    expect(b.underwriting).toBeCloseTo(12.422708, 6);
    expect(b.hedge).toBeCloseTo(4.895569, 6);
    expect(b.net).toBeCloseTo(17.318277, 6);
  });

  it("leaves out openings still to come, and has no hedge figure without an account", () => {
    const b = bookResult([...monday, row({ openTs: MON + 86_400, state: "open", premiums: 100 })], null);
    expect(b.premiums).toBeCloseTo(16.882568, 6);
    expect(b.hedge).toBeNull();
    expect(b.net).toBeCloseTo(12.422708, 6);
  });

  it("signs a result", () => {
    expect([signedUsd(5.214921), signedUsd(-4.45986), signedUsd(0), signedUsd(-0.001)]).toEqual(["+$5.21", "−$4.46", "$0.00", "$0.00"]);
  });
});
