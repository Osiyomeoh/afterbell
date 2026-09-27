import { candlePoints, hyperliquidCandles, hyperliquidPriceAt, type PricePoint } from "@root/quoter/marketData";
import type { Stock } from "@root/quoter/stocks";

import { marketSnapshot } from "./market";

/**
 * The stock's price since the last close, from its Hyperliquid perp, which
 * trades through the night while the exchange is shut. `points` is empty for
 * a stock with no perp.
 */
export type Overnight = { symbol: string; closeTs: number; close: number; coin: string | null; points: PricePoint[] };

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: Promise<Overnight> }>();

export function overnight(stock: Stock): Promise<Overnight> {
  let entry = cache.get(stock.symbol);
  if (!entry || Date.now() - entry.at > TTL_MS) {
    const value = load(stock);
    entry = { at: Date.now(), value };
    cache.set(stock.symbol, entry);
    value.catch(() => cache.delete(stock.symbol));
  }
  return entry.value;
}

async function load(stock: Stock): Promise<Overnight> {
  const snap = await marketSnapshot(stock);
  const base = { symbol: stock.symbol, closeTs: snap.closeTs, close: snap.market.close, coin: stock.hyperliquid ?? null };
  if (!stock.hyperliquid) return { ...base, points: [] };
  const now = Math.floor(Date.now() / 1000);
  // A weekend is 65 hours: 15-minute candles keep it to a few hundred points.
  const interval = now - snap.closeTs > 86_400 ? "15m" : "5m";
  const ratio =
    stock.hyperliquidTracks === "index" ? (snap.hyperliquidRatio ?? snap.market.close / (await hyperliquidPriceAt(stock.hyperliquid, snap.closeTs))) : 1;
  const candles = await hyperliquidCandles(stock.hyperliquid, snap.closeTs, now, interval);
  return { ...base, points: candlePoints(candles, snap.closeTs, ratio) };
}
