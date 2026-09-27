"use client";

import { useEffect, useMemo, useState } from "react";

import { backtest } from "@root/pricing/backtest";

import { fetchMarket, fetchRecord, type LedgerRow, type MarketResponse } from "@/lib/api";
import { dayLabel, explorer, nyClock, nyTime, pct, usd } from "@/lib/format";

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
    () => market && backtest(market.history, STRUCTURE, { shares: 1, annualVol: market.annualVol, margin: market.config.margin }),
    [market],
  );

  const finished = ledger?.filter((s) => s.state !== "open") ?? [];
  const totals = finished.reduce((t, s) => ({ premiums: t.premiums + s.premiums, paid: t.paid + s.paid }), { premiums: 0, paid: 0 });
  const nights = replay ? [...replay.nights].reverse() : [];

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
            <table className="w-full text-sm whitespace-nowrap">
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
                      {totals.premiums >= totals.paid
                        ? `Settled series: the vaults kept ${usd(totals.premiums - totals.paid)}`
                        : `Settled series: buyers got ${usd(totals.paid - totals.premiums)} more than they paid`}
                    </td>
                    <td className="num px-4 py-3 text-right">{usd(totals.premiums)}</td>
                    <td className="num px-4 py-3 text-right">{usd(totals.paid)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
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
            <div className="scroll-x mt-4 rounded-2xl border border-line bg-surface">
              <table className="w-full text-sm whitespace-nowrap">
                <thead className="text-left text-muted">
                  <tr className="border-b border-line">
                    <th className="px-4 py-3 font-normal">Close → open</th>
                    <th className="px-4 py-3 text-right font-normal">Close</th>
                    <th className="px-4 py-3 text-right font-normal">Open</th>
                    <th className="px-4 py-3 text-right font-normal">Move</th>
                    <th className="px-4 py-3 text-right font-normal">Premium</th>
                    <th className="px-4 py-3 text-right font-normal">Paid</th>
                  </tr>
                </thead>
                <tbody>
                  {(showAll ? nights : nights.slice(0, 12)).map((n) => {
                    const move = n.open / n.close - 1;
                    return (
                      <tr key={n.from} className="border-b border-line last:border-0">
                        <td className="px-4 py-3 whitespace-nowrap">
                          {dayLabel(n.from)} → {dayLabel(n.to)}
                        </td>
                        <td className="num px-4 py-3 text-right">{usd(n.close)}</td>
                        <td className="num px-4 py-3 text-right">{usd(n.open)}</td>
                        <td className={`num px-4 py-3 text-right ${move < 0 ? "text-loss" : "text-gain"}`}>
                          {move > 0 ? "+" : ""}
                          {pct(move, 1)}
                        </td>
                        <td className="num px-4 py-3 text-right">{usd(n.premium)}</td>
                        <td className={`num px-4 py-3 text-right ${n.paid > 0 ? "text-text" : "text-faint"}`}>{usd(n.paid)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
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
