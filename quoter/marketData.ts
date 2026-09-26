/**
 * The market data the quoter prices from, fetched live: Pyth's market-hours
 * schedule, the settlement source's prices (Pyth's prints through Hermes, or
 * Chainlink's rounds on Robinhood Chain) and Hyperliquid's price for the hours
 * the exchange is shut. Server-side only: Hermes needs the user's API key.
 */
import type { HermesClient } from "@pythnetwork/hermes-client";

import { roundInForce, type FeedReader } from "../evm/keeper/rounds";
import type { Opening } from "../pricing/model";
import { lastClose, scheduleEarlyCloses, scheduleHolidays, sessionSecsLeft, type EarlyCloses } from "./calendar";
import type { PrintAt } from "./history";
import type { Market } from "./quoter";
import type { Stock } from "./stocks";

const BENCHMARKS = "https://benchmarks.pyth.network/v1/price_feeds/";
const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";
/** A print this long after the bell means there was no session (as in the openings history). */
export const MAX_PRINT_LAG_SECS = 60;
/** Every Robinhood Chain equity feed reports 8 decimals. */
const CHAINLINK_DECIMALS = 8;
/** As the EVM vault is deployed: a round older than this at the bell isn't a price for it. */
export const MAX_ROUND_AGE_SECS = 3 * 86_400;

export type Print = { price: number; publishTime: number };

type ParsedPrice = { price: { price: string; expo: number; publish_time: number } };
const toPrint = (p: ParsedPrice): Print => ({ price: Number(p.price.price) * 10 ** p.price.expo, publishTime: p.price.publish_time });

/** Holidays and early closes from Pyth's own schedule for the feed. */
export async function pythCalendar(symbol: string, feedId: string, now: number): Promise<{ holidays: Set<string>; earlyCloses: Map<string, { hour: number; minute: number }> }> {
  const res = await fetch(`${BENCHMARKS}?query=${encodeURIComponent(symbol)}&asset_type=equity`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Pyth market hours returned ${res.status}`);
  const want = feedId.replace(/^0x/, "").toLowerCase();
  const feed = ((await res.json()) as { id: string; attributes?: { schedule?: string } }[]).find((f) => f.id.replace(/^0x/, "").toLowerCase() === want);
  const schedule = feed?.attributes?.schedule;
  if (!schedule) throw new Error(`Pyth has no market-hours schedule for ${symbol}`);
  return { holidays: scheduleHolidays(schedule, now), earlyCloses: scheduleEarlyCloses(schedule, now) };
}

/** The first print at or after `ts`, or null if none came within MAX_PRINT_LAG_SECS. */
export async function pythPrintAt(hermes: HermesClient, feedId: string, ts: number): Promise<Print | null> {
  let r;
  try {
    r = await hermes.getPriceUpdatesAtTimestamp(ts, [feedId], { parsed: true });
  } catch (e) {
    // Hermes answers 404 when nothing was published at or after `ts`: a day the exchange was shut.
    if (e instanceof Error && /status: 404\b/.test(e.message)) return null;
    throw e;
  }
  const p = (r.parsed ?? [])[0] as ParsedPrice | undefined;
  if (!p || p.price.publish_time < ts || p.price.publish_time - ts > MAX_PRINT_LAG_SECS) return null;
  return toPrint(p);
}

export async function pythLatest(hermes: HermesClient, feedId: string): Promise<Print> {
  const r = await hermes.getLatestPriceUpdates([feedId], { parsed: true });
  const p = (r.parsed ?? [])[0] as ParsedPrice | undefined;
  if (!p) throw new Error(`no Pyth price for ${feedId}`);
  return toPrint(p);
}

/** Chainlink's price at a time: the round in force at it, as the EVM vault settles, or null if none recent enough. */
export function chainlinkPrintAt(feed: FeedReader): PrintAt {
  return async (ts) => {
    const r = await roundInForce(feed, BigInt(ts));
    if (!r || r.answer <= 0n || ts - Number(r.updatedAt) > MAX_ROUND_AGE_SECS) return null;
    return { price: Number(r.answer) / 10 ** CHAINLINK_DECIMALS, publishTime: Number(r.updatedAt) };
  };
}

/** Hyperliquid's mid price for a perp such as "xyz:TSLA", which trades around the clock. */
export async function hyperliquidMid(coin: string): Promise<number> {
  const dex = coin.includes(":") ? coin.split(":")[0] : undefined;
  const res = await fetch(HYPERLIQUID_INFO, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(dex ? { type: "allMids", dex } : { type: "allMids" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Hyperliquid allMids returned ${res.status}`);
  const mid = Number(((await res.json()) as Record<string, string>)[coin]);
  if (!(mid > 0)) throw new Error(`Hyperliquid has no mid for ${coin}`);
  return mid;
}

/**
 * Hyperliquid's last trade before `ts`: the close of the last 1-minute candle
 * that ended before it. At 16:00 ET this is a median 2.7 bps from Pyth's close
 * (research/results), so it stands in when Pyth can't be reached.
 */
