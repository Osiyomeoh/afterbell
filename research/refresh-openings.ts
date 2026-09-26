/**
 * Appends a stock's latest openings to research/data/pyth-<symbol>-gaps.json
 * from Pyth prints (the close: first print at or after 16:00 ET, or the early
 * close; the open: first at or after 09:30 ET). Needs the Pyth key, entitled
 * to the stock's feed. A stock without a file yet gets one built from --from.
 *
 *   PYTH_API_KEY=<key> npx tsx research/refresh-openings.ts [SYMBOL] [--from 2026-07-22]
 *
 * SYMBOL defaults to TSLA; it must be in quoter/stocks.ts.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Opening } from "../pricing/model";
import { newOpenings } from "../quoter/history";
import { pythCalendar, pythPrintAt } from "../quoter/marketData";
import { stockBySymbol } from "../quoter/stocks";
import { hermesFromEnv } from "../solana/keeper/pyth";

type File = { source: string; generatedAt: string; gaps: (Opening & { gap: number })[] };

async function main() {
  const args = process.argv.slice(2);
  const fromAt = args.indexOf("--from");
  const from = fromAt >= 0 ? args[fromAt + 1] : undefined;
  const symbol = args.find((a, i) => !a.startsWith("--") && i !== fromAt + 1) ?? "TSLA";
  const stock = stockBySymbol(symbol);
  if (!stock) throw new Error(`${symbol} isn't in quoter/stocks.ts`);

  const file = join(import.meta.dirname, "data", `pyth-${stock.symbol.toLowerCase()}-gaps.json`);
  let data: File;
  let seed: Opening[];
  if (existsSync(file)) {
    data = JSON.parse(readFileSync(file, "utf8")) as File;
    seed = data.gaps;
  } else {
    if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error(`no history for ${stock.symbol} yet: pass --from YYYY-MM-DD to build it`);
    data = { source: `Pyth Equity.US.${stock.symbol}/USD: first print at or after 16:00 ET (close) and 09:30 ET (open)`, generatedAt: "", gaps: [] };
    // newOpenings pairs each session's close with the next session's open, from the session on the seed's `to` onward.
    seed = [{ from, to: from, close: 0, open: 0, weekend: false }];
  }

  const now = Math.floor(Date.now() / 1000);
  const hermes = hermesFromEnv();
  const { holidays, earlyCloses } = await pythCalendar(stock.symbol, stock.feedId, now);
  const added = await newOpenings(seed, (ts) => pythPrintAt(hermes, stock.feedId, ts), now, holidays, earlyCloses);
  for (const o of added) data.gaps.push({ ...o, gap: o.open / o.close - 1 });
  data.generatedAt = new Date().toISOString();
  writeFileSync(file, JSON.stringify(data, null, 1) + "\n");
  for (const o of added) console.log(`${o.from} -> ${o.to}${o.weekend ? " (weekend)" : ""}: ${o.close.toFixed(2)} -> ${o.open.toFixed(2)}, ${((o.open / o.close - 1) * 100).toFixed(2)}%`);
  console.log(`${stock.symbol}: ${added.length} new openings; ${data.gaps.length} in all, through ${data.gaps[data.gaps.length - 1]?.to ?? "none"}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
