import data from "@root/research/data/pyth-tsla-gaps.json";
import type { Opening } from "@root/pricing/model";
import { loadMarket, TSLA, type MarketSnapshot } from "@root/quoter/marketData";
import { hermesFromEnv } from "@root/solana/keeper/pyth";

/** Hermes when a Pyth key is configured; without one the quoter prices from Hyperliquid (labelled). */
const hermes = () => (process.env.PYTH_API_KEY ? hermesFromEnv() : null);

/** Recorded openings, oldest first (research/data/pyth-tsla-gaps.json). */
export const HISTORY = data.gaps as Opening[];

const TTL_MS = 15_000;
let cache: { at: number; snapshot: Promise<MarketSnapshot> } | null = null;

/** The quoter's market data, refreshed at most every 15 seconds. */
export function marketSnapshot(): Promise<MarketSnapshot> {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const snapshot = loadMarket(TSLA, HISTORY, hermes(), Math.floor(Date.now() / 1000));
    cache = { at: Date.now(), snapshot };
    snapshot.catch(() => (cache = null));
  }
  return cache.snapshot;
}
