/**
 * The stocks Afterbell sells protection on, and which chains can settle each.
 *
 * - Solana settles on Pyth's first print after the open, which the keeper
 *   fetches with the Pyth key; the key is entitled to TSLA and QQQ only, so
 *   those are the stocks with `pyth` set. Their openings come from Pyth too
 *   (research/refresh-openings.ts).
 * - Robinhood Chain settles on Chainlink's round in force at the open. Every
 *   US equity feed Chainlink publishes there is listed in
 *   research/data/robinhood-stocks.json (research/robinhood-stocks.ts), with
 *   openings from its own rounds (research/chainlink-openings.ts).
 *
 * Every stock has a Pyth feed id: its public market-hours schedule gives the
 * holidays. Most have a Hyperliquid perp that trades while the exchange is shut.
 */
import listed from "../research/data/robinhood-stocks.json" with { type: "json" };

export type Stock = {
  symbol: string;
  name: string;
  /** Pyth's Equity.US feed: its market-hours schedule, and for `pyth` stocks its prints. */
  feedId: string;
  /**
   * Whether the Pyth key reads this feed's prices: then the Solana vault can
   * settle it, and its history and prices come from Pyth.
   */
  pyth: boolean;
  /** Chainlink's feed on Robinhood Chain mainnet, which the EVM vault settles on. */
  chainlink?: `0x${string}`;
  /** The Hyperliquid perp that trades around the clock, if there is one. */
  hyperliquid?: string;
  /**
   * "stock" when the perp tracks the stock's own price (xyz:TSLA ≈ TSLA);
   * "index" when it tracks the index the stock follows, at a different level
   * (xyz:XYZ100 is the Nasdaq-100, QQQ a fund on it). An index perp's price is
   * turned into the stock's by the ratio of the two at the last close.
   */
  hyperliquidTracks: "stock" | "index";
  /** For session time still to run and the fallback when history is short. */
  annualVol: number;
};

type Listed = { symbol: string; name: string; feedId: string; chainlink: string; hyperliquid: string | null; hyperliquidTracks: "stock" | "index"; annualVol?: number };
const robinhood = new Map((listed.stocks as Listed[]).map((s) => [s.symbol, s]));

export const TSLA: Stock = {
  symbol: "TSLA",
  name: "Tesla",
  feedId: "0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
  pyth: true,
  chainlink: "0x4A1166a659A55625345e9515b32adECea5547C38",
  hyperliquid: "xyz:TSLA",
  hyperliquidTracks: "stock",
  annualVol: 0.6,
};

export const QQQ: Stock = {
  symbol: "QQQ",
  name: "Nasdaq-100 (QQQ)",
  feedId: "0x9695e2b96ea7b3859da9ed25b7a46a920a776e2fdae19a7bcfdf2b219230452d",
  pyth: true,
  chainlink: "0x80901d846d5D7B030F26B480776EE3b29374C2ae",
  hyperliquid: "xyz:XYZ100",
  hyperliquidTracks: "index",
  annualVol: 0.25,
};

/** The rest of Robinhood Chain's stocks, with the volatility measured from their Chainlink closes. */
const CHAINLINK_ONLY: Stock[] = [...robinhood.values()]
  .filter((s) => s.symbol !== TSLA.symbol && s.symbol !== QQQ.symbol && s.annualVol !== undefined)
  .map((s) => ({
    symbol: s.symbol,
    name: s.name, // written for display in the list; `listing` there has the exchange's
    feedId: s.feedId,
    pyth: false,
    chainlink: s.chainlink as `0x${string}`,
    ...(s.hyperliquid && { hyperliquid: s.hyperliquid }),
    hyperliquidTracks: s.hyperliquidTracks,
    annualVol: s.annualVol!,
  }));

export const STOCKS: readonly Stock[] = [TSLA, QQQ, ...CHAINLINK_ONLY];

const norm = (id: string) => id.replace(/^0x/, "").toLowerCase();

export function stockBySymbol(symbol: string): Stock | undefined {
  return STOCKS.find((s) => s.symbol === symbol.toUpperCase());
}

/** By Pyth feed id (Solana positions record it), with or without 0x. */
export function stockByFeedId(feedId: string): Stock | undefined {
  return STOCKS.find((s) => norm(s.feedId) === norm(feedId));
}

/** By Chainlink feed address (EVM positions record it), in any case. */
export function stockByChainlinkFeed(feed: string): Stock | undefined {
  return STOCKS.find((s) => s.chainlink?.toLowerCase() === feed.toLowerCase());
}
