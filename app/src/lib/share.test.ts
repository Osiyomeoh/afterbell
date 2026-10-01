import { describe, expect, it } from "vitest";

import { headline, outcome, sharePath, shareText, type ShareView } from "./share";

// Monday 28 Sep 2026, 09:30 EDT: the first settlement, TSLA at $368.09.
const MON = Date.parse("2026-09-28T13:30:00Z") / 1000;
// Friday 2 Oct 2026, 09:30 EDT: Tesla's third-quarter deliveries.
const FRI = Date.parse("2026-10-02T13:30:00Z") / 1000;

const view = (over: Partial<ShareView>): ShareView => ({
  chain: "solana",
  id: "Hh7GNLrx8enSC3a92MAyzR8qZjY6Arq6D53dVQJ8s9Eo",
  number: "1",
  symbol: "TSLA",
  openTs: MON,
  shares: 10,
  upper: 364.45,
  lower: 334.7,
  premium: 8.62,
  maxPayout: 297.5,
  state: "open",
  price: null,
  payout: null,
  art: "/api/position-art/solana/Hh7G/image",
  ...over,
});

describe("share cards", () => {
  it("says what open protection covers, and names the event its open is expected to carry", () => {
    expect(headline(view({}))).toBe("10 shares of TSLA, protected until Monday's opening bell");
    expect(outcome(view({}))).toBe(
      "10 shares of TSLA, protected from $364.45 down to $334.70 until the 09:30 ET open on Mon 28 Sep. It cost $8.62 and pays up to $297.50, settled on the opening price.",
    );
    const fri = view({ openTs: FRI });
    expect(outcome(fri)).toContain("the one expected to carry Tesla's third-quarter deliveries");
    expect(shareText(fri)).toBe(
      "I protected 10 shares of TSLA until Friday's opening bell, through Tesla's third-quarter deliveries, with Afterbell: $8.62 for up to $297.50. Test money, real oracle.",
    );
  });

  it("says what a settled position paid, or that it opened above it", () => {
    const paid = view({ shares: 1, upper: 370.32, lower: 340.09, premium: 0.87, maxPayout: 30.23, state: "settled", price: 368.09, payout: 2.23 });
    expect(headline(paid)).toBe("Paid $2.23 when TSLA opened at $368.09");
    expect(outcome(paid)).toBe("TSLA opened at $368.09 on Mon 28 Sep, below $370.32 where this protection started. It paid $2.23 for a $0.87 premium.");
    expect(shareText(paid)).toBe("TSLA opened at $368.09 and my Afterbell protection paid $2.23, for $0.87. Test money, real oracle.");

    const above = view({ state: "settled", price: 368.09, payout: 0 });
    expect(headline(above)).toBe("TSLA opened at $368.09, above this protection");
    expect(outcome(above)).toContain("so it paid nothing. The $8.62 premium went to the pool's underwriters.");

    const floor = view({ state: "settled", price: 330, payout: 297.5 });
    expect(outcome(floor)).toContain("It paid the most it could, $297.50");
  });

  it("says a voided series refunded the premium, and every share text says it's test money", () => {
    const voided = view({ state: "voided", payout: 8.62 });
    expect(headline(voided)).toBe("TSLA's opening couldn't be settled: premium refunded");
    for (const v of [view({}), voided, view({ state: "settled", price: 368.09, payout: 0 })]) expect(shareText(v)).toMatch(/Test money, real oracle\.$/);
    expect(sharePath("robinhood", "7")).toBe("/p/robinhood/7");
  });
});
