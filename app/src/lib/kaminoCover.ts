import { loanRisk, type KaminoLoan } from "./kaminoLoan";

/** The deepest a cover reaches below the price, in basis points: past this the gap report has no price. */
const MAX_BPS = 5000;

export type CoverLine = {
  symbol: string;
  /** Where the cover starts paying, in basis points below tonight's close: the opening that makes the loan liquidatable. */
  startBps: number;
  /** How far below the start it keeps paying more. */
  depthBps: number;
  /** Dollars of stock the cover is sized on: the stock's value times the loan's liquidation threshold. */
  notionalUsd: number;
};

export type CoverPlan =
  | { action: "cover"; gap: number; lines: CoverLine[] }
  | { action: "skip"; reason: string };

/**
 * Auto-cover for a Kamino loan: protection on each stock that starts paying at the opening that
 * makes the loan liquidatable, sized so its payout repays what that opening pushes the debt above
 * the limit. Below the gap g, each dollar a stock opens lower takes `threshold` dollars off the
 * limit, so the shortfall is threshold × S × (x − g); a cover on threshold × S of stock starting at
 * g pays exactly that, down to g + depth. Every stock starts at the gap for all of them together,
 * the shallowest, so a single stock falling alone (which liquidates deeper) is covered too.
 */
export function coverPlan(loan: KaminoLoan, opts: { depthBps?: number; covered?: (symbol: string) => boolean } = {}): CoverPlan {
  const { together } = loanRisk(loan);
  if (together === null) return { action: "skip", reason: "the stocks can't bring this loan to liquidation on their own" };
  if (together === 0) return { action: "skip", reason: "the loan can be liquidated already" };
  const startBps = Math.floor(together * 10_000);
  if (startBps >= MAX_BPS) return { action: "skip", reason: `it takes a ${(together * 100).toFixed(1)}% gap to liquidate, past what's priced` };
  const depthBps = Math.min(opts.depthBps ?? 1000, MAX_BPS - startBps);
  const threshold = loan.liquidationLimitUsd / loan.depositUsd;
  const lines = loan.stocks
    .filter((s) => opts.covered?.(s.symbol) ?? true)
    .map((s) => ({ symbol: s.symbol, startBps, depthBps, notionalUsd: s.usd * threshold }));
  if (lines.length === 0) return { action: "skip", reason: "none of its stocks are covered" };
  return { action: "cover", gap: together, lines };
}

/** What a plan's cover pays if every stock opens `drop` (a fraction) below the close. */
export function coverPayout(lines: CoverLine[], drop: number): number {
  return lines.reduce((t, l) => {
    const into = Math.min(Math.max(drop * 10_000 - l.startBps, 0), l.depthBps) / 10_000;
    return t + l.notionalUsd * into;
  }, 0);
}

/** How far the debt sits above the liquidation limit if every stock opens `drop` below the close (0 when it doesn't). */
export function shortfall(loan: KaminoLoan, drop: number): number {
  const threshold = loan.liquidationLimitUsd / loan.depositUsd;
  const stockUsd = loan.stocks.reduce((t, s) => t + s.usd, 0);
  return Math.max(0, loan.debtUsd - (loan.liquidationLimitUsd - threshold * stockUsd * drop));
}
