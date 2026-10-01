/**
 * One line of the board: standard cover on one share of a stock, priced by
 * the quoter's own code, so the board and the ticket agree.
 */
import { DEFAULT_QUOTER_CONFIG, priceQuote, referencePrice, type Market, type QuoterConfig } from "./quoter";

/** The ticket's "Standard" preset: protection from 2% to 10% below the price it's quoted from. */
export const STANDARD = { start: 0.02, depth: 0.1 } as const;

export type BoardPrice = {
  /** The price it's quoted from, the close, and the live price when there is one. */
  reference: number;
  close: number;
  live: number | null;
  openTs: number;
  /** For one share, in dollars. */
  premium: number;
  maxPayout: number;
  probabilityOfPayout: number;
};

const round2 = (v: number) => Math.round(v * 100) / 100;

export function boardPrice(now: number, market: Market, cfg: QuoterConfig = DEFAULT_QUOTER_CONFIG): BoardPrice {
  const reference = referencePrice(now, market, cfg).price;
  const protection = { shares: 1, upper: round2(reference * (1 - STANDARD.start)), lower: round2(reference * (1 - STANDARD.depth)) };
  const q = priceQuote(now, market, protection, cfg);
  return {
    reference,
    close: market.close,
    live: market.live ?? null,
    openTs: q.openTs,
    premium: q.premium,
    maxPayout: q.maxPayout,
    probabilityOfPayout: q.probabilityOfPayout,
  };
}
