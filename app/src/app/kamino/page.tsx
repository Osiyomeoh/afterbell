import type { Metadata } from "next";
import Link from "next/link";

import { DataTable } from "@/components/DataTable";
import { LoanForm, LoanResults } from "@/components/KaminoLoans";
import { Stat, Stats } from "@/components/Stats";
import { dayLabel, nyTime, pct, usd } from "@/lib/format";
import { kaminoView } from "@/server/kamino";
import { kaminoLoans } from "@/server/kaminoLoans";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Kamino's tokenized stocks overnight",
  description:
    "The tokenized stocks Kamino holds as collateral, read live, what their worst openings would cost, and what protecting them until the next open costs now. Check a loan: the opening that liquidates it, and protection down to it.",
};

const millions = (v: number) => `$${(v / 1e6).toFixed(v >= 10e6 ? 1 : 2)}M`;
/** Millions when it's that big, whole dollars otherwise. */
const money = (v: number) => (v >= 1e6 ? millions(v) : usd(v, 0));
/** Whole dollars, but not "$0" for a price that's only small. */
const dollars = (v: number) => (v > 0 && v < 1 ? "under $1" : usd(v, 0));

/**
 * A gap report on real collateral: Kamino's lending markets for tokenized stocks, read from its public
 * API. With `?wallet=`, that wallet's loans too: the opening that liquidates each, and protection down to it.
 */
export default async function KaminoPage({ searchParams }: { searchParams: Promise<{ wallet?: string | string[] }> }) {
  const { wallet: raw } = await searchParams;
  const wallet = (Array.isArray(raw) ? raw[0] : raw)?.trim() || undefined;
  const [viewResult, loans] = await Promise.all([
    kaminoView().then(
      (v) => ({ ok: true as const, v }),
      (e: Error) => ({ ok: false as const, error: e.message }),
    ),
    wallet ? kaminoLoans(wallet).catch((e: Error) => ({ error: e.message })) : null,
  ]);

  const loanCheck = (
    <section id="loan" className="mt-10 scroll-mt-6 rounded-2xl border border-line bg-surface p-5">
      <h2 className="font-medium">Check a loan</h2>
      <p className="mt-2 mb-4 max-w-3xl text-sm leading-relaxed text-muted">
        Borrowing against tokenized stocks on Kamino? Paste the wallet. We read its loans from Kamino&apos;s public API and work out the opening that
        would make each one liquidatable, how often its stocks have opened that far down, and what protection down to that price costs until the
        next open.
      </p>
      <LoanForm wallet={wallet} />
      {loans && (
        <div className="mt-6">
          <LoanResults result={loans} />
        </div>
      )}
    </section>
  );

  if (!viewResult.ok) {
    return (
      <>
        <section className="py-10">
          <h1 className="text-2xl font-semibold tracking-tight">Kamino&apos;s tokenized stocks overnight</h1>
          <p className="mt-3 text-muted">Couldn&apos;t read Kamino&apos;s markets right now: {viewResult.error}</p>
        </section>
        {loanCheck}
      </>
    );
  }
  const view = viewResult.v;
  const { report } = view;
  const t = report.totals;
  const open = report.lines.find((l) => "openTs" in l.tonight)?.tonight;
  const until = open && "openTs" in open ? nyTime(open.openTs) : "the next open";

  return (
    <>
      <section className="py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Kamino&apos;s tokenized stocks overnight</h1>
        <p className="mt-3 max-w-3xl leading-relaxed text-muted">
          Kamino lends against tokenized stocks. Its markets hold {millions(view.collateralUsd)} of them as collateral, with {millions(view.borrowedUsd)}{" "}
          borrowed against it, read from Kamino&apos;s public API. Each of those stocks reprices all at once at the next opening bell. This is what that
          has cost at the worst openings on record, and what protecting all of it, 2% to 10% below each price until {until}, costs now.
        </p>
      </section>

      <Stats>
        <Stat label="Tokenized-stock collateral" value={millions(view.collateralUsd)} note={`${millions(view.borrowedUsd)} borrowed against it`} />
        <Stat label="Protecting it until the open" value={usd(t.premium, 0)} note={`${pct(t.premium / t.value, 2)} of it; pays up to ${millions(t.maxPayout)}`} />
        <Stat label="Every worst opening at once" value={`−${millions(t.worstNightLoss)}`} note={`protection would pay ${millions(t.worstNightPaid)} of it`} />
      </Stats>

      {loanCheck}

      <LiquidationMap map={view.liquidationMap} />

      <h2 className="mt-10 font-medium">Every stock Kamino holds</h2>
      <div className="mt-4 overflow-hidden rounded-2xl border border-line bg-surface">
        <DataTable
          rows={report.lines}
          rowKey={(l) => l.symbol}
          columns={[
            {
              label: "Stock",
              phone: "title",
              cell: (l) => (
                <>
                  {l.symbol} <span className="font-normal text-faint">{report.names[l.symbol]}</span>
                </>
              ),
            },
            { label: "Collateral", numeric: true, cell: (l) => millions(l.value) },
            {
              label: "Opened 1%+ down",
              numeric: true,
              cell: (l) => (
                <>
                  {l.history.downAtLeast.find((d) => d.move === 0.01)?.nights ?? 0} <span className="text-faint">of {l.history.openings}</span>
                </>
              ),
            },
            {
              label: "Worst opening",
              numeric: true,
              cell: (l) => (
                <>
                  <span className={l.history.worst.gap < 0 ? "text-loss" : ""}>{pct(l.history.worst.gap, 1)}</span>{" "}
                  <span className="text-faint">{dayLabel(l.history.worst.to)}</span>
                </>
              ),
            },
            { label: "That, today", numeric: true, cell: (l) => `−${usd(l.worstNight.loss, 0)}` },
            { label: "Tonight", numeric: true, cell: (l) => ("premium" in l.tonight ? dollars(l.tonight.premium) : "—") },
            { label: "Pays up to", numeric: true, cell: (l) => ("maxPayout" in l.tonight ? usd(l.tonight.maxPayout, 0) : "—") },
          ]}
        />
      </div>

      <div className="mt-6 max-w-3xl space-y-2 text-sm leading-relaxed text-muted">
        {view.uncovered.length > 0 && (
          <p>
            Not priced here, so left out: {view.uncovered.map((u) => `${u.symbol} (${millions(u.usd)})`).join(", ")}.
          </p>
        )}
        <p>
          Read at {new Date(view.readAt * 1000).toISOString().slice(11, 16)} UTC from {view.markets.map((m) => m.name).join(", ")}. &ldquo;That,
          today&rdquo; applies each stock&apos;s worst recorded opening to what Kamino holds now; adding them up assumes they all come at once, a bound
          rather than a forecast. It reads collateral per market, not individual loans, so it doesn&apos;t say which loans a gap would liquidate.
          Prices are Afterbell&apos;s quote service&apos;s, on test money for now. Afterbell isn&apos;t affiliated with Kamino.
        </p>
        <p>
          <Link href="/gap" className="text-brass hover:underline">
            Run the same report for your own book →
          </Link>
        </p>
      </div>
    </>
  );
}

