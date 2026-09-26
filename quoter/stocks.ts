/**
 * The stocks Afterbell sells protection on. Each needs a Pyth feed the quote
 * service's key is entitled to (it prices from Pyth's openings and settles on
 * Pyth's first print after the open) and a Hyperliquid perp that trades while
 * the exchange is shut. Adding one is data: its entry here, its history of
 * openings (research/refresh-openings.ts), and its feed allowed on the vault.
 */

export type Stock = {
  symbol: string;
  name: string;
  /** Pyth's Equity.US feed. */
  feedId: string;
  /** The Hyperliquid perp that trades around the clock. */
  hyperliquid: string;
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

export const TSLA: Stock = {
  symbol: "TSLA",
  name: "Tesla",
  feedId: "0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
  hyperliquid: "xyz:TSLA",
  hyperliquidTracks: "stock",
  annualVol: 0.6,
};

export const QQQ: Stock = {
  symbol: "QQQ",
  name: "Nasdaq-100 (QQQ)",
  feedId: "0x9695e2b96ea7b3859da9ed25b7a46a920a776e2fdae19a7bcfdf2b219230452d",
  hyperliquid: "xyz:XYZ100",
  hyperliquidTracks: "index",
  annualVol: 0.25,
};

export const STOCKS: readonly Stock[] = [TSLA, QQQ];

const norm = (id: string) => id.replace(/^0x/, "").toLowerCase();

export function stockBySymbol(symbol: string): Stock | undefined {
  return STOCKS.find((s) => s.symbol === symbol.toUpperCase());
}

export function stockByFeedId(feedId: string): Stock | undefined {
  return STOCKS.find((s) => norm(s.feedId) === norm(feedId));
}
