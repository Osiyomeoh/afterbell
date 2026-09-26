import data from "@root/research/data/pyth-tsla-gaps.json";
import type { Opening } from "@root/pricing/model";
import { newOpenings } from "@root/quoter/history";
import { loadMarket, pythCalendar, pythPrintAt, TSLA, type MarketSnapshot } from "@root/quoter/marketData";
import { hermesFromEnv } from "@root/solana/keeper/pyth";

/** Recorded openings, oldest first (research/data/pyth-tsla-gaps.json). */
const RECORDED = data.gaps as Opening[];

/** Hermes when a Pyth key is configured; without one the quoter prices from Hyperliquid (labelled). */
const hermes = () => (process.env.PYTH_API_KEY ? hermesFromEnv() : null);

const HISTORY_TTL_MS = 60 * 60 * 1000;
let history: { at: number; openings: Promise<Opening[]> } | null = null;

/**
 * The recorded openings plus any since, from Pyth, refreshed hourly, so a
 * hosted app never prices from a stale history. Without a Pyth key, the
 * recorded ones.
 */
function currentHistory(): Promise<Opening[]> {
  const h = hermes();
  if (!h) return Promise.resolve(RECORDED);
  if (!history || Date.now() - history.at > HISTORY_TTL_MS) {
    const now = Math.floor(Date.now() / 1000);
    const openings = pythCalendar(TSLA.symbol, TSLA.feedId, now)
      .then(({ holidays, earlyCloses }) => newOpenings(RECORDED, (ts) => pythPrintAt(h, TSLA.feedId, ts), now, holidays, earlyCloses))
      .then((added) => [...RECORDED, ...added]);
    history = { at: Date.now(), openings };
    openings.catch(() => (history = null));
  }
  return history.openings.catch(() => RECORDED);
}

const TTL_MS = 15_000;
let cache: { at: number; snapshot: Promise<MarketSnapshot> } | null = null;

/** The quoter's market data, refreshed at most every 15 seconds. */
export function marketSnapshot(): Promise<MarketSnapshot> {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const snapshot = currentHistory().then((h) => loadMarket(TSLA, h, hermes(), Math.floor(Date.now() / 1000)));
    cache = { at: Date.now(), snapshot };
    snapshot.catch(() => (cache = null));
  }
  return cache.snapshot;
}
