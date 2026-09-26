/**
 * Openings for the stocks Robinhood Chain settles, read from Chainlink's own
 * rounds the way the EVM vault settles: a session's close is the round in
 * force at 16:00 ET (or the early close), its open the round in force at
 * 09:30 ET. Holidays come from Pyth's public market-hours schedule, so no key
 * is needed. Rounds are cached in research/data/chainlink-robinhood-<SYMBOL>.json.
 * Each stock's openings go to research/data/chainlink-gaps.json (read by the
 * app's server), and its volatility, measured from the same closes, to its
 * entry in research/data/robinhood-stocks.json (read by quoter/stocks.ts).
 *
 *   npx tsx research/chainlink-openings.ts [SYMBOL ...]
 *
 * With no symbols, every stock in research/data/robinhood-stocks.json.
 * Rebuilt from the cached rounds each run; only new rounds are fetched.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Opening } from "../pricing/model";
import { isoDate } from "../quoter/calendar";
import { annualVolFrom, newOpenings, roundPrintAt } from "../quoter/history";
import { pythCalendar } from "../quoter/marketData";
import { allRounds, onScale, roundsCache } from "./chainlink";

const HERE = import.meta.dirname;
const LIST = join(HERE, "data", "robinhood-stocks.json");
const OUT = join(HERE, "data", "chainlink-gaps.json");
/** As the EVM vault is deployed (evm/script/Deploy.s.sol): a round older than this at the bell doesn't count. */
const MAX_ROUND_AGE_SECS = 3 * 86_400;

type Listed = { symbol: string; feedId: string; chainlink: string; annualVol?: number };
type Built = { feed: string; rounds: number; offScale: number; annualVol: number; gaps: (Opening & { gap: number })[] };

const nyIsoDate = (unix: number) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(unix * 1000)).map((x) => [x.type, x.value]));
  return isoDate({ y: Number(p.year), m: Number(p.month), d: Number(p.day) });
};

async function build(stock: Listed, now: number): Promise<Built> {
  const fetched = await allRounds(stock.chainlink, roundsCache(stock.symbol));
  const rounds = onScale(fetched);
  const first = rounds[0];
  if (!first) throw new Error("the feed has no rounds");
  // Read from the feed's first day, the schedule's holidays include the ones since then (Labor Day).
  const { holidays, earlyCloses } = await pythCalendar(stock.symbol, stock.feedId, first.updatedAt);
  const start = nyIsoDate(first.updatedAt);
  const gaps = await newOpenings([{ from: start, to: start, close: 0, open: 0, weekend: false }], roundPrintAt(rounds, MAX_ROUND_AGE_SECS), now, holidays, earlyCloses);
  return {
    feed: stock.chainlink,
    rounds: rounds.length,
    offScale: fetched.length - rounds.length,
    annualVol: Math.round(annualVolFrom(gaps) * 100) / 100,
    gaps: gaps.map((o) => ({ ...o, gap: o.open / o.close - 1 })),
  };
}

async function main() {
  const list = JSON.parse(readFileSync(LIST, "utf8")) as { stocks: Listed[] };
  const wanted = process.argv.slice(2).map((s) => s.toUpperCase());
  const unknown = wanted.filter((w) => !list.stocks.some((s) => s.symbol === w));
  if (unknown.length) throw new Error(`not in robinhood-stocks.json: ${unknown.join(", ")}`);
  const stocks = wanted.length ? list.stocks.filter((s) => wanted.includes(s.symbol)) : list.stocks;

  const now = Math.floor(Date.now() / 1000);
  let failed = 0;
  for (const stock of stocks) {
    let b: Built;
    try {
      b = await build(stock, now);
      console.log(`${stock.symbol}: ${b.rounds} rounds (${b.offScale} off scale), ${b.gaps.length} openings from ${b.gaps[0]?.from}, ${(b.annualVol * 100).toFixed(0)}% a year`);
    } catch (e) {
      failed++;
      console.log(`${stock.symbol}: failed, ${e instanceof Error ? e.message : e}`);
      continue;
    }
    // Saved after each stock, so a run the endpoint cuts off keeps what it built. Both files are
    // read again first, so runs over different stocks can go side by side without losing each other's.
    const out: { source: string; generatedAt: string; stocks: Record<string, Built> } = existsSync(OUT)
      ? JSON.parse(readFileSync(OUT, "utf8"))
      : { source: "Chainlink on Robinhood Chain mainnet: the round in force at 16:00 ET (close) and 09:30 ET (open)", generatedAt: "", stocks: {} };
    out.stocks[stock.symbol] = b;
    out.generatedAt = new Date().toISOString();
    out.stocks = Object.fromEntries(Object.entries(out.stocks).sort(([x], [y]) => x.localeCompare(y)));
    writeFileSync(OUT, JSON.stringify(out) + "\n");
    const fresh = JSON.parse(readFileSync(LIST, "utf8")) as { stocks: Listed[] };
    for (const s of fresh.stocks) if (s.symbol === stock.symbol) s.annualVol = b.annualVol;
    writeFileSync(LIST, JSON.stringify(fresh, null, 1) + "\n");
  }
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
