import type { HedgeResponse, LedgerRow } from "./api";

type Activity = NonNullable<HedgeResponse["activity"]>;

/** How the book has done: what settled openings took in and paid out, and what the hedge made closing its trades. */
export type BookResult = {
  /** Openings settled or voided, on either chain, counted once each. */
  openings: number;
  premiums: number;
  paidOut: number;
  /** Premiums less payouts: the underwriters' side, before keepers' tips. */
  underwriting: number;
  /** The hedge's closed P&L less its fees, plus funding; null while there's no hedge account. */
  hedge: number | null;
  net: number;
};

const sum = (xs: readonly number[]) => xs.reduce((t, x) => t + x, 0);

/** Only openings that have settled or voided count: an open one's premium isn't earned yet. */
export function bookResult(rows: readonly LedgerRow[], activity: Activity | null): BookResult {
  const done = rows.filter((r) => r.state !== "open");
  const premiums = sum(done.map((r) => r.premiums));
  const paidOut = sum(done.map((r) => r.paid));
  const underwriting = premiums - paidOut;
  const hedge = activity ? activity.closedPnl - activity.fees + activity.funding : null;
  return {
    openings: new Set(done.map((r) => `${r.symbol}@${r.openTs}`)).size,
    premiums,
    paidOut,
    underwriting,
    hedge,
    net: underwriting + (hedge ?? 0),
  };
}
