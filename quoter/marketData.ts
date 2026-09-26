/**
 * The market data the quoter prices from, fetched live: Pyth's market-hours
 * schedule and prints (Hermes) and Hyperliquid's price for the hours the
 * exchange is shut. Server-side only: Hermes needs the user's API key.
 */
import type { HermesClient } from "@pythnetwork/hermes-client";

import type { Opening } from "../pricing/model";
import { lastClose, scheduleEarlyCloses, scheduleHolidays, sessionSecsLeft, type EarlyCloses } from "./calendar";
import type { Market } from "./quoter";

const BENCHMARKS = "https://benchmarks.pyth.network/v1/price_feeds/";
const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";
/** A print this long after the bell means there was no session (as in the openings history). */
export const MAX_PRINT_LAG_SECS = 60;

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
  const r = await hermes.getPriceUpdatesAtTimestamp(ts, [feedId], { parsed: true });
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

export type Stock = { symbol: string; feedId: string; hyperliquid: string; annualVol: number };

export const TSLA: Stock = {
  symbol: "TSLA",
  feedId: "0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
  hyperliquid: "xyz:TSLA",
  annualVol: 0.6,
};

export type MarketSnapshot = {
  market: Market;
  /** Unix seconds of the close `market.close` was printed at. */
  closeTs: number;
  /** Pyth's closing print, or Hyperliquid's price at the close when Pyth can't be reached. */
  closeSource: "pyth" | "hyperliquid";
  /** Where `market.live` came from. */
  liveSource: "pyth" | "hyperliquid";
  inSession: boolean;
};

/**
 * Everything the quoter needs, fetched now. Pyth first (the settlement
 * source); Hyperliquid when Pyth can't be reached (`hermes` null or failing),
 * labelled so the app can say which it priced from.
 */
export async function loadMarket(stock: Stock, history: readonly Opening[], hermes: HermesClient | null, now: number): Promise<MarketSnapshot> {
  const { holidays, earlyCloses } = await pythCalendar(stock.symbol, stock.feedId, now);
  const inSession = sessionSecsLeft(now, holidays, earlyCloses) > 0;
  const closeTs = lastClose(now, holidays, earlyCloses);

  const pythClose = hermes ? pythPrintAt(hermes, stock.feedId, closeTs).catch(() => null) : Promise.resolve(null);
  const pythLive = hermes && inSession ? pythLatest(hermes, stock.feedId).then((p) => p.price).catch(() => null) : Promise.resolve(null);
  const [pc, pl] = await Promise.all([pythClose, pythLive]);
  const close = pc ? { price: pc.price, source: "pyth" as const } : { price: await hyperliquidPriceAt(stock.hyperliquid, closeTs), source: "hyperliquid" as const };
  const live = pl !== null ? { price: pl, source: "pyth" as const } : { price: await hyperliquidMid(stock.hyperliquid), source: "hyperliquid" as const };

  const market: Market = {
    symbol: stock.symbol,
    close: close.price,
    live: live.price,
    history,
    annualVol: stock.annualVol,
    holidays,
    earlyCloses: earlyCloses as EarlyCloses,
  };
  return { market, closeTs, closeSource: close.source, liveSource: live.source, inSession };
}
