import qqq from "@root/research/data/pyth-qqq-gaps.json";
import tsla from "@root/research/data/pyth-tsla-gaps.json";
import type { Opening } from "@root/pricing/model";
import { newOpenings } from "@root/quoter/history";
import { loadMarket, pythCalendar, pythPrintAt, type MarketSnapshot } from "@root/quoter/marketData";
import { STOCKS, stockBySymbol, type Stock } from "@root/quoter/stocks";
import { hermesFromEnv } from "@root/solana/keeper/pyth";

import { SOLANA_DEPLOYMENT } from "./deployment";

/** Recorded openings per stock, oldest first (research/data/pyth-<symbol>-gaps.json). */
const RECORDED: Record<string, Opening[]> = { TSLA: tsla.gaps as Opening[], QQQ: qqq.gaps as Opening[] };

/** Hermes when a Pyth key is configured; without one the quoter prices from Hyperliquid (labelled). */
const hermes = () => (process.env.PYTH_API_KEY ? hermesFromEnv() : null);

/**
 * The stocks the app prices: in the registry and with recorded openings. An
 * index-perp stock (QQQ) also needs the Pyth key, since its price outside the
 * session is read through the ratio at Pyth's close.
 */
export function pricedStocks(): Stock[] {
  return STOCKS.filter((s) => RECORDED[s.symbol] && (s.hyperliquidTracks === "stock" || process.env.PYTH_API_KEY));
}

/** The stock a request names (default TSLA), if the app prices it. */
export function pricedStock(symbol: string | null | undefined): Stock | undefined {
  const s = stockBySymbol(symbol || "TSLA");
  return s && pricedStocks().includes(s) ? s : undefined;
}

/** Whether the Solana vault accepts the stock's feed (solana/deployments/devnet.json, written by setup). */
export function onSolanaVault(stock: Stock): boolean {
  return !!(SOLANA_DEPLOYMENT.feeds as Record<string, { feedId: string } | undefined>)[stock.symbol];
}

const HISTORY_TTL_MS = 60 * 60 * 1000;
const histories = new Map<string, { at: number; openings: Promise<Opening[]> }>();

/**
 * A stock's recorded openings plus any since, from Pyth, refreshed hourly,
 * so a hosted app never prices from a stale history. Without a Pyth key, the
 * recorded ones.
 */
function currentHistory(stock: Stock): Promise<Opening[]> {
  const recorded = RECORDED[stock.symbol] ?? [];
  const h = hermes();
  if (!h) return Promise.resolve(recorded);
  let entry = histories.get(stock.symbol);
  if (!entry || Date.now() - entry.at > HISTORY_TTL_MS) {
    const now = Math.floor(Date.now() / 1000);
    const openings = pythCalendar(stock.symbol, stock.feedId, now)
      .then(({ holidays, earlyCloses }) => newOpenings(recorded, (ts) => pythPrintAt(h, stock.feedId, ts), now, holidays, earlyCloses))
      .then((added) => [...recorded, ...added]);
    entry = { at: Date.now(), openings };
    histories.set(stock.symbol, entry);
    openings.catch(() => histories.delete(stock.symbol));
  }
  return entry.openings.catch(() => recorded);
}

const TTL_MS = 15_000;
const snapshots = new Map<string, { at: number; snapshot: Promise<MarketSnapshot> }>();

/** The quoter's market data for a stock, refreshed at most every 15 seconds. */
export function marketSnapshot(stock: Stock): Promise<MarketSnapshot> {
  let entry = snapshots.get(stock.symbol);
  if (!entry || Date.now() - entry.at > TTL_MS) {
    const snapshot = currentHistory(stock).then((h) => loadMarket(stock, h, hermes(), Math.floor(Date.now() / 1000)));
    entry = { at: Date.now(), snapshot };
    snapshots.set(stock.symbol, entry);
    snapshot.catch(() => snapshots.delete(stock.symbol));
  }
  return entry.snapshot;
}
