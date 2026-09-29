import Link from "next/link";

import { dayLabel, pct, usd } from "@/lib/format";
import type { LoanView } from "@/server/kaminoLoans";

import { DataTable } from "./DataTable";
import { Stat, Stats } from "./Stats";

const MAX_SHARES_PER_QUOTE = 1_000;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
/** A premium, but not "$0.00" for protection so deep it costs next to nothing. */
const premium = (v: number) => (v > 0 && v < 0.01 ? "under 1¢" : usd(v));

/** Nights a line's stock opened at least `move` below its close, as the report counted them. */
const nightsPast = (l: LoanView["report"]["lines"][number], move: number | null) =>
  move === null ? null : (l.history.downAtLeast.find((d) => d.move === move)?.nights ?? null);

/** The form: a GET to this page, so it works before any script loads and the result has a link. */
export function LoanForm({ wallet }: { wallet?: string }) {
  return (
    <form action="/kamino#loan" className="flex flex-col gap-2 sm:flex-row">
      <label className="sr-only" htmlFor="wallet">
        Solana wallet
      </label>
      <input
        id="wallet"
        name="wallet"
        defaultValue={wallet}
        placeholder="A Solana wallet that borrows on Kamino"
        autoComplete="off"
        spellCheck={false}
        className="num min-w-0 flex-1 rounded-lg border border-line bg-ink px-3 py-2 text-sm"
      />
      <button className="rounded-lg bg-brass px-4 py-2 text-sm font-medium text-ink hover:opacity-90">Check the loan</button>
    </form>
  );
}

export function LoanResults({ result }: { result: { wallet: string; loans: LoanView[] } | { error: string } }) {
  if ("error" in result) return <p className="text-sm text-loss">{result.error}</p>;
  if (result.loans.length === 0) {
    return (
      <p className="text-sm text-muted">
        {short(result.wallet)} has no loan against tokenized stocks in these markets: nothing borrowed, or no xStock deposited.
      </p>
    );
  }
  return (
    <div className="space-y-8">
      {result.loans.map((loan) => (
        <Loan key={loan.obligation} loan={loan} />
      ))}
    </div>
  );
}

function Loan({ loan }: { loan: LoanView }) {
  const { risk, band, report } = loan;
  const g = risk.together;
  const t = report.totals;
  const liquidates = g === 0 ? "Now" : g === null ? "Not by its stocks" : `${pct(g, 1)} down`;
  const liquidatesNote =
    g === 0 ? "its debt is past the limit already" : g === null ? "they'd have to lose everything" : "all its stocks together, from today's price";
  const range = `${band.start}% to ${band.stop}% below`;

  return (
    <section className="space-y-4">
      <h3 className="font-medium">
        {loan.marketName} <span className="num text-sm font-normal text-faint">{short(loan.obligation)}</span>
      </h3>
      <Stats>
        <Stat label="Borrowed" value={usd(loan.debtUsd, 0)} note={`against ${usd(loan.depositUsd, 0)} of collateral`} />
        <Stat label="Liquidatable if its stocks open" value={liquidates} note={liquidatesNote} />
        <Stat
          label={band.toLiquidation ? "Protection down to that price" : "Protection until the open"}
          value={t.premium > 0 ? premium(t.premium) : "—"}
          note={t.maxPayout > 0 ? `${range}; pays up to ${usd(t.maxPayout, 0)}` : range}
        />
      </Stats>

      {report.lines.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface">
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
              { label: "Collateral", numeric: true, cell: (l) => usd(l.value, 0) },
              {
                label: "Liquidates it alone",
                numeric: true,
                cell: (l) => {
                  const a = risk.alone.find((x) => x.symbol === l.symbol)?.gap ?? null;
                  return a === null ? "—" : a === 0 ? "now" : `${pct(a, 1)} down`;
                },
              },
              {
                label: "Opened that far down",
                numeric: true,
                cell: (l) => {
                  const n = nightsPast(l, g !== null && g > 0 ? g : null);
                  return n === null ? "—" : (
                    <>
                      {n} <span className="text-faint">of {l.history.openings}</span>
                    </>
                  );
                },
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
              { label: "Tonight", numeric: true, cell: (l) => ("premium" in l.tonight ? premium(l.tonight.premium) : "—") },
              {
                label: "",
                phone: "corner",
                cell: (l) => {
                  const shares = Math.round(l.shares * 10_000) / 10_000;
                  return "premium" in l.tonight && shares <= MAX_SHARES_PER_QUOTE ? (
                    <Link className="text-brass hover:underline" href={`/?symbol=${l.symbol}&shares=${shares}`}>
                      Protect
                    </Link>
                  ) : null;
                },
              },
            ]}
          />
        </div>
      )}

      <p className="max-w-3xl text-sm leading-relaxed text-muted">
        {band.toLiquidation
          ? `Protection runs from ${band.start}% below each price down to the opening that makes the loan liquidatable, so it pays the most exactly there: enough to repay ${usd(t.maxPayout, 0)} of the ${usd(loan.debtUsd, 0)} borrowed. `
          : g === 0
            ? "The loan can be liquidated already, so no protection until the open helps it; this prices the usual 2% to 10% for its stocks. "
            : "No opening on record comes close to liquidating this loan, so this prices the usual 2% to 10% for its stocks. "}
        Protection pays after the open, from the oracle&apos;s price: it doesn&apos;t stop a liquidation at the bell, it pays back what the gap took.{" "}
        Buying it shows the chain where the loan breaks, unless you{" "}
        <Link href="/private" className="text-brass hover:underline">
          buy it privately
        </Link>
        .
        {report.skipped.length > 0 && <> Not priced here: {report.skipped.map((s) => s.symbol).join(", ")}.</>}
      </p>
    </section>
  );
}
