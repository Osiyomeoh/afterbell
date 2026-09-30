import type { Metadata } from "next";
import Link from "next/link";

import { DataTable } from "@/components/DataTable";
import { Stat, Stats } from "@/components/Stats";
import { nyTime, usd } from "@/lib/format";
import { eventView } from "@/server/event";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Protect through Friday's open",
  description:
    "Tesla's third-quarter deliveries and the September jobs report both land before Friday 2 October's open. Protection until that open, what's sold for it, and how it settled.",
};

const CHAIN = { solana: "Solana", robinhood: "Robinhood Chain" } as const;

/** The campaign's open: what's on sale for it, what's sold, and after the bell, how it settled. */
export default async function EventPage() {
  const v = await eventView().catch(() => null);
  if (!v) {
    return (
      <section className="py-10">
        <h1 className="text-2xl font-semibold tracking-tight">No event right now</h1>
        <p className="mt-3 text-muted">
          <Link href="/" className="text-brass hover:underline">
            Protect a stock until the next open →
          </Link>
        </p>
      </section>
    );
  }
  const [lead, ...others] = v.events;
  const p = v.phase;
  const status =
    p.phase === "before-sales"
      ? `Protection until this open goes on sale at the ${nyTime(p.salesOpen)} open.`
      : p.phase === "waiting"
        ? "On sale in a few minutes, once the vault has settled this morning's open."
        : p.phase === "on-sale"
          ? `On sale now, until ${nyTime(p.salesClose)}.`
          : p.phase === "sales-closed"
            ? "Sales have closed. The opening price settles it at 09:30 ET."
            : p.phase === "bell-rung"
              ? "The bell has rung. The keepers settle it on the oracle's opening price within minutes."
              : `${lead!.symbol} opened at ${usd(p.price)} on Pyth's opening print.`;
  // Before sales open, a purchase would cover the open before this one, so the buttons wait.
  const selling = p.phase === "on-sale";
  const done = p.phase === "settled";

  return (
    <>
      <section className="py-10">
        <p className="text-sm font-medium tracking-wide text-brass uppercase">{nyTime(v.openTs)} open</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
          {lead!.title[0]!.toUpperCase() + lead!.title.slice(1)}
          {others.length > 0 && <> and {others[0]!.title}</>}
        </h1>
        <p className="mt-3 max-w-3xl leading-relaxed">
          Both are expected before Friday&apos;s 09:30 ET open, so Friday&apos;s opening price will carry them. Afterbell sells protection until that
          open: pay once, and the oracle&apos;s opening price settles it.
        </p>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">
          {lead!.detail} {others[0]?.detail}
        </p>
        <p className="mt-4 text-lg">{status}</p>
        {selling && (
          <div className="mt-5 flex flex-wrap gap-3">
            <Link href={`/?symbol=${lead!.symbol}`} className="rounded-lg bg-brass px-4 py-2 font-medium text-ink hover:opacity-90">
              Protect {lead!.symbol}
            </Link>
            {others.map((e) => (
              <Link key={e.symbol} href={`/?symbol=${e.symbol}`} className="rounded-lg border border-line px-4 py-2 hover:bg-surface">
                Protect {e.symbol}
              </Link>
            ))}
          </div>
        )}
        {p.phase === "before-sales" && (
          <p className="mt-3 text-sm text-muted">Protection bought before then covers the {nyTime(p.salesOpen)} open instead, so come back at that open.</p>
        )}
        {selling && (
          <p className="mt-3 text-sm text-muted">
            Test money only: no wallet? The app gives you a test wallet and 1,000 TestUSD in one click.
          </p>
        )}
      </section>

      <Stats>
        <Stat label="Protection sold for this open" value={String(v.sold)} note={`${usd(v.premiums)} of premiums`} />
        <Stat label="Wallets" value={String(v.wallets)} note={v.wallets === 0 ? "none yet" : v.outside ? `${v.outside} of them new, from outside the team` : "the team's so far"} />
        <Stat label={done ? "Paid out" : "Pays up to"} value={usd(done ? v.paid : v.maxPayouts)} note={done ? "on the oracle's opening price" : "if it opens far enough down"} />
      </Stats>

      {v.series.length > 0 && (
        <section className="mt-8">
          <h2 className="font-medium">{done ? "How it settled" : "Sold so far"}</h2>
          <div className="mt-3 overflow-hidden rounded-2xl border border-line bg-surface">
            <DataTable
              rows={v.series}
              rowKey={(r) => r.series}
              columns={[
                { label: "Stock", phone: "title", cell: (r) => r.symbol },
                { label: "Chain", phone: "corner", cell: (r) => CHAIN[r.chain] },
                { label: "Opened at", numeric: true, cell: (r) => (r.price === null ? "—" : usd(r.price)) },
                { label: "Positions", numeric: true, cell: (r) => r.sales },
                { label: "Premiums", numeric: true, cell: (r) => usd(r.premiums) },
                { label: "Paid", numeric: true, cell: (r) => (r.state === "open" ? "—" : usd(r.paid)) },
              ]}
            />
          </div>
        </section>
      )}

      <p className="mt-6 max-w-3xl text-sm text-muted">
        Every settlement and payout here is a transaction you can open:{" "}
        <Link href="/verify" className="text-brass hover:underline">
          verify it yourself
        </Link>
        . Each position also has its own page to share, with its result once the bell has rung.
      </p>
    </>
  );
}
