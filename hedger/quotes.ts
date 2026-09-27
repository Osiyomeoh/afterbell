/**
 * The testnet quoting account's orders. Testnet's xyz:TSLA book is empty, so
 * this account rests a bid and an ask at mainnet's mid, a few basis points
 * each side, and the hedger's orders fill against them at the real price.
 * It's our own liquidity, and everything that shows the hedge says so. Pure:
 * the script reads the mid and the resting orders, and sends what this
 * returns.
 */
import { DEFAULT_SLIPPAGE, floatToWire, perpPrice, type Market, type OrderWire } from "./hyperliquid";

export type QuoteRules = {
  /** Each side's distance from the mid, in basis points. */
  spreadBps: number;
  /** Each side's size, in shares. A hedge trade bigger than this fills over more than one run. */
  size: number;
  /** A resting quote is kept, not replaced, while it's unfilled and within this many basis points of the new price. */
  refreshBps: number;
};

/** 5 TSLA a side covers the default $1,500 cap's whole hedge down to $300 a share. */
export const DEFAULT_QUOTE_RULES: QuoteRules = { spreadBps: 2, size: 5, refreshBps: 1 };

/**
 * The bid and the ask, each rounded away from the mid to a valid tick, so the
 * spread is never narrower than asked and the two can't cross. Good until
 * cancelled: an order that only adds liquidity would be refused whenever a
 * stray order on testnet's book crosses it, and the hedger would find no
 * side to fill against.
 */
export function quoteOrders(mid: number, market: Market, rules: QuoteRules): { bid: OrderWire; ask: OrderWire } {
  if (!(mid > 0)) throw new Error("no mid price to quote at");
  if (!(rules.spreadBps > 0)) throw new Error("the spread must be above 0, or the quotes would cross");
  // The hedger's orders fill no further than its slippage from the mid; wider quotes would never fill them.
  if (rules.spreadBps >= DEFAULT_SLIPPAGE * 10_000) {
    throw new Error(`a spread of ${rules.spreadBps} bps is at or beyond the hedger's ${DEFAULT_SLIPPAGE * 10_000} bps limit, so its orders would never fill`);
  }
  const size = Number(rules.size.toFixed(market.szDecimals));
  if (!(size > 0)) throw new Error(`a quote of ${rules.size} is below the market's size step`);
  const s = rules.spreadBps / 10_000;
  const order = (buy: boolean, px: number): OrderWire => ({ a: market.asset, b: buy, p: floatToWire(px), s: floatToWire(size), r: false, t: { limit: { tif: "Gtc" } } });
  return {
    bid: order(true, perpPrice(mid * (1 - s), market.szDecimals, "down")),
    ask: order(false, perpPrice(mid * (1 + s), market.szDecimals, "up")),
  };
}

/** An order resting on the book, as the account's open orders list it. */
export type RestingOrder = { oid: number; buy: boolean; px: number; size: number };

export type QuoteRefresh = {
  keep: RestingOrder[];
  /** Resting orders to cancel: moved too far, partly filled, or not one of the quotes at all. */
  cancel: RestingOrder[];
  /** Quotes to place: those no resting order already makes. */
  place: OrderWire[];
};

/**
 * What to change so the book holds exactly `wanted`: a resting order stays if
 * it's on the same side, unfilled (its size is the quote's) and within
 * `refreshBps` of the new price; every other order the account has in the
 * market is cancelled, and each quote nothing matched is placed.
 */
export function refreshQuotes(resting: readonly RestingOrder[], wanted: readonly OrderWire[], refreshBps: number): QuoteRefresh {
  const left = [...resting];
  const keep: RestingOrder[] = [];
  const place: OrderWire[] = [];
  for (const w of wanted) {
    const px = Number(w.p);
    const size = Number(w.s);
    const i = left.findIndex((o) => o.buy === w.b && Math.abs(o.size - size) < 1e-9 && Math.abs(o.px / px - 1) * 10_000 <= refreshBps + 1e-9);
    if (i >= 0) keep.push(...left.splice(i, 1));
    else place.push(w);
  }
  return { keep, cancel: left, place };
}