export async function hyperliquidPriceAt(coin: string, ts: number): Promise<number> {
  const res = await fetch(HYPERLIQUID_INFO, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval: "1m", startTime: (ts - 600) * 1000, endTime: ts * 1000 } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Hyperliquid candleSnapshot returned ${res.status}`);
  const before = ((await res.json()) as { T: number; c: string }[]).filter((k) => k.T < ts * 1000);
  const last = before[before.length - 1];
  if (!last) throw new Error(`Hyperliquid has no ${coin} trades in the 10 minutes before ${new Date(ts * 1000).toISOString()}`);
  return Number(last.c);
}


export type PriceSource = "pyth" | "chainlink" | "hyperliquid";

export type MarketSnapshot = {
  market: Market;
  /** Unix seconds of the close `market.close` was read at. */
  closeTs: number;
  /** The settlement source's close (Pyth's print or Chainlink's round), or Hyperliquid's when Pyth can't be reached. */
  closeSource: PriceSource;
  /** Where `market.live` came from. */
  liveSource: PriceSource;
  /** For an index perp: the stock's price per unit of the perp's, measured at the close. */
  hyperliquidRatio?: number;
  inSession: boolean;
};

/** Where to read settlement prices: Hermes for Pyth stocks (null without a key), a Chainlink feed for the rest. */
export type Sources = { hermes: HermesClient | null; chainlink?: FeedReader | null };

const perpOf = (stock: Stock) => {
  if (!stock.hyperliquid) throw new Error(`${stock.symbol} has no Hyperliquid perp`);
  return stock.hyperliquid;
};

/**
 * Everything the quoter needs, fetched now, read from the source the stock
 * settles on: Pyth for a `pyth` stock (Hyperliquid when Pyth can't be reached,
 * labelled so the app can say which it priced from), Chainlink for the rest.
 */
export async function loadMarket(stock: Stock, history: readonly Opening[], sources: Sources, now: number): Promise<MarketSnapshot> {
  const { holidays, earlyCloses } = await pythCalendar(stock.symbol, stock.feedId, now);
  const inSession = sessionSecsLeft(now, holidays, earlyCloses) > 0;
  const closeTs = lastClose(now, holidays, earlyCloses);
  const found = stock.pyth ? await pythPrices(stock, sources.hermes, closeTs, inSession) : await chainlinkPrices(stock, sources.chainlink, closeTs);

  const market: Market = {
    symbol: stock.symbol,
    close: found.close.price,
    live: found.live.price,
    history,
    annualVol: stock.annualVol,
    holidays,
    earlyCloses: earlyCloses as EarlyCloses,
  };
  return { market, closeTs, closeSource: found.close.source, liveSource: found.live.source, inSession, ...(found.ratio !== undefined && { hyperliquidRatio: found.ratio }) };
}

type Found = { close: { price: number; source: PriceSource }; live: { price: number; source: PriceSource }; ratio?: number };

async function pythPrices(stock: Stock, hermes: HermesClient | null, closeTs: number, inSession: boolean): Promise<Found> {
  const pythClose = hermes ? pythPrintAt(hermes, stock.feedId, closeTs).catch(() => null) : Promise.resolve(null);
  const pythLive = hermes && inSession ? pythLatest(hermes, stock.feedId).then((p) => p.price).catch(() => null) : Promise.resolve(null);
  const [pc, pl] = await Promise.all([pythClose, pythLive]);
  // An index perp trades at the index's level, not the stock's: its price becomes
  // the stock's by their ratio at the close, which needs Pyth's close.
  let ratio: number | undefined;
  if (stock.hyperliquidTracks === "index") {
    if (!pc) throw new Error(`${stock.symbol} needs Pyth's close to read ${stock.hyperliquid}`);
    if (pl === null) ratio = pc.price / (await hyperliquidPriceAt(perpOf(stock), closeTs));
  }
  const close = pc ? { price: pc.price, source: "pyth" as const } : { price: await hyperliquidPriceAt(perpOf(stock), closeTs), source: "hyperliquid" as const };
  const live = pl !== null ? { price: pl, source: "pyth" as const } : { price: (await hyperliquidMid(perpOf(stock))) * (ratio ?? 1), source: "hyperliquid" as const };
  return { close, live, ...(ratio !== undefined && { ratio }) };
}

/**
 * A Robinhood Chain stock: the close is Chainlink's round in force at it, as
 * its history and settlement read it. The price now is Hyperliquid's, which
 * trades through the night at the stock's level (or, for an index perp, at a
 * fixed ratio from the close); a stock with no perp reads Chainlink's latest
 * round, which moves 24/5 on a 0.5% deviation.
 */
async function chainlinkPrices(stock: Stock, feed: FeedReader | null | undefined, closeTs: number): Promise<Found> {
  if (!feed) throw new Error(`${stock.symbol} needs its Chainlink feed`);
  const pc = await chainlinkPrintAt(feed)(closeTs);
  if (!pc) throw new Error(`Chainlink has no ${stock.symbol} round in force at the close`);
  const close = { price: pc.price, source: "chainlink" as const };
  if (!stock.hyperliquid) {
    const latest = await feed.latest();
    return { close, live: { price: Number(latest.answer) / 10 ** CHAINLINK_DECIMALS, source: "chainlink" } };
  }
  const ratio = stock.hyperliquidTracks === "index" ? pc.price / (await hyperliquidPriceAt(stock.hyperliquid, closeTs)) : undefined;
  const live = { price: (await hyperliquidMid(stock.hyperliquid)) * (ratio ?? 1), source: "hyperliquid" as const };
  return { close, live, ...(ratio !== undefined && { ratio }) };
}
