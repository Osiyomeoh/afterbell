/**
 * The private desk's book: which holder each position it bought is for. Pure, so it's tested with the
 * rest of the repo (privacy/book.test.ts) without the privacy SDK installed.
 *
 * The desk buys protection in its own name for holders who pay it privately, and pays them privately
 * when it pays out. The chain shows each holder paying the desk and the desk buying positions; only
 * this book says which position is whose, and neither transfer shows an amount.
 */
import { payout } from "../pricing/putSpread";

/** TestUSD has 6 decimals. */
export const UNITS = 1_000_000;
export const toUnits = (usd: number) => BigInt(Math.round(usd * UNITS));
export const fromUnits = (units: bigint) => Number(units) / UNITS;

export type DeskEntry = {
  symbol: string;
  shares: number;
  upper: number;
  lower: number;
  openTs: number;
  /** What the holder paid the desk, privately, in TestUSD. */
  premium: number;
  /** The holder's private address (hex): what the desk pays. */
  holder: string;
  /** The holder's Solana address, which the chain shows as the premium's sender anyway. */
  holderWallet: string;
  position: string;
  series: string;
  txs: { deposit: string; premium: string; buy: string; payout?: string };
  /** What the desk paid the holder after the open, in TestUSD; absent until then. */
  paid?: number;
  /** The series' settlement price; null if it was voided. Absent until the desk pays out. */
  settledAt?: number | null;
};

/** A run of desk.ts, as it records it in runs/. */
export type DeskRun = { network: string; ranAt: string; throwaway: boolean; desk: string; mint: string; entry: DeskEntry };

/**
 * How much the holder moves into their private balance before paying: the premium rounded up to a
 * round amount, so the public deposit doesn't give the premium away. The change stays private.
 */
export function roundDeposit(premium: bigint): bigint {
  const step = 10n * BigInt(UNITS);
  return ((premium + step) / step) * step;
}

/**
 * What the desk owes the holder once the series is done: the payout at the settlement price, rounded
 * down to a TestUSD unit, or the premium back if the series was voided (the vault refunds it). Null
 * while the series is open.
 */
export function owed(e: DeskEntry, series: { state: "open" | "settled" | "voided"; price: number | null }): bigint | null {
  if (series.state === "open") return null;
  if (series.state === "voided") return toUnits(e.premium);
  if (series.price === null) throw new Error("a settled series without a price");
  return BigInt(Math.floor(payout(e, series.price) * UNITS + 1e-6));
}
