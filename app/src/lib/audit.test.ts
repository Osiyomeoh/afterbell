import { describe, expect, it } from "vitest";
import { audit } from "./audit";
import type { AuditRow } from "@/server/vaultTypes";

const row = (o: Partial<AuditRow>): AuditRow => ({
  address: "p", series: "s", symbol: "TSLA", buyer: "b", openTs: 0, state: "settled",
  shares: 10, upper: 100, lower: 90, premium: 3, maxPayout: 100, claimable: null, settlementPrice: 95,
  paid: null, forfeited: false, ...o,
});

describe("audit", () => {
  it("passes a payout the terms owe", () => expect(audit([row({ paid: 50 })])[0]).toMatchObject({ expected: 50, verdict: "ok" }));
  it("caps at the spread", () => expect(audit([row({ settlementPrice: 50, paid: 100 })])[0]!.verdict).toBe("ok"));
  it("flags a wrong payout", () => expect(audit([row({ paid: 49 })])[0]!.verdict).toBe("mismatch"));
  it("expects the premium back when voided", () => expect(audit([row({ state: "voided", paid: 3 })])[0]).toMatchObject({ expected: 3, verdict: "ok" }));
  it("skips open series and marks unpaid and forfeited", () => {
    expect(audit([row({ state: "open" })])).toHaveLength(0);
    expect(audit([row({})])[0]!.verdict).toBe("unpaid");
    expect(audit([row({ paid: 0, forfeited: true })])[0]!.verdict).toBe("forfeited");
  });
});
