import { describe, expect, it } from "vitest";

import { claimUnits, plan, settlementTimingError, type PositionView, type SeriesView } from "./plan";

const OPEN = 1_790_602_200; // Monday 28 Sep 2026, 09:30 EDT
const VAULT = { settleWindowSecs: 60, voidDelaySecs: 86_400 };
const series = (address: string, state: SeriesView["state"], openTs = OPEN): SeriesView => ({ address, feedId: "0x16", openTs, state });
const position = (address: string, s: string): PositionView => ({ address, series: s, buyer: "B" });

describe("keeper plan", () => {
  it("waits for the open, then settles", () => {
    const s = [series("S", "open")];
    expect(plan(OPEN - 1, VAULT, s, []).waiting).toEqual([{ series: "S", reason: "opens at 2026-09-28T13:30:00.000Z" }]);
    expect(plan(OPEN, VAULT, s, []).settle.map((x) => x.address)).toEqual(["S"]);
    expect(plan(OPEN + VAULT.voidDelaySecs, VAULT, s, []).settle.map((x) => x.address)).toEqual(["S"]);
  });

  it("voids a series nobody settled within the delay, as the program allows", () => {
    const p = plan(OPEN + VAULT.voidDelaySecs + 1, VAULT, [series("S", "open")], []);
    expect(p.void.map((x) => x.address)).toEqual(["S"]);
    expect(p.settle).toEqual([]);
  });

  it("claims every position in settled and voided series, and only those", () => {
    const s = [series("SETTLED", "settled"), series("VOIDED", "voided"), series("OPEN", "open")];
    const positions = [position("P1", "SETTLED"), position("P2", "VOIDED"), position("P3", "OPEN"), position("P4", "SETTLED")];
    expect(plan(OPEN + 10, VAULT, s, positions).claim.map((p) => p.address)).toEqual(["P1", "P2", "P4"]);
  });
});

describe("settlement timing, as math::check_settlement_timing", () => {
  it("accepts the first print at or after the open, inside the window", () => {
    expect(settlementTimingError(OPEN, OPEN - 1, OPEN, 60)).toBeNull();
    expect(settlementTimingError(OPEN + 60, OPEN - 5, OPEN, 60)).toBeNull();
  });

  it("rejects prints before the open, after the window, or not first", () => {
    expect(settlementTimingError(OPEN - 1, OPEN - 2, OPEN, 60)).toBe("the print is before the open");
    expect(settlementTimingError(OPEN + 61, OPEN - 1, OPEN, 60)).toBe("the first print came more than 60s after the open");
    expect(settlementTimingError(OPEN + 2, OPEN, OPEN, 60)).toBe("not the first print after the open");
  });
});

describe("claim amounts, as math::payout_at", () => {
  // 1 share protected from $370.32 down to $340.09, premium 0.874887 TestUSD.
  const pos = { shares: 1_000_000n, upper: 37_032_000_000n, lower: 34_009_000_000n, premium: 874_887n };
  const unit = 1_000_000n;

  it("pays nothing at or above the upper strike", () => {
    expect(claimUnits("settled", pos, 37_032_000_000n, unit)).toBe(0n);
    expect(claimUnits("settled", pos, 38_000_000_000n, unit)).toBe(0n);
  });

  it("pays the loss below it, capped at the spread, rounded down", () => {
    expect(claimUnits("settled", pos, 36_000_000_000n, unit)).toBe(10_320_000n);
    expect(claimUnits("settled", pos, 37_031_999_999n, unit)).toBe(0n); // 0.00000001 × 1 share rounds down to nothing
    expect(claimUnits("settled", pos, 30_000_000_000n, unit)).toBe(30_230_000n);
  });

  it("refunds the premium when the series voided", () => {
    expect(claimUnits("voided", pos, 0n, unit)).toBe(874_887n);
  });
});
