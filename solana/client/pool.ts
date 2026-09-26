/**
 * The Solana vault v2 pool's arithmetic, as the program does it (math.rs and
 * pool.rs), for reading the pool: what it's worth, what an underwriter's
 * requests fill at, and whether a sale fits the round's limits. Pure, so each
 * rule is tested against the program's own cases.
 */

/** math::bps_of: `amount × bps / 10_000`, rounded down. */
export const bpsOf = (amount: bigint, bps: number) => (amount * BigInt(bps)) / 10_000n;

/** math::shares_for: shares for `assets` at a roll's rate, rounded down. */
export const sharesFor = (assets: bigint, poolAssets: bigint, supply: bigint) => (assets * (supply + 1n)) / (poolAssets + 1n);

/** math::assets_for: assets for `shares` at a roll's rate, rounded down. */
export const assetsFor = (shares: bigint, poolAssets: bigint, supply: bigint) => (shares * (poolAssets + 1n)) / (supply + 1n);

/** math::payout_units over the whole range: the most a position can pay, in collateral units. */
export const maxPayoutUnits = (shares: bigint, upper: bigint, lower: bigint, collateralUnit: bigint) =>
  (shares * (upper - lower) * collateralUnit) / (1_000_000n * 100_000_000n);

/** The vault's own figures that aren't the pool's, and what its open positions lock. */
export type VaultBooks = { pendingDepositAssets: bigint; reservedAssets: bigint; tipsOwed: bigint; locked: bigint };

/**
 * math::total_assets: the vault's balance less queued deposits, redemptions
 * owed, keepers' tips and the most its open positions could pay. Exact
 * between a roll and the round's first sale, conservative during a round.
 * Zero rather than negative if the balance was read at a different slot.
 */
export function totalAssets(balance: bigint, v: VaultBooks): bigint {
  const assets = balance - v.pendingDepositAssets - v.reservedAssets - v.tipsOwed - v.locked;
  return assets > 0n ? assets : 0n;
}

/** An underwriter's Request account. */
export type RequestView = {
  depositRound: bigint;
  depositAssets: bigint;
  redeemRound: bigint;
  redeemShares: bigint;
  filledDepositAssets: bigint;
  filledDepositShares: bigint;
  filledRedeemShares: bigint;
  filledRedeemAssets: bigint;
};

/** A RoundRate account: the pool at the roll that ended a round. */
export type RateView = { assets: bigint; supply: bigint };

export type Stake = {
  /** Queued this round, waiting for the roll. */
  pendingDeposit: bigint;
  pendingRedeemShares: bigint;
  /** Filled by earlier rolls and not yet claimed: the deposit and the shares it bought, the shares redeemed and what they're owed. */
  claimableDeposit: bigint;
  claimableShares: bigint;
  claimableRedeemShares: bigint;
  claimableAssets: bigint;
};

/**
 * An underwriter's requests as their next claim sees them. A request queued
 * in a round already rolled fills at that roll's rate (fill_deposit and
 * fill_redeem); `rates` are those rounds' RoundRate accounts, needed only
 * when such a request is waiting.
 */
export function stakeOf(r: RequestView | null, round: bigint, rates: { deposit?: RateView | null; redeem?: RateView | null } = {}): Stake {
  const out: Stake = { pendingDeposit: 0n, pendingRedeemShares: 0n, claimableDeposit: 0n, claimableShares: 0n, claimableRedeemShares: 0n, claimableAssets: 0n };
  if (!r) return out;
  out.claimableDeposit = r.filledDepositAssets;
  out.claimableShares = r.filledDepositShares;
  out.claimableRedeemShares = r.filledRedeemShares;
  out.claimableAssets = r.filledRedeemAssets;
  if (r.depositAssets > 0n) {
    if (r.depositRound >= round) out.pendingDeposit = r.depositAssets;
    else {
      if (!rates.deposit) throw new Error(`the rate for round ${r.depositRound} is needed`);
      out.claimableDeposit += r.depositAssets;
      out.claimableShares += sharesFor(r.depositAssets, rates.deposit.assets, rates.deposit.supply);
    }
  }
  if (r.redeemShares > 0n) {
    if (r.redeemRound >= round) out.pendingRedeemShares = r.redeemShares;
    else {
      if (!rates.redeem) throw new Error(`the rate for round ${r.redeemRound} is needed`);
      out.claimableRedeemShares += r.redeemShares;
      out.claimableAssets += assetsFor(r.redeemShares, rates.redeem.assets, rates.redeem.supply);
    }
  }
  return out;
}

/** The round's limits, as the vault records them. */
export type RoundLimits = { roundOpenTs: bigint; roundNav: bigint; locked: bigint; maxUtilizationBps: number; maxFeedBps: number };

/** What more the round can sell, in maximum payouts: across stocks, and on a stock whose series already locks `seriesLocked`. */
export function roomLeft(v: RoundLimits, seriesLocked = 0n): { round: bigint; stock: bigint } {
  const left = (cap: bigint, used: bigint) => (cap > used ? cap - used : 0n);
  const round = left(bpsOf(v.roundNav, v.maxUtilizationBps), v.locked);
  const stock = left(bpsOf(v.roundNav, v.maxFeedBps), seriesLocked);
  return { round, stock: stock < round ? stock : round };
}

/**
 * Why `buy` would refuse a sale on these limits (its WrongRound, OverCapacity
 * and OverStockLimit checks, in its order), or null if they allow it. A round
 * sells one opening, fixed by its first sale.
 */
export function saleRefusal(v: RoundLimits, seriesLocked: bigint, openTs: bigint, maxPayout: bigint): "wrong-round" | "over-capacity" | "over-stock-limit" | null {
  if (v.roundOpenTs !== 0n && v.roundOpenTs !== openTs) return "wrong-round";
  if (v.locked + maxPayout > bpsOf(v.roundNav, v.maxUtilizationBps)) return "over-capacity";
  if (seriesLocked + maxPayout > bpsOf(v.roundNav, v.maxFeedBps)) return "over-stock-limit";
  return null;
}
