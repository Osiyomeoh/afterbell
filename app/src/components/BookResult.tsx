"use client";

import { useEffect, useState } from "react";

import { fetchHedge, fetchRecord, type HedgeResponse, type LedgerRow } from "@/lib/api";
import { bookResult } from "@/lib/book";
import { signedUsd, usd } from "@/lib/format";

import { Stat, Stats } from "./Stats";

/**
 * The underwriters' side and the hedge as one result: premiums from settled
 * openings less what they paid, plus the hedge's closed trades. Shows nothing
 * until both are read, or before anything has settled.
 */
export function BookResult() {
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [hedge, setHedge] = useState<HedgeResponse | null>(null);

  useEffect(() => {
    const load = () => {
      fetchRecord().then((r) => setRows(r.series), () => {});
      fetchHedge().then(setHedge, () => {});
    };
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  if (!rows || !hedge) return null;
  const b = bookResult(rows, hedge.activity);
  if (b.openings === 0) return null;
  const a = hedge.activity;

  return (
    <section className="space-y-4 pb-10">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">How the book has done</h2>
        <p className="mt-2 max-w-2xl leading-relaxed text-muted">
          What protection on settled openings took in, less what it paid out, plus the hedge&apos;s closed trades on Hyperliquid. Keepers&apos; tips,
          2% of each premium in the new vaults, come out of the premiums. All test money: TestUSD in the vaults, testnet USDC in the hedge.
        </p>
      </div>
      <Stats>
        <Stat
          label="Underwriting"
          value={signedUsd(b.underwriting)}
          note={`${usd(b.premiums)} in, ${usd(b.paidOut)} paid, ${b.openings} opening${b.openings === 1 ? "" : "s"}`}
        />
        <Stat
          label="Hedge"
          value={b.hedge === null ? "Not running" : signedUsd(b.hedge)}
          note={a ? `${a.trades} trades: ${signedUsd(a.closedPnl)} closed, ${usd(a.fees)} fees` : "No hedge account yet"}
        />
        <Stat label="Together" value={signedUsd(b.net)} note="before the hedge's open position" />
      </Stats>
    </section>
  );
}
