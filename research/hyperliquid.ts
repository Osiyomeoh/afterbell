/**
 * Hyperliquid candles, cached in research/data. Hyperliquid serves only the
 * latest ~5,000 candles per interval, so every fetch is merged into the cache:
 * the proof stays reproducible after Hyperliquid has dropped older candles.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Candle } from "./lib";

const INFO_URL = "https://api.hyperliquid.xyz/info";
const DATA_DIR = join(import.meta.dirname, "data");

type RawCandle = { t: number; T: number; c: string };

async function fetchCandles(coin: string, interval: string, startTime: number, endTime: number): Promise<Candle[]> {
  const res = await fetch(INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } }),
  });
  if (!res.ok) throw new Error(`Hyperliquid candleSnapshot ${coin} ${interval}: HTTP ${res.status}`);
  const raw = (await res.json()) as RawCandle[];
  return raw.map((k) => ({ t: k.t, T: k.T, c: Number(k.c) }));
}

/** Cached candles for `coin`, refreshed from Hyperliquid and merged by open time. */
export async function candles(coin: string, interval: string, startTime: number, endTime: number): Promise<Candle[]> {
  const file = join(DATA_DIR, `hl-${coin.replace(":", "-")}-${interval}.json`);
  const cached: Candle[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).candles : [];
  const fresh = await fetchCandles(coin, interval, startTime, endTime);

  const byOpen = new Map<number, Candle>();
  for (const k of [...cached, ...fresh]) byOpen.set(k.t, k);
  const merged = [...byOpen.values()].sort((a, b) => a.t - b.t);

  writeFileSync(
    file,
    JSON.stringify({ source: `Hyperliquid candleSnapshot ${coin} ${interval}`, updatedAt: new Date().toISOString(), candles: merged }) + "\n",
  );
  return merged;
}
