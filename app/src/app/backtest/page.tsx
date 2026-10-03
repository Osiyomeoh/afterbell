import Link from "next/link";
import type { Metadata } from "next";

import { backtest, type BacktestResult } from "@root/pricing/backtest";
import type { Opening } from "@root/pricing/model";
import { DEFAULT_QUOTER_CONFIG } from "@root/quoter/quoter";
import chainlink from "@root/research/data/chainlink-gaps.json";
import pythQqq from "@root/research/data/pyth-qqq-gaps.json";
import pythTsla from "@root/research/data/pyth-tsla-gaps.json";

import { Stat, Stats } from "@/components/Stats";
import { pct, usd } from "@/lib/format";

export const metadata: Metadata = {
  title: "Backtest",
  description: "Today's pricing replayed on every recorded opening of every stock Afterbell covers, from only the openings before each one.",
};

/** Protection from 2% to 10% below the close, as on the track record. */
const STRUCTURE = { deductible: 0.02, depth: 0.1 };

type Row = { symbol: string; oracle: string; result: BacktestResult };

function run(symbol: string, oracle: string, gaps: Opening[], annualVol: number): Row {
  return { symbol, oracle, result: backtest(gaps, STRUCTURE, { shares: 1, annualVol, margin: DEFAULT_QUOTER_CONFIG.margin }) };
}

const stocks = chainlink.stocks as Record<string, { annualVol: number; gaps: Opening[] }>;
const ROWS: Row[] = [
  run("TSLA", "Pyth", pythTsla.gaps, stocks.TSLA?.annualVol ?? 0.55),
  run("QQQ", "Pyth", pythQqq.gaps, stocks.QQQ?.annualVol ?? 0.2),
  ...Object.entries(stocks).map(([symbol, s]) => run(symbol, "Chainlink", s.gaps, s.annualVol)),
].filter((r) => r.result.nights.length > 0);

const total = ROWS.reduce(
  (a, r) => ({ nights: a.nights + r.result.nights.length, paidNights: a.paidNights + r.result.paidNights, premium: a.premium + r.result.premium, paid: a.paid + r.result.paid }),
  { nights: 0, paidNights: 0, premium: 0, paid: 0 },
);

/** Today's pricing on every past night in the research data, no look-ahead. Computed at build: the data is fixed. */
export default function BacktestPage() {
  return (
    <>
      <section className="py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Backtest</h1>
        <p className="mt-3 max-w-3xl leading-relaxed text-muted">
          Protection on 1 share from 2% to 10% below each close, priced the way the quote service prices it today ({Math.round(DEFAULT_QUOTER_CONFIG.margin * 100)}%
          margin) from only the openings before it, and paid on the oracle&apos;s actual opening print. Each stock&apos;s first 10 openings only train the
          model. Below $1 paid per $1 of premium, the vault kept money. It isn&apos;t a forecast. Some stocks, in red, paid back more than they took in; with under 60 nights each, one bad opening decides
          that, which is why a vault pools many stocks and sells within per-stock limits. What actually settled is on the{" "}
          <Link href="/record" className="text-brass hover:underline">
            track record
          </Link>
          .
        </p>
      </section>

      <Stats>
        <Stat label="Nights replayed" value={String(total.nights)} note={`${ROWS.length} stock and oracle pairs`} />
        <Stat label="Paid out on" value={`${total.paidNights} (${pct(total.paidNights / total.nights, 0)})`} />
        <Stat label="Paid back per $1 of premium" value={`${Math.round((total.paid / total.premium) * 100)}¢`} note={`${usd(total.paid)} on ${usd(total.premium)}`} />
      </Stats>

      <div className="mt-6 overflow-x-auto rounded-2xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="px-4 py-2 font-normal">Stock</th>
              <th className="px-4 py-2 font-normal">Oracle</th>
              <th className="px-4 py-2 text-right font-normal">Nights</th>
              <th className="px-4 py-2 text-right font-normal">Paid on</th>
              <th className="px-4 py-2 text-right font-normal">Premiums</th>
              <th className="px-4 py-2 text-right font-normal">Paid out</th>
              <th className="px-4 py-2 text-right font-normal">Per $1</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {ROWS.map(({ symbol, oracle, result: r }) => (
              <tr key={symbol + oracle}>
                <td className="px-4 py-2 font-medium">{symbol}</td>
                <td className="px-4 py-2 text-muted">{oracle}</td>
                <td className="px-4 py-2 text-right tabular-nums">{r.nights.length}</td>
                <td className="px-4 py-2 text-right tabular-nums">{r.paidNights}</td>
                <td className="px-4 py-2 text-right tabular-nums">{usd(r.premium)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{usd(r.paid)}</td>
                <td className={`px-4 py-2 text-right tabular-nums ${r.paidPerDollar > 1 ? "text-loss" : ""}`}>
                  {Number.isFinite(r.paidPerDollar) ? `${Math.round(r.paidPerDollar * 100)}¢` : "–"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-faint">
        Data: {chainlink.source}, generated {chainlink.generatedAt.slice(0, 10)}; Pyth openings for TSLA and QQQ. Code: pricing/backtest.ts.
      </p>
    </>
  );
}
