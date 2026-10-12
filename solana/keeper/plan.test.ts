import { describe, expect, it } from "vitest";

import { claimUnits, plan, rollBlocked, settlementError, settlementTimingError, toPrice8, type PositionView, type SeriesView } from "./plan";

const OPEN = 1_790_602_200; // Monday 28 Sep 2026, 09:30 EDT
const VAULT = { settleWindowSecs: 60, voidDelaySecs: 86_400 };
const series = (address: string, state: SeriesView["state"], openTs = OPEN): SeriesView => ({
  address,
  feedId: "0x16",
  openTs,
  state,
  lowestLower: 34_000_000_000n,
  highestUpper: 37_000_000_000n,
});
const position = (address: string, s: string): PositionView => ({ address, series: s, mint: "M", buyer: "B" });

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

  it("pays every unpaid position in settled and voided series, and only those", () => {
    const s = [series("SETTLED", "settled"), series("VOIDED", "voided"), series("OPEN", "open")];
    const positions = [position("P1", "SETTLED"), position("P2", "VOIDED"), position("P3", "OPEN"), position("P4", "SETTLED")];
    expect(plan(OPEN + 10, VAULT, s, positions).pay.map((p) => p.address)).toEqual(["P1", "P2", "P4"]);
  });
});

describe("rolling the pool, as handle_roll", () => {
  const round = { roundOpenTs: OPEN, roundUnpaid: 0, pendingDepositAssets: 0n, pendingRedeemShares: 0n };

  it("rolls a round that sold nothing only when a request is waiting", () => {
    const empty = { ...round, roundOpenTs: 0 };
    expect(rollBlocked(OPEN, empty)).toBe("the round sold nothing and no deposit or redemption is waiting");
    expect(rollBlocked(OPEN, { ...empty, pendingDepositAssets: 1n })).toBeNull();
    expect(rollBlocked(OPEN, { ...empty, pendingRedeemShares: 1n })).toBeNull();
  });

  it("rolls a round that sold once its open has passed and every position is closed", () => {
    expect(rollBlocked(OPEN, round)).toBe("the round sells until its open at 2026-09-28T13:30:00.000Z");
    expect(rollBlocked(OPEN + 1, { ...round, roundUnpaid: 2 })).toBe("2 position(s) still to pay out");
    expect(rollBlocked(OPEN + 1, round)).toBeNull();
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

describe("every settle check, as handle_settle", () => {
  const vault = { settleWindowSecs: 60, maxConfBps: 100 };
  // $383.82840 at expo -5, first print one second after the open.
  const print = { price: 38_382_840n, conf: 38_382n, expo: -5, publishTime: OPEN + 1, prevPublishTime: OPEN - 1 };

  it("accepts a timely first print with confidence inside the vault's limit", () => {
    expect(settlementError(print, OPEN, vault)).toBeNull();
    expect(settlementError({ ...print, conf: 383_828n }, OPEN, vault)).toBeNull(); // exactly 100 bps
  });

  it("rejects a confidence interval wider than the vault's limit, which the timing check alone let through", () => {
    expect(settlementError({ ...print, conf: 383_829n }, OPEN, vault)).toBe("the first print's confidence is ±100.0 bps, wider than the vault's 100");
    expect(settlementError({ ...print, conf: 767_657n }, OPEN, vault)).toBe("the first print's confidence is ±200.0 bps, wider than the vault's 100");
  });

  it("refuses a print more than ten times from the strikes, as math::plausible_price", () => {
    const strikes = { lowestLower: 34_000_000_000n, highestUpper: 37_000_000_000n };
    expect(settlementError(print, OPEN, vault, strikes)).toBeNull();
    // $3,700 is exactly ten times the highest upper strike; a cent more is a broken feed.
    expect(settlementError({ ...print, price: 370_000_000n, conf: 0n }, OPEN, vault, strikes)).toBeNull();
    expect(settlementError({ ...print, price: 370_000_001n, conf: 0n }, OPEN, vault, strikes)).toMatch("more than ten times");
    expect(settlementError({ ...print, price: 3_399_999n, conf: 0n }, OPEN, vault, strikes)).toMatch("more than ten times");
  });

  it("checks timing first, then the price, as the program does", () => {
    expect(settlementError({ ...print, publishTime: OPEN + 61, conf: 10n ** 9n }, OPEN, vault)).toBe("the first print came more than 60s after the open");
    expect(settlementError({ ...print, price: 0n }, OPEN, vault)).toBe("the price is not positive");
  });
});

describe("prices with 8 decimals, as math::to_price_8", () => {
  it("scales coarser prices up exactly", () => {
    expect(toPrice8(38_382_840n, -5)).toBe(38_382_840_000n);
    expect(toPrice8(12_345n, -8)).toBe(12_345n);
    expect(toPrice8(5n, 0)).toBe(500_000_000n);
  });

  it("rounds finer prices up, never down", () => {
    expect(toPrice8(1_000_000_001n, -9)).toBe(100_000_001n);
    expect(toPrice8(1_000_000_000n, -9)).toBe(100_000_000n);
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
