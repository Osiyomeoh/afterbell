/**
 * The same question as proof.ts across more stocks and weekends, using
 * Hyperliquid's own price at 16:00 ET and 09:30 ET as stand-ins for the close
 * and the open. Those stand-ins are checked against Pyth's TSLA prints first;
 * the report states how close they are, so the reader can judge the proxy.
 *
 *   npx tsx research/proof-multi.ts
 *
 * Writes research/results/multi-weekend-proof.md.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { candles } from "./hyperliquid";
import { compare, errBps, median, nyTime, priceAt } from "./lib";

const HERE = import.meta.dirname;
const HOUR = 3_600_000;
const COINS = ["xyz:TSLA", "xyz:NVDA", "xyz:AAPL", "xyz:COIN", "xyz:MSTR", "xyz:XYZ100"];
// Nasdaq holidays in the window Hyperliquid's 30-minute candles cover.
const HOLIDAYS = new Set(["2026-06-19", "2026-07-03", "2026-09-07"]);
const STALE = 0.5 * HOUR;
const HOURS_BEFORE = [48, 24, 12, 5.5];

const iso = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/** Trading days (weekdays that aren't holidays) between two instants, as ISO dates. */
function tradingDays(from: number, to: number): string[] {
  const out: string[] = [];
  for (let t = from; t <= to; t += 24 * HOUR) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6 && !HOLIDAYS.has(iso(t))) out.push(iso(t));
  }
  return out;
}

async function main() {
  const end = Date.now();
  const start = end - 110 * 24 * HOUR;

  // 1. How good are Hyperliquid's 16:00 and 09:30 prices as stand-ins for Pyth's close and open?
  const pyth = JSON.parse(readFileSync(join(HERE, "data", "pyth-tsla-gaps.json"), "utf8")) as {
    gaps: { from: string; to: string; close: number; open: number }[];
  };
  const tsla = await candles("xyz:TSLA", "30m", start, end);
  const closeBasis: number[] = [];
  const openBasis: number[] = [];
  for (const g of pyth.gaps) {
    const c = priceAt(tsla, nyTime(g.from, 16, 0), STALE);
    const o = priceAt(tsla, nyTime(g.to, 9, 30), STALE);
    if (c !== null) closeBasis.push(errBps(c, g.close));
    if (o !== null) openBasis.push(errBps(o, g.open));
  }

  // 2. Every weekend and weeknight in the window, per stock.
  const days = tradingDays(start + 24 * HOUR, end - 24 * HOUR);
  const lines = [
    `# Hyperliquid's closed-hours price vs the next open, six xyz markets`,
    ``,
    `Generated ${new Date().toISOString()} by \`npx tsx research/proof-multi.ts\`.`,
    `Close and open are Hyperliquid's own last trade at 16:00 ET and 09:30 ET (30-minute candles).`,
    `Checked against Pyth on TSLA: Hyperliquid at 16:00 ET is a median ${median(closeBasis).toFixed(1)} bps from Pyth's close (n=${closeBasis.length}), at 09:30 ET ${median(openBasis).toFixed(1)} bps from Pyth's open (n=${openBasis.length}).`,
    ``,
    `| Market | Hours before the open | Weekends: n, HL vs close error (bps), HL closer, error removed | Weeknights: same |`,
    `|---|---|---|---|`,
  ];
  const pooled: Record<string, { weekend: { candidate: number; close: number; open: number }[]; night: { candidate: number; close: number; open: number }[] }> = {};

  for (const coin of COINS) {
    const series = await candles(coin, "30m", start, end);
    for (const h of HOURS_BEFORE) {
      const weekend: { candidate: number; close: number; open: number }[] = [];
      const night: typeof weekend = [];
      for (let i = 1; i < days.length; i++) {
        const prev = days[i - 1]!;
        const next = days[i]!;
        const closeTs = nyTime(prev, 16, 0);
        const openTs = nyTime(next, 9, 30);
        const ts = openTs - h * HOUR;
        if (ts < closeTs + 0.5 * HOUR) continue;
        const close = priceAt(series, closeTs, STALE);
        const open = priceAt(series, openTs, STALE);
        const candidate = priceAt(series, ts, 2 * HOUR);
        if (close === null || open === null || candidate === null) continue;
        const row = { candidate, close, open };
        (openTs - closeTs > 24 * HOUR ? weekend : night).push(row);
      }
      const key = String(h);
      pooled[key] ??= { weekend: [], night: [] };
      pooled[key].weekend.push(...weekend);
      pooled[key].night.push(...night);
      const w = compare(weekend);
      const n = compare(night);
      const cell = (c: typeof w) =>
        c.n ? `${c.n}, ${c.candidateMae.toFixed(0)} vs ${c.closeMae.toFixed(0)}, ${(c.candidateCloser * 100).toFixed(0)}%, ${(c.errorRemoved * 100).toFixed(0)}%` : "n/a";
      lines.push(`| ${coin} | ${h} | ${cell(w)} | ${cell(n)} |`);
    }
  }
  lines.push(``, `## Pooled across the six markets`, ``, `| Hours before the open | Weekends | Weeknights |`, `|---|---|---|`);
  for (const h of HOURS_BEFORE) {
    const p = pooled[String(h)]!;
    const cell = (rows: { candidate: number; close: number; open: number }[]) => {
      const c = compare(rows);
      return c.n ? `n=${c.n}: HL ${c.candidateMae.toFixed(0)} bps vs close ${c.closeMae.toFixed(0)} bps, HL closer ${(c.candidateCloser * 100).toFixed(0)}%, error removed ${(c.errorRemoved * 100).toFixed(0)}%` : "n/a";
    };
    lines.push(`| ${h} | ${cell(p.weekend)} | ${cell(p.night)} |`);
  }
  writeFileSync(join(HERE, "results", "multi-weekend-proof.md"), lines.join("\n") + "\n");
  console.log(lines.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
