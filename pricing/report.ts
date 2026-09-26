/**
 * Backtest report: protection on 10 TSLA priced at every close from earlier
 * openings only, paid by the actual Pyth opening print.
 *
 *   npx tsx pricing/report.ts
 *
 * Writes research/results/pricing-backtest.md.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { backtest, type Structure } from "./backtest";
import type { Opening } from "./model";

const ROOT = join(import.meta.dirname, "..");
const openings: Opening[] = JSON.parse(readFileSync(join(ROOT, "research", "data", "pyth-tsla-gaps.json"), "utf8")).gaps;
const STRUCTURES: Structure[] = [
  { deductible: 0.005, depth: 0.03 },
  { deductible: 0.01, depth: 0.05 },
  { deductible: 0.02, depth: 0.06 },
  { deductible: 0, depth: 0.1 },
];
const opts = { shares: 10, annualVol: 0.6, margin: 0 };
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

const lines = [
  `# Protection backtest: 10 TSLA at every close, priced from earlier openings only`,
  ``,
  `Generated ${new Date().toISOString()} by \`npx tsx pricing/report.ts\`. Openings: Pyth's first print at or after 09:30 ET (research/data/pyth-tsla-gaps.json).`,
  `Premiums are fair value (no margin). "Paid per $1" below 1 means buyers paid more than they got back over this sample; the vault's margin comes on top.`,
  ``,
  `| Protection (below the close) | Nights | Premium | Paid | Paid per $1 | Nights it paid |`,
  `|---|---|---|---|---|---|`,
];
for (const s of STRUCTURES) {
  const r = backtest(openings, s, opts);
  lines.push(
    `| ${pct(s.deductible)} to ${pct(s.depth)} | ${r.nights.length} | $${r.premium.toFixed(2)} | $${r.paid.toFixed(2)} | ${r.paidPerDollar.toFixed(2)} | ${r.paidNights} |`,
  );
}
const r = backtest(openings, STRUCTURES[1]!, opts);
lines.push(``, `Nights that paid (${pct(STRUCTURES[1]!.deductible)} to ${pct(STRUCTURES[1]!.depth)}):`, ``);
for (const n of r.nights.filter((n) => n.paid > 0)) {
  lines.push(`- ${n.from} → ${n.to}: close $${n.close.toFixed(2)}, open $${n.open.toFixed(2)}, premium $${n.premium.toFixed(2)}, paid $${n.paid.toFixed(2)}`);
}
lines.push(``, `This is ${r.nights.length} out-of-sample nights on one stock in a calm stretch; read it as a sanity check on the pricing, not as proof of an edge.`);
writeFileSync(join(ROOT, "research", "results", "pricing-backtest.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
