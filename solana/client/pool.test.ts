import { describe, expect, it } from "vitest";

import { assetsFor, bpsOf, maxPayoutUnits, roomLeft, saleRefusal, sharesFor, stakeOf, totalAssets, type RequestView } from "./pool";

const USD = 1_000_000n;

describe("Solana pool math", () => {
  // The cases in math.rs's own tests.
  it("matches the program's rounding", () => {
    expect(bpsOf(4n * USD, 200)).toBe(80_000n);
    expect(bpsOf(49n, 200)).toBe(0n);
    expect(totalAssets(1_000n, { pendingDepositAssets: 100n, reservedAssets: 200n, tipsOwed: 10n, locked: 300n })).toBe(390n);
    expect(totalAssets(1_000n, { pendingDepositAssets: 900n, reservedAssets: 0n, tipsOwed: 0n, locked: 101n })).toBe(0n);
    expect(sharesFor(1_000n * USD, 0n, 0n)).toBe(1_000n * USD);
    expect(assetsFor(1_000n * USD, 0n, 0n)).toBe(1_000n * USD);
    expect(sharesFor(102n, 101n, 100n)).toBe(101n);
    expect(assetsFor(101n, 101n, 100n)).toBe(102n);
    // 10 shares protected from $360 to $340: $200.
    expect(maxPayoutUnits(10n * 1_000_000n, 360n * 100_000_000n, 340n * 100_000_000n, USD)).toBe(200n * USD);
  });

  const request = (r: Partial<RequestView>): RequestView => ({
    depositRound: 0n,
    depositAssets: 0n,
    redeemRound: 0n,
    redeemShares: 0n,
    filledDepositAssets: 0n,
    filledDepositShares: 0n,
    filledRedeemShares: 0n,
    filledRedeemAssets: 0n,
    ...r,
  });

  it("shows a request queued this round as pending, and one from a rolled round as filled at its rate", () => {
    const r = request({ depositRound: 4n, depositAssets: 1_000n * USD, redeemRound: 5n, redeemShares: 10n * USD, filledRedeemAssets: 7n });
    expect(stakeOf(r, 5n, { deposit: { assets: 99_000n * USD, supply: 100_000n * USD } })).toEqual({
      pendingDeposit: 0n,
      pendingRedeemShares: 10n * USD,
      claimableDeposit: 1_000n * USD,
      claimableShares: sharesFor(1_000n * USD, 99_000n * USD, 100_000n * USD),
      claimableRedeemShares: 0n,
      claimableAssets: 7n,
    });
    expect(stakeOf(r, 4n).pendingDeposit).toBe(1_000n * USD);
    expect(() => stakeOf(r, 5n)).toThrow("round 4");
    expect(stakeOf(null, 5n).claimableShares).toBe(0n);
  });

  // pool.rs's a_round_locks_at_most_half_the_pool_and_a_fifth_on_one_stock, on $100,000.
  it("refuses what buy refuses", () => {
    const v = { roundOpenTs: 0n, roundNav: 100_000n * USD, locked: 0n, maxUtilizationBps: 5_000, maxFeedBps: 2_000 };
    expect(saleRefusal(v, 0n, 1_790_343_000n, 20_000n * USD)).toBeNull();
    expect(saleRefusal(v, 20_000n * USD, 1_790_343_000n, 1n)).toBe("over-stock-limit");
    const full = { ...v, roundOpenTs: 1_790_343_000n, locked: 50_000n * USD };
    expect(saleRefusal(full, 0n, 1_790_343_000n, 1n)).toBe("over-capacity");
    expect(saleRefusal(full, 0n, 1_790_343_000n + 86_400n, 0n)).toBe("wrong-round");
    expect(saleRefusal({ ...v, roundNav: 0n }, 0n, 1_790_343_000n, 1n)).toBe("over-capacity");
    expect(roomLeft({ ...v, locked: 40_000n * USD }, 5_000n * USD)).toEqual({ round: 10_000n * USD, stock: 10_000n * USD });
    expect(roomLeft({ ...v, locked: 20_000n * USD }, 15_000n * USD)).toEqual({ round: 30_000n * USD, stock: 5_000n * USD });
  });
});
