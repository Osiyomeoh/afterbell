/**
 * Backtest report: the vault's result each night, unhedged, with a short set
 * at the close, and with the short rebalanced through the night by the
 * hedger's rule, sized as today or with the model narrowing as the open
 * nears. Offline: it reads the recorded Pyth openings and
 * Hyperliquid's cached 15-minute xyz:TSLA candles.
 *
 *   npm run hedger:backtest
 *
 * Writes research/results/hedge-backtest.md.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Opening } from "../../pricing/model";
import { DEFAULT_QUOTER_CONFIG } from "../../quoter/quoter";
import { TSLA } from "../../quoter/stocks";
import { nyTime, priceAt, type Candle } from "../../research/lib";
import { backtestHedges, MIN_REMAINING_NIGHTS, remainingMove, type BacktestOptions, type HedgeResult, type NightResult, type Strategy } from "../backtest";

const ROOT = join(import.meta.dirname, "..", "..");
const MIN = 60_000;
const read = (file: string) => JSON.parse(readFileSync(join(ROOT, "research", "data", file), "utf8"));
const openings: Opening[] = read("pyth-tsla-gaps.json").gaps;
const candleFile = read("hl-xyz-TSLA-15m.json") as { updatedAt?: string; candles: Candle[] };

const STRATEGIES: Strategy[] = [
  { name: "Unhedged", unhedged: true },
  { name: "Short set at the close", everyMs: null },
  { name: "Rebalanced every hour", everyMs: 60 * MIN },
  { name: "Rebalanced every 15 minutes", everyMs: 15 * MIN },
  { name: "Rebalanced every hour, narrowing to the open", everyMs: 60 * MIN, narrowing: true },
];
// Growth-mode taker fee, the top of its 0.0045% to 0.009% range; funding is left out.
const FEE_RATE = 0.00009;
const base: Omit<BacktestOptions, "deductible" | "depth"> = {
  shares: 10,
  annualVol: TSLA.annualVol,
  margin: DEFAULT_QUOTER_CONFIG.margin,
  step: 0.001,
  feeRate: FEE_RATE,
  pathStepMs: 15 * MIN,
  maxStaleMs: 30 * MIN,
};
const STRUCTURES = [
  { deductible: 0.02, depth: 0.1 },
  { deductible: 0.01, depth: 0.05 },
];

const money = (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(x).toFixed(2)}`;
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const sd = (xs: number[]) => {
  const m = xs.reduce((a, x) => a + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

const HOUR = 60 * MIN;
const nyClock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** Where Hyperliquid traded through a night, against Pyth's close: a rebalanced hedge can follow a move only as it happens. */
function pathLine(n: NightResult): string {
  const o = openings.find((x) => x.from === n.from && x.to === n.to)!;
  const close = nyTime(o.from, 16);
  const open = nyTime(o.to, 9, 30);
  const moments = [close, close + 4 * HOUR, close + 8 * HOUR, open - 5.5 * HOUR, open - 1.5 * HOUR, open];
  const move = (px: number) => {
    const x = (px / o.close - 1) * 100;
    return Math.abs(x) < 0.05 ? "0.0%" : `${x < 0 ? "−" : "+"}${Math.abs(x).toFixed(1)}%`;
  };
  const points = moments.flatMap((ts) => {
    const px = priceAt(candleFile.candles, ts, base.maxStaleMs);
    return px === null ? [] : [`${nyClock.format(new Date(ts))} ${move(px)}`];
  });
  return `How ${n.from} → ${n.to} moved on Hyperliquid, from Pyth's close ($${o.close.toFixed(2)}), New York time: ${points.join(", ")}; Pyth's opening print ${move(o.open)}.`;
}

function table(nights: readonly NightResult[]): string[] {
  const rows = [`| Hedge | Total | Per night | SD | Worst | Best | Trades | Fees |`, `|---|---|---|---|---|---|---|---|`];
  const sd0 = sd(nights.map((n) => n.pnl[0]!));
  STRATEGIES.forEach((s, k) => {
    const pnl = nights.map((n) => n.pnl[k]!);
    const hedges = nights.map((n) => n.hedge[k]).filter((h): h is HedgeResult => h != null);
    const trades = hedges.reduce((a, h) => a + h.trades, 0);
    const fees = hedges.reduce((a, h) => a + h.fees, 0);
    const change = k === 0 ? "" : ` (${sd(pnl) < sd0 ? "−" : "+"}${pct(Math.abs(sd(pnl) / sd0 - 1))})`;
    rows.push(
      `| ${s.name} | ${money(pnl.reduce((a, x) => a + x, 0))} | ${money(pnl.reduce((a, x) => a + x, 0) / pnl.length)} | ${money(sd(pnl))}${change} | ${money(Math.min(...pnl))} | ${money(Math.max(...pnl))} | ${"unhedged" in s ? "" : trades} | ${"unhedged" in s ? "" : money(fees)} |`,
    );
  });
  return rows;
}

