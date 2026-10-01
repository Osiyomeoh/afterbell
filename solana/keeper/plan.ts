/**
 * What the keeper should do for each series, from the same rules the program
 * enforces (solana/programs/afterbell-vault/src). Pure, so every case is tested.
 */

export type SeriesState = "open" | "settled" | "voided";

/** A series and the strikes it sold, which bound the price it can settle at. */
export type SeriesView = { address: string; feedId: string; openTs: number; state: SeriesState; lowestLower: bigint; highestUpper: bigint };
/** A position not yet paid out, and its NFT's mint (whoever holds it is paid). */
export type PositionView = { address: string; series: string; mint: string };
export type VaultTiming = { settleWindowSecs: number; voidDelaySecs: number };

export type Plan = {
  /** Open series whose open has passed: settle on the first print after it. */
  settle: SeriesView[];
  /** Open series nobody settled within the void delay: void, which refunds every premium. */
  void: SeriesView[];
  /** Unpaid positions in settled or voided series: pay each to its NFT's holder (or refund them). */
  pay: PositionView[];
  waiting: { series: string; reason: string }[];
};

export function plan(now: number, vault: VaultTiming, series: readonly SeriesView[], positions: readonly PositionView[]): Plan {
  const out: Plan = { settle: [], void: [], pay: [], waiting: [] };
  const done = new Set<string>();
  for (const s of series) {
    if (s.state !== "open") {
      done.add(s.address);
    } else if (now < s.openTs) {
      out.waiting.push({ series: s.address, reason: `opens at ${new Date(s.openTs * 1000).toISOString()}` });
    } else if (now > s.openTs + vault.voidDelaySecs) {
      // void_series requires now > open_ts + void_delay_secs
      out.void.push(s);
    } else {
      out.settle.push(s);
    }
  }
  out.pay = positions.filter((p) => done.has(p.series));
  return out;
}

/** The pool's round, as the vault records it. */
export type RoundView = { roundOpenTs: number; roundUnpaid: number; pendingDepositAssets: bigint; pendingRedeemShares: bigint };

/**
 * Why `roll` would fail now, or null if it would succeed (handle_roll's rule):
 * a round that sold nothing rolls any time (the keeper only bothers when a
 * request is waiting); otherwise once its open has passed and every position
 * it sold is closed.
 */
export function rollBlocked(now: number, r: RoundView): string | null {
  if (r.roundOpenTs === 0) {
    return r.pendingDepositAssets > 0n || r.pendingRedeemShares > 0n ? null : "the round sold nothing and no deposit or redemption is waiting";
  }
  if (now <= r.roundOpenTs) return `the round sells until its open at ${new Date(r.roundOpenTs * 1000).toISOString()}`;
  if (r.roundUnpaid > 0) return `${r.roundUnpaid} position(s) still to pay out`;
  return null;
}

/**
 * The program's check on a settlement price (math::check_settlement_timing):
 * the first print at or after the open, inside the window. Returns why a
 * print fails, or null when the program will accept it.
 */
export function settlementTimingError(publishTime: number, prevPublishTime: number, openTs: number, windowSecs: number): string | null {
  if (publishTime < openTs) return "the print is before the open";
  if (publishTime > openTs + windowSecs) return `the first print came more than ${windowSecs}s after the open`;
  if (prevPublishTime >= openTs) return "not the first print after the open";
  return null;
}

/** A Pyth print, as Hermes returns it and PriceUpdateV2 stores it. */
export type Print = { price: bigint; conf: bigint; expo: number; publishTime: number; prevPublishTime: number };

/** As MAX_PRICE_RATIO in constants.rs: how far from its strikes a series may settle. */
export const MAX_PRICE_RATIO = 10n;

/** math::plausible_price: within ten times the strikes the series sold. */
export const plausiblePrice = (price8: bigint, lowestLower: bigint, highestUpper: bigint) =>
  price8 <= highestUpper * MAX_PRICE_RATIO && price8 * MAX_PRICE_RATIO >= lowestLower;

/**
 * Every check handle_settle makes on the print, in its order: timing, a
 * positive price, math::confidence_ok, then (given the series' strikes)
 * math::plausible_price. Returns why the program would reject it, or null
 * when it would settle on it.
 */
export function settlementError(
  print: Print,
  openTs: number,
  vault: { settleWindowSecs: number; maxConfBps: number },
  strikes?: { lowestLower: bigint; highestUpper: bigint },
): string | null {
  const timing = settlementTimingError(print.publishTime, print.prevPublishTime, openTs, vault.settleWindowSecs);
  if (timing) return timing;
  if (print.price <= 0n) return "the price is not positive";
  if (print.conf * 10_000n > print.price * BigInt(vault.maxConfBps)) {
    const bps = (Number(print.conf) * 10_000) / Number(print.price);
    return `the first print's confidence is ±${bps.toFixed(1)} bps, wider than the vault's ${vault.maxConfBps}`;
  }
  if (strikes && !plausiblePrice(toPrice8(print.price, print.expo), strikes.lowestLower, strikes.highestUpper)) {
    return "the first print is more than ten times from the strikes the series sold, so the feed is broken";
  }
  return null;
}

/** math::to_price_8: the price with 8 decimals, rounding finer prices up. */
export function toPrice8(price: bigint, expo: number): bigint {
  const shift = 8 + expo;
  const scale = 10n ** BigInt(Math.abs(shift));
  return shift >= 0 ? price * scale : (price + scale - 1n) / scale;
}

/**
 * What paying a position out pays, in collateral units: the premium back if
 * the series voided, otherwise math::payout_at (nothing at or above `upper`,
 * the loss below it capped at `upper - lower`, rounded down).
 */
export function claimUnits(
  state: Exclude<SeriesState, "open">,
  position: { shares: bigint; upper: bigint; lower: bigint; premium: bigint },
  price: bigint,
  collateralUnit: bigint,
): bigint {
  if (state === "voided") return position.premium;
  if (price >= position.upper) return 0n;
  const upper = position.upper;
  const diff = upper - price < upper - position.lower ? upper - price : upper - position.lower;
  return (position.shares * diff * collateralUnit) / (1_000_000n * 100_000_000n);
}