/** How much of Kamino's lending against tokenized stocks each gap at the open would make liquidatable. */
function LiquidationMap({ map }: { map: Awaited<ReturnType<typeof kaminoView>>["liquidationMap"] }) {
  const already = map.curve[0]!;
  const rows = map.curve.filter((r) => r.gap > 0).map((r) => ({ ...r, loans: r.loans - already.loans, debt: r.debt - already.debt, collateral: r.collateral - already.collateral }));
  const w = map.worstOpenings;
  return (
    <section className="mt-10">
      <h2 className="font-medium">If they all opened down together</h2>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">
        {map.loans.toLocaleString("en-US")} loans borrow {money(map.debt)} against tokenized stocks on Kamino.{" "}
        {already.loans > 0 ? `${already.loans} of them, with ${money(already.debt)} of debt, can be liquidated already. ` : ""}
        This is how many more would become liquidatable if every stock opened the same share below today&apos;s price at the next bell.
      </p>
      <div className="mt-4 overflow-hidden rounded-2xl border border-line bg-surface">
        <DataTable
          rows={rows}
          rowKey={(r) => r.gap}
          columns={[
            { label: "Every stock opens", phone: "title", cell: (r) => `${pct(r.gap, 0)} down` },
            { label: "Loans newly liquidatable", numeric: true, cell: (r) => `${r.loans.toLocaleString("en-US")} of ${map.loans.toLocaleString("en-US")}` },
            { label: "Their debt", numeric: true, cell: (r) => money(r.debt) },
            { label: "Their collateral", numeric: true, cell: (r) => money(r.collateral) },
          ]}
        />
      </div>
      <div className="mt-4 max-w-3xl space-y-2 text-sm leading-relaxed text-muted">
        <p>
          If each stock repeated its worst recorded opening, all at once:{" "}
          <span className="text-text">
            {w.loans - already.loans} more loan{w.loans - already.loans === 1 ? "" : "s"}, {money(Math.max(0, w.debt - already.debt))} of debt
          </span>
          .
        </p>
        <p className="text-xs text-faint">
          A snapshot of every loan in these markets that borrows against a tokenized stock, read at {new Date(map.readAt * 1000).toISOString().slice(0, 16).replace("T", " ")}{" "}
          UTC: the chain lists the loans, Kamino&apos;s API values each one (research/kamino-loans.ts in the repo). Other collateral stays at today&apos;s
          value. A loan counts once it can be liquidated, not by how much of it would be: Kamino liquidates part of a loan at a time.
        </p>
      </div>
    </section>
  );
}
