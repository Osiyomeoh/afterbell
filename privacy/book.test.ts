import { describe, expect, it } from "vitest";

import { owed, roundDeposit, toUnits, type DeskEntry } from "./book";

const entry: DeskEntry = {
  symbol: "TSLA",
  shares: 2,
  upper: 360,
  lower: 330,
  openTs: 1_790_775_000,
  premium: 3.41,
  holder: "ab",
  holderWallet: "wallet",
  position: "position",
  series: "series",
  txs: { deposit: "d", premium: "p", buy: "b" },
};

describe("the private desk's book", () => {
  it("deposits a round amount, so the public deposit doesn't show the premium", () => {
    expect(roundDeposit(toUnits(3.41))).toBe(toUnits(10));
    expect(roundDeposit(toUnits(10))).toBe(toUnits(20));
    expect(roundDeposit(toUnits(27.5))).toBe(toUnits(30));
  });

  it("owes nothing until the series is done", () => {
    expect(owed(entry, { state: "open", price: null })).toBeNull();
  });

  it("owes the payout at the settlement price, capped at the floor", () => {
    expect(owed(entry, { state: "settled", price: 370 })).toBe(0n);
    expect(owed(entry, { state: "settled", price: 352.345678 })).toBe(toUnits(15.308644));
    expect(owed(entry, { state: "settled", price: 300 })).toBe(toUnits(60));
  });

  it("owes the premium back when the series is voided", () => {
    expect(owed(entry, { state: "voided", price: null })).toBe(toUnits(3.41));
  });
});
