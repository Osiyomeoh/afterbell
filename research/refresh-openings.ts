/**
 * Appends TSLA's latest openings to research/data/pyth-tsla-gaps.json from
 * Pyth prints (the close: first print at or after 16:00 ET, or the early
 * close; the open: first at or after 09:30 ET). Needs the Pyth key.
 *
 *   PYTH_API_KEY=<key> npx tsx research/refresh-openings.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Opening } from "../pricing/model";
import { newOpenings } from "../quoter/history";
import { pythCalendar, pythPrintAt, TSLA } from "../quoter/marketData";
import { hermesFromEnv } from "../solana/keeper/pyth";

const FILE = join(import.meta.dirname, "data", "pyth-tsla-gaps.json");

async function main() {
  const data = JSON.parse(readFileSync(FILE, "utf8")) as { source: string; generatedAt: string; gaps: (Opening & { gap: number })[] };
  const now = Math.floor(Date.now() / 1000);
  const hermes = hermesFromEnv();
  const { holidays, earlyCloses } = await pythCalendar(TSLA.symbol, TSLA.feedId, now);
  const added = await newOpenings(data.gaps, (ts) => pythPrintAt(hermes, TSLA.feedId, ts), now, holidays, earlyCloses);
  for (const o of added) data.gaps.push({ ...o, gap: o.open / o.close - 1 });
  data.generatedAt = new Date().toISOString();
  writeFileSync(FILE, JSON.stringify(data, null, 1) + "\n");
  for (const o of added) console.log(`${o.from} -> ${o.to}${o.weekend ? " (weekend)" : ""}: ${o.close.toFixed(2)} -> ${o.open.toFixed(2)}, ${((o.open / o.close - 1) * 100).toFixed(2)}%`);
  console.log(`${added.length} new openings; ${data.gaps.length} in all, through ${data.gaps[data.gaps.length - 1]!.to}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
