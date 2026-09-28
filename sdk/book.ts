/**
 * Protection for a whole book at once, for a vault or lending market that
 * holds many tokenized stocks: every line quoted for one buyer, each line's
 * quote or the reason it couldn't be sold. Robinhood Chain sells 34 stocks;
 * Solana sells TSLA.
 */
import { parseBook } from "../quoter/gapReport";

import { checkLevels, referencePrice, strikesBelow, type AfterbellClient } from "./client";
import type { Chain, EvmQuoteResponse, SolanaQuoteResponse } from "./types";

type QuoteFor<C extends Chain> = C extends "solana" ? SolanaQuoteResponse : EvmQuoteResponse;

export type BookQuoteLine<Q> = { symbol: string; shares: number } & ({ quote: Q } | { error: string });
export type BookQuote<Q> = {
  lines: BookQuoteLine<Q>[];
  /** Over the lines that were quoted. */
  premium: number;
  maxPayout: number;
};

/** Shares carry six decimals on both chains; a dollar line is sized down to them. */
const toShares = (value: number, price: number) => Math.floor((value / price) * 1e6) / 1e6;

/**
 * Quotes every line of `book` ("TSLA:100,NVDA:$25000": shares, or dollars
 * sized at the reference price) for `buyer`, protected from `start` to
 * `depth` below each stock's price. The quotes last about a minute; buy
 * each with solanaPurchase or robinhoodPurchase.
 */
export async function quoteBook<C extends Chain>(
  client: AfterbellClient,
  q: { chain: C; book: string; buyer: string; start: number; depth: number },
): Promise<BookQuote<QuoteFor<C>>> {
  checkLevels(q.start, q.depth);
  const lines = await Promise.all(
    parseBook(q.book).map(async (line): Promise<BookQuoteLine<QuoteFor<C>>> => {
      let shares = line.shares ?? 0;
      try {
        const price = referencePrice(await client.market(line.symbol));
        if (line.value !== undefined) shares = toShares(line.value, price);
        const ask = { symbol: line.symbol, buyer: q.buyer, ...strikesBelow(price, shares, q.start, q.depth) };
        const quote = q.chain === "solana" ? await client.quote({ ...ask, chain: "solana" }) : await client.quote({ ...ask, chain: "robinhood" });
        return { symbol: line.symbol, shares, quote: quote as QuoteFor<C> };
      } catch (e) {
        return { symbol: line.symbol, shares, error: (e as Error).message };
      }
    }),
  );
  const quoted = lines.flatMap((l) => ("quote" in l ? [l.quote.priced] : []));
  return { lines, premium: quoted.reduce((t, p) => t + p.premium, 0), maxPayout: quoted.reduce((t, p) => t + p.maxPayout, 0) };
}
