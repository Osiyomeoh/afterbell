"use client";

import { useEffect, useMemo, useState } from "react";

import { backtest } from "@root/pricing/backtest";

import { fetchMarket, fetchRecord, type LedgerRow, type MarketResponse } from "@/lib/api";
import { dayLabel, explorer, nyClock, nyTime, pct, usd } from "@/lib/format";

import { DataTable } from "./DataTable";
import { Stat, Stats } from "./Stats";

// The shape the Blink sells: protection from 2% to 10% below the close.
const STRUCTURE = { deductible: 0.02, depth: 0.1 };
const CHAIN: Record<LedgerRow["chain"], string> = { solana: "Solana", robinhood: "Robinhood Chain" };
const ORACLE: Record<LedgerRow["chain"], string> = { solana: "Pyth", robinhood: "Chainlink" };

/** What the vaults have actually settled, and the same protection replayed on every past opening. */
export function TrackRecord() {
  const [ledger, setLedger] = useState<LedgerRow[] | null>(null);
  const [market, setMarket] = useState<MarketResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    fetchRecord().then((r) => setLedger(r.series), (e: Error) => setError(e.message));
    fetchMarket().then(setMarket, (e: Error) => setError(e.message));
  }, []);

  const replay = useMemo(
    () => market && backtest(market.history, STRUCTURE, { shares: 1, annualVol: market.annualVol, margin: market.config.margin, minRate: market.config.minRate }),
    [market],
  );

  const finished = ledger?.filter((s) => s.state !== "open") ?? [];
  const totals = finished.reduce((t, s) => ({ premiums: t.premiums + s.premiums, paid: t.paid + s.paid }), { premiums: 0, paid: 0 });
  const nights = replay ? [...replay.nights].reverse() : [];
  const kept =
    totals.premiums >= totals.paid
      ? `Settled series: the vaults kept ${usd(totals.premiums - totals.paid)}`
      : `Settled series: buyers got ${usd(totals.paid - totals.premiums)} more than they paid`;

  return (
    <div className="space-y-12">
      <section>
        <h2 className="text-lg font-medium">Settled on-chain</h2>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">
          Every series the vaults have sold, read from the chain: what buyers paid, the oracle price it settled on, and what it paid back.
        </p>
        <div className="scroll-x mt-4 rounded-2xl border border-line bg-surface">
          {error && !ledger ? (
            <p className="p-5 text-sm text-muted">Couldn&apos;t read the record: {error}</p>
          ) : !ledger ? (
            <p className="p-5 text-sm text-muted">Reading the vaults…</p>
          ) : (
            <>
              {/* Phones: a card per series, what it settled on first; the columns didn't fit. */}
              <ul className="divide-y divide-line sm:hidden">
                {ledger.map((s) => (
                  <li key={s.series} className="px-4 py-3.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-medium">
                        {s.symbol}, {nyTime(s.openTs)}
                      </span>
                      <span className="shrink-0 text-xs text-faint">{CHAIN[s.chain]}</span>
                    </div>
                    <div className="mt-1 text-sm">
                      <Settlement s={s} />
                    </div>
                    <div className="num mt-1 text-xs text-muted">
                      {s.sales} sold · {usd(s.premiums)} in · {s.state === "open" ? "pays at the bell" : `${usd(s.paid)} paid`}
                    </div>
                  </li>
                ))}
                {finished.length > 0 && (
                  <li className="num px-4 py-3 text-xs text-muted">
                    {kept} ({usd(totals.premiums)} in, {usd(totals.paid)} paid)
                  </li>
                )}
              </ul>
              <table className="hidden w-full text-sm whitespace-nowrap sm:table">
                <thead className="text-left text-muted">
                  <tr className="border-b border-line">
                    <th className="px-4 py-3 font-normal">Open</th>
                    <th className="px-4 py-3 font-normal">Stock</th>
                    <th className="px-4 py-3 font-normal">Chain</th>
                    <th className="px-4 py-3 font-normal">Settled on</th>
                    <th className="px-4 py-3 text-right font-normal">Sales</th>
                    <th className="px-4 py-3 text-right font-normal">Premiums</th>
                    <th className="px-4 py-3 text-right font-normal">Paid out</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((s) => (
                    <tr key={s.series} className="border-b border-line last:border-0">
                      <td className="px-4 py-3 whitespace-nowrap">{nyTime(s.openTs)}</td>
                      <td className="px-4 py-3">{s.symbol}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{CHAIN[s.chain]}</td>
                      <td className="px-4 py-3">
                        <Settlement s={s} />
                      </td>
                      <td className="num px-4 py-3 text-right">{s.sales}</td>
                      <td className="num px-4 py-3 text-right">{usd(s.premiums)}</td>
                      <td className="num px-4 py-3 text-right">{s.state === "open" ? "—" : usd(s.paid)}</td>
                    </tr>
                  ))}
                </tbody>
                {finished.length > 0 && (
                  <tfoot>
                    <tr className="border-t border-line text-muted">
                      <td className="px-4 py-3" colSpan={5}>
                        {kept}
                      </td>
                      <td className="num px-4 py-3 text-right">{usd(totals.premiums)}</td>
                      <td className="num px-4 py-3 text-right">{usd(totals.paid)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </>
          )}
          {ledger && ledger.length === 0 && <p className="px-4 py-3 text-sm text-muted">Nothing sold yet.</p>}
          {ledger && ledger.length > 0 && finished.length === 0 && (
            <p className="border-t border-line px-4 py-3 text-sm text-muted">No series has settled yet. Each settles at the open it protects until.</p>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-medium">Every past opening, replayed</h2>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">
          Protection on 1 TSLA share from 2% to 10% below each close, priced the way the quote service prices it, from only the openings
          before it, and paid on Pyth&apos;s actual opening print. It isn&apos;t a forecast: it shows how the pricing would have fared.
        </p>
        {replay && (
          <>
            <div className="mt-4">
              <Stats>
                <Stat label="Openings replayed" value={String(replay.nights.length)} />
                <Stat label="Paid out on" value={`${replay.paidNights} (${pct(replay.paidNights / replay.nights.length, 0)})`} />
                <Stat label="Paid back per $1 of premium" value={`${Math.round(replay.paidPerDollar * 100)}¢`} />
              </Stats>
            </div>
            <div className="mt-4 overflow-hidden rounded-2xl border border-line bg-surface">
              <DataTable
                rows={showAll ? nights : nights.slice(0, 12)}
                rowKey={(n) => n.from}
                columns={[
                  { label: "Close → open", phone: "title", cell: (n) => `${dayLabel(n.from)} → ${dayLabel(n.to)}` },
                  { label: "Close", numeric: true, cell: (n) => usd(n.close) },
                  { label: "Open", numeric: true, cell: (n) => usd(n.open) },
                  {
                    label: "Move",
                    numeric: true,
                    phone: "corner",
                    cell: (n) => {
                      const move = n.open / n.close - 1;
                      return (
                        <span className={`num ${move < 0 ? "text-loss" : "text-gain"}`}>
                          {move > 0 ? "+" : ""}
                          {pct(move, 1)}
                        </span>
                      );
                    },
                  },
                  { label: "Premium", numeric: true, cell: (n) => usd(n.premium) },
                  { label: "Paid", numeric: true, cell: (n) => <span className={n.paid > 0 ? "text-text" : "text-faint"}>{usd(n.paid)}</span> },
                ]}
              />
              {nights.length > 12 && (
                <button onClick={() => setShowAll((v) => !v)} className="w-full border-t border-line px-4 py-3 text-sm text-muted hover:text-text">
                  {showAll ? "Show the latest 12" : `Show all ${nights.length}`}
                </button>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function Settlement({ s }: { s: LedgerRow }) {
  if (s.state === "open") return <span className="text-muted">Settles at the bell</span>;
  if (s.state === "voided") return <span className="text-muted">No valid price: voided, premiums refunded</span>;
  const label = `${usd(s.price ?? 0)}, ${ORACLE[s.chain]}${s.priceTime ? ` at ${nyClock(s.priceTime)}` : ""}`;
  return s.settleTx ? (
    <a className="hover:underline" href={explorer("tx", s.settleTx)} target="_blank" rel="noreferrer">
      {label}
    </a>
  ) : (
    <span>{label}</span>
  );
}
