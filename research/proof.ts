/**
 * Does Hyperliquid's price for TSLA, while Nasdaq is closed, predict the next
 * opening print better than the previous close does?
 *
 * For every close-to-open gap Pyth has recorded (research/data/pyth-tsla-gaps.json:
 * first Pyth print at or after 16:00 ET and 09:30 ET), read the xyz:TSLA
 * perpetual's last traded price on Hyperliquid at fixed times before the open,
 * and measure how far each is from Pyth's opening print, next to the previous
 * close's error on the same openings.
 *
 *   npm run proof
 *
 * Writes research/results/tsla-weekend-proof.{json,md}.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { candles } from "./hyperliquid";
import { compare, errBps, median, nyTime, priceAt, type Candle, type Comparison } from "./lib";

const HERE = import.meta.dirname;
const COIN = "xyz:TSLA";
const HOUR = 3_600_000;

type Gap = { from: string; to: string; close: number; open: number; gap: number; weekend: boolean };

/** Checkpoints, in hours before the 09:30 ET open. */
const CHECKPOINTS: { label: string; hoursBefore: number; series: "1h" | "15m" }[] = [
  { label: "Saturday 09:30 ET (weekends only)", hoursBefore: 48, series: "1h" },
  { label: "24h before the open", hoursBefore: 24, series: "1h" },
  { label: "12h before the open (21:30 ET)", hoursBefore: 12, series: "1h" },
  { label: "04:00 ET, pre-market starts", hoursBefore: 5.5, series: "1h" },
  { label: "09:00 ET", hoursBefore: 0.5, series: "1h" },
  { label: "09:30 ET, at the open", hoursBefore: 0, series: "15m" },
];
const MAX_STALE = { "1h": 2 * HOUR, "15m": 0.5 * HOUR };
// A checkpoint only counts once the exchange has been shut for this long,
// so the estimate always comes from closed hours.
const MIN_AFTER_CLOSE = 0.5 * HOUR;

async function main() {
  const pyth = JSON.parse(readFileSync(join(HERE, "data", "pyth-tsla-gaps.json"), "utf8")) as { source: string; gaps: Gap[] };
  const start = nyTime(pyth.gaps[0]!.from, 0) - 3 * 24 * HOUR;
  const end = Date.now();
  const series: Record<"1h" | "15m", Candle[]> = {
    "1h": await candles(COIN, "1h", start, end),
    "15m": await candles(COIN, "15m", start, end),
  };

  const results = CHECKPOINTS.map((cp) => {
    const rows: { to: string; weekend: boolean; candidate: number; close: number; open: number }[] = [];
    for (const g of pyth.gaps) {
      const openTs = nyTime(g.to, 9, 30);
      const closeTs = nyTime(g.from, 16, 0);
      const ts = openTs - cp.hoursBefore * HOUR;
      if (ts < closeTs + MIN_AFTER_CLOSE) continue;
      const candidate = priceAt(series[cp.series], ts, MAX_STALE[cp.series]);
      if (candidate !== null) rows.push({ to: g.to, weekend: g.weekend, candidate, close: g.close, open: g.open });
    }
    const big = rows.filter((r) => errBps(r.close, r.open) > 25);
    const direction = big.filter((r) => Math.sign(r.candidate - r.close) === Math.sign(r.open - r.close)).length;
    return {
      ...cp,
      all: compare(rows),
      weekends: compare(rows.filter((r) => r.weekend)),
      weeknights: compare(rows.filter((r) => !r.weekend)),
      medianErrBps: median(rows.map((r) => errBps(r.candidate, r.open))),
      bigGaps: big.length,
      directionRightOnBigGaps: big.length ? direction / big.length : NaN,
      rows,
    };
  });

  const fmt = (c: Comparison) =>
    c.n === 0
      ? "n/a"
      : `n=${c.n} | HL ${c.candidateMae.toFixed(0)} bps vs close ${c.closeMae.toFixed(0)} bps | closer ${(c.candidateCloser * 100).toFixed(0)}% | error removed ${(c.errorRemoved * 100).toFixed(0)}%`;

  const lines = [
    `# Hyperliquid's closed-hours TSLA price vs the next Pyth open`,
    ``,
    `Generated ${new Date().toISOString()} by \`npm run proof\`.`,
    `Opens and closes: ${pyth.source}. Candidate: last traded price of Hyperliquid's ${COIN} perpetual at each checkpoint.`,
    `Errors are mean absolute distance from Pyth's opening print, in basis points (100 bps = 1%).`,
    ``,
    `| Checkpoint | All openings | Weekends | Weeknights | Direction right on gaps > 25 bps |`,
    `|---|---|---|---|---|`,
    ...results.map(
      (r) =>
        `| ${r.label} | ${fmt(r.all)} | ${fmt(r.weekends)} | ${fmt(r.weeknights)} | ${r.bigGaps ? `${(r.directionRightOnBigGaps * 100).toFixed(0)}% of ${r.bigGaps}` : "n/a"} |`,
    ),
    ``,
    `At the open (09:30 ET), Hyperliquid's price was a median ${results.at(-1)!.medianErrBps.toFixed(1)} bps from Pyth's opening print: that is the basis a hedge closed at the open would carry.`,
  ];
  writeFileSync(join(HERE, "results", "tsla-weekend-proof.md"), lines.join("\n") + "\n");
  writeFileSync(join(HERE, "results", "tsla-weekend-proof.json"), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 1) + "\n");
  console.log(lines.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
