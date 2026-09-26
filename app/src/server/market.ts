import { createPublicClient, http } from "viem";

import chainlinkGaps from "@root/research/data/chainlink-gaps.json";
import qqq from "@root/research/data/pyth-qqq-gaps.json";
import tsla from "@root/research/data/pyth-tsla-gaps.json";
import { robinhoodChain } from "@root/evm/client/vault";
import { chainlinkReader } from "@root/evm/keeper/keeper";
import { cachedReader, type FeedReader } from "@root/evm/keeper/rounds";
import type { Opening } from "@root/pricing/model";
import { newOpenings } from "@root/quoter/history";
import { chainlinkPrintAt, loadMarket, pythCalendar, pythPrintAt, type MarketSnapshot } from "@root/quoter/marketData";
import { STOCKS, stockBySymbol, type Stock } from "@root/quoter/stocks";
import { hermesFromEnv } from "@root/solana/keeper/pyth";

import { SOLANA_DEPLOYMENT } from "./deployment";

/**
 * Recorded openings per stock, oldest first, read the way the stock settles:
 * Pyth's prints for Pyth stocks (research/data/pyth-<symbol>-gaps.json),
 * Chainlink's rounds for the rest (research/data/chainlink-gaps.json).
 */
const RECORDED: Record<string, Opening[]> = {
  ...Object.fromEntries(Object.entries((chainlinkGaps as { stocks: Record<string, { gaps: Opening[] }> }).stocks).map(([symbol, s]) => [symbol, s.gaps])),
  TSLA: tsla.gaps as Opening[],
  QQQ: qqq.gaps as Opening[],
};

/** Hermes when a Pyth key is configured; without one the quoter prices Pyth stocks from Hyperliquid (labelled). */
const hermes = () => (process.env.PYTH_API_KEY ? hermesFromEnv() : null);

const robinhood = createPublicClient({ chain: robinhoodChain, transport: http(process.env.ROBINHOOD_RPC || undefined) });
const readers = new Map<string, FeedReader>();

/** Chainlink's feed for a stock on Robinhood Chain mainnet, remembering the rounds it has read. */
function chainlinkFeed(stock: Stock): FeedReader | null {
  if (!stock.chainlink) return null;
  let r = readers.get(stock.symbol);
  if (!r) {
    r = cachedReader(chainlinkReader(robinhood, stock.chainlink), 15_000);
    readers.set(stock.symbol, r);
  }
  return r;
}

/**
 * The stocks the app prices: in the registry and with recorded openings. A
 * Pyth stock tracked by an index perp (QQQ) also needs the Pyth key, since its
 * price outside the session is read through the ratio at Pyth's close. The
 * rest read public sources: Chainlink, Hyperliquid and Pyth's schedule.
 */
export function pricedStocks(): Stock[] {
  return STOCKS.filter((s) => RECORDED[s.symbol] && (!s.pyth || s.hyperliquidTracks === "stock" || process.env.PYTH_API_KEY));
}

/** The stock a request names (default TSLA), if the app prices it. */
export function pricedStock(symbol: string | null | undefined): Stock | undefined {
  const s = stockBySymbol(symbol || "TSLA");
  return s && pricedStocks().includes(s) ? s : undefined;
}

/** Whether the Solana vault v2 accepts the stock's feed (solana/deployments/devnet.json, written by setup). */
export function onSolanaVault(stock: Stock): boolean {
  return stock.pyth && !!SOLANA_DEPLOYMENT?.feeds[stock.symbol];
}

const HISTORY_TTL_MS = 60 * 60 * 1000;
const histories = new Map<string, { at: number; openings: Promise<Opening[]> }>();

/**
 * A stock's recorded openings plus any since, read from its settlement source
 * and refreshed hourly, so a hosted app never prices from a stale history.
 * A Pyth stock without the Pyth key keeps the recorded ones.
 */
function currentHistory(stock: Stock): Promise<Opening[]> {
  const recorded = RECORDED[stock.symbol] ?? [];
  const h = hermes();
  const feed = chainlinkFeed(stock);
  const printAt = stock.pyth ? h && ((ts: number) => pythPrintAt(h, stock.feedId, ts)) : feed && chainlinkPrintAt(feed);
  const last = recorded[recorded.length - 1];
  if (!printAt || !last) return Promise.resolve(recorded);
  let entry = histories.get(stock.symbol);
  if (!entry || Date.now() - entry.at > HISTORY_TTL_MS) {
    const now = Math.floor(Date.now() / 1000);
    // Holidays read from the last recorded day, so any since then are skipped: a
    // Chainlink round is in force on a holiday too.
    const openings = pythCalendar(stock.symbol, stock.feedId, Date.parse(`${last.to}T12:00:00Z`) / 1000)
      .then(({ holidays, earlyCloses }) => newOpenings(recorded, printAt, now, holidays, earlyCloses))
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
    const snapshot = currentHistory(stock).then((h) => loadMarket(stock, h, { hermes: hermes(), chainlink: chainlinkFeed(stock) }, Math.floor(Date.now() / 1000)));
    entry = { at: Date.now(), snapshot };
    snapshots.set(stock.symbol, entry);
    snapshot.catch(() => snapshots.delete(stock.symbol));
  }
  return entry.snapshot;
}