const lines = [
  `# Hedge backtest: the vault's nights, unhedged and hedged in xyz:TSLA`,
  ``,
  `Generated ${new Date().toISOString()} by \`npm run hedger:backtest\`.`,
  ``,
  `Each night the vault sells protection on ${base.shares} TSLA at the close, priced from earlier openings only with the quoter's ${pct(base.margin)} margin, and pays it on Pyth's opening print (research/data/pyth-tsla-gaps.json), as pricing/backtest.ts does. The hedge is a short in Hyperliquid's xyz:TSLA at its own prices (the last trade before each moment, from research/data/hl-xyz-TSLA-15m.json, cached ${candleFile.updatedAt ?? "(date not recorded)"}), sized by the model's delta at that moment and traded when it leaves the hedger's dead band (0.01 TSLA or $10), then bought back at the open. Fees: ${(FEE_RATE * 100).toFixed(4)}% of each trade, growth mode's taker rate at its highest. Funding is left out; the spread is too (mainnet's is $0.01).`,
  ``,
  `The model gives the whole close-to-open move's width at every moment of the night: it doesn't narrow as the open nears. The first three hedges run that way, as the hedger does today: rebalancing follows the price, not the time left.`,
  ``,
  `The last row narrows it. At each rebalance every move in the model is scaled by the share of the close-to-open move still to come that many hours before the open, measured only on earlier nights (below, and hedger/backtest.ts: remainingMove), with straight lines between the measured hours and never under 5%. A night whose earlier nights measure nothing (fewer than ${MIN_REMAINING_NIGHTS} with a Hyperliquid price at an hour) is hedged as "rebalanced every hour". The quoter's prices are left as they are.`,
];
for (const s of STRUCTURES) {
  const r = backtestHedges(openings, candleFile.candles, STRATEGIES, { ...base, ...s });
  const first = r.nights[0];
  const last = r.nights.at(-1);
  lines.push(``, `## Protection ${pct(s.deductible)} to ${pct(s.depth)} below the close`, ``);
  lines.push(`${r.nights.length} nights, ${first?.from} → ${first?.to} to ${last?.from} → ${last?.to}; premiums ${money(r.nights.reduce((a, n) => a + n.premium, 0))}, paid out ${money(r.nights.reduce((a, n) => a + n.paid, 0))} on ${r.nights.filter((n) => n.paid > 0).length} nights. The narrowing hedge had a measure from earlier nights on ${r.nights.filter((n) => n.measured).length} of them.`, ``);
  lines.push(...table(r.nights));
  const worstNight = [...r.nights].sort((a, b) => a.pnl[0]! - b.pnl[0]!)[0]!;
  lines.push(``, `Without the worst night unhedged (${worstNight.from} → ${worstNight.to}), ${r.nights.length - 1} nights:`, ``);
  lines.push(...table(r.nights.filter((n) => n !== worstNight)));
  if (r.skipped.length > 0) lines.push(``, `Left out, no Hyperliquid price at the close or the open: ${r.skipped.join(", ")}.`);
  const worst = [...r.nights].sort((a, b) => a.pnl[0]! - b.pnl[0]!).slice(0, 3);
  lines.push(``, `The three worst nights unhedged, and each hedge's result on them:`, ``);
  for (const n of worst) lines.push(`- ${n.from} → ${n.to}: paid ${money(n.paid)}; ${STRATEGIES.map((st, k) => `${st.name.toLowerCase()} ${money(n.pnl[k]!)}`).join(", ")}`);
  lines.push(``, pathLine(worstNight));
}
// Every night with Hyperliquid's candles, for the table: the hedge above measured only on earlier ones.
const all = remainingMove(openings, candleFile.candles, base.maxStaleMs, MIN_REMAINING_NIGHTS);
lines.push(``, `## How much of the move is still to come`, ``);
lines.push(
  `Over every recorded night long enough to have that moment and a Hyperliquid price at it: the root mean square of ln(open / Hyperliquid's price then), over that of ln(open / close) on the same nights. 1 means the price then says no more about Pyth's opening print than the close did. This table uses every night; the narrowing hedge above only ever used the nights before the one it hedged.`,
  ``,
  `| Hours before the open | Nights | Still to come |`,
  `|---|---|---|`,
  ...all.map((x) => `| ${x.hours} | ${x.nights} | ${pct(x.ratio)} |`),
);
lines.push(``, `One stock over a few dozen nights: read it as how the hedge behaves, not as proof of how much it saves.`);
writeFileSync(join(ROOT, "research", "results", "hedge-backtest.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
