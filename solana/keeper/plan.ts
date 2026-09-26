/**
 * What the keeper should do for each series, from the same rules the program
 * enforces (solana/programs/afterbell-vault/src). Pure, so every case is tested.
 */

export type SeriesState = "open" | "settled" | "voided";

export type SeriesView = { address: string; feedId: string; openTs: number; state: SeriesState };
export type PositionView = { address: string; series: string; buyer: string };
export type VaultTiming = { settleWindowSecs: number; voidDelaySecs: number };

export type Plan = {
  /** Open series whose open has passed: settle on the first print after it. */
  settle: SeriesView[];
  /** Open series nobody settled within the void delay: void, which refunds every premium. */
  void: SeriesView[];
  /** Positions in settled or voided series: claim, paying the buyer (or refunding them). */
  claim: PositionView[];
  waiting: { series: string; reason: string }[];
};

export function plan(now: number, vault: VaultTiming, series: readonly SeriesView[], positions: readonly PositionView[]): Plan {
  const out: Plan = { settle: [], void: [], claim: [], waiting: [] };
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
  out.claim = positions.filter((p) => done.has(p.series));
  return out;
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

/**
 * Every check handle_settle makes on the print, in its order: timing, a
 * positive price, then math::confidence_ok. Returns why the program would
 * reject it, or null when it would settle on it.
 */
export function settlementError(print: Print, openTs: number, vault: { settleWindowSecs: number; maxConfBps: number }): string | null {
  const timing = settlementTimingError(print.publishTime, print.prevPublishTime, openTs, vault.settleWindowSecs);
  if (timing) return timing;
  if (print.price <= 0n) return "the price is not positive";
  if (print.conf * 10_000n > print.price * BigInt(vault.maxConfBps)) {
    const bps = (Number(print.conf) * 10_000) / Number(print.price);
    return `the first print's confidence is ±${bps.toFixed(1)} bps, wider than the vault's ${vault.maxConfBps}`;
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
 * What a claim pays, in collateral units: the premium back if the series
 * voided, otherwise math::payout_at (nothing at or above `upper`, the loss
 * below it capped at `upper - lower`, rounded down).
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
