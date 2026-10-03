import Link from "next/link";
import type { Metadata } from "next";

import { Stat, Stats } from "@/components/Stats";
import { nyTime, usd } from "@/lib/format";
import { verifyView, type Book, type Night, type Proof } from "@/server/verify";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Verify it yourself",
  description: "Every settlement, renewal, hedge trade and private payment Afterbell reports, each with the transaction that shows it, on Solana, Robinhood Chain and Hyperliquid.",
};

/** Each claim the app makes, with the transaction or account that shows it, for anyone who'd rather check than trust. */
export default async function VerifyPage() {
  let v: Awaited<ReturnType<typeof verifyView>>;
  try {
    v = await verifyView();
  } catch (e) {
    return (
      <section className="py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Verify it yourself</h1>
        <p className="mt-3 text-muted">Couldn&apos;t read the chains right now: {(e as Error).message}</p>
      </section>
    );
  }
  const c = v.counts;
  return (
    <>
      <section className="py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Verify it yourself</h1>
        <p className="mt-3 max-w-3xl leading-relaxed text-muted">
          Every number here is read from the chain as the page loads. Below is each claim with the transaction or account that shows it, on Solana
          devnet, Robinhood Chain mainnet and Hyperliquid. The money is test money; the settlements, renewals and trades are real transactions.
        </p>
      </section>

      <div className="space-y-4">
        <Stats>
          <Stat label="Openings settled on-chain" value={String(c.openings)} note="on Pyth and Chainlink, two chains" />
          <Stat label="Positions sold" value={String(c.positions)} note={`${usd(c.paid)} paid out so far`} />
          <Stat label="Automatic renewals" value={String(c.renewals)} note="standing orders, bought by a keeper" />
        </Stats>
        <Stats>
          <Stat label="Hedge trades" value={String(c.hedgeTrades)} note="on Hyperliquid, through the night" />
          <Stat label="Wallets that bought from the current vaults" value={String(c.wallets)} note={c.outside === 0 ? "every one of them ours so far" : `${c.wallets - c.outside} of them ours`} />
          <Stat
            label="Outside wallets"
            value={String(c.outside)}
            note={`counted from the ${nyTime(v.campaignOpen)} open; before it, every buyer was the team`}
          />
        </Stats>
      </div>

      <Nights nights={v.nights} />
      <Proofs title="Settlements" intro="Each opening a vault settled, on the oracle's price at the open, and what it paid." proofs={v.settlements} />
      <Proofs
        title="Automatic renewals"
        intro="Protection a keeper bought for a holder's standing order on Robinhood Chain, within the order's price cap, without the holder signing."
        proofs={v.renewals}
      />
      {v.book && <BookTable book={v.book} />}
      <Proofs title="The hedge" intro="The short the open protection calls for, traded through the night and bought back at the bell." proofs={v.hedge} />
      <Proofs
        title="Private protection"
        intro="A holder paying for protection through a desk on Helius's Solana Rings: the premium's transaction shows neither the token nor the amount."
        proofs={v.privacy}
      />
      <Proofs title="Contracts and programs" intro="Where everything above runs." proofs={v.contracts} />
    </>
  );
}

function Proofs({ title, intro, proofs }: { title: string; intro: string; proofs: Proof[] }) {
  return (
    <section className="mt-10">
      <h2 className="font-medium">{title}</h2>
      <p className="mt-1 max-w-3xl text-sm text-muted">{intro}</p>
      {proofs.length === 0 ? (
        <p className="mt-3 text-sm text-faint">None yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {proofs.map((p) => (
            <li key={p.href + p.label}>
              <a
                className="flex flex-col gap-0.5 px-4 py-3 hover:bg-ink/40 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6"
                href={p.href}
                target="_blank"
                rel="noreferrer"
              >
                <span className="text-sm">{p.label}</span>
                <span className="text-xs break-all text-muted sm:text-right">{p.detail} ↗</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Night by night: each opening covered, what holders paid for it and what the vaults paid back at the bell. */
function Nights({ nights }: { nights: Night[] }) {
  if (nights.length === 0) return null;
  return (
    <section className="mt-10">
      <h2 className="font-medium">Night by night</h2>
      <p className="mt-1 max-w-3xl text-sm text-muted">Every opening the vaults have settled, both chains together. Also at /api/verify as JSON.</p>
      <div className="mt-3 overflow-x-auto rounded-2xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="px-4 py-2 font-normal">Open</th>
              <th className="px-4 py-2 font-normal">Stocks</th>
              <th className="px-4 py-2 text-right font-normal">Positions</th>
              <th className="px-4 py-2 text-right font-normal">Premiums</th>
              <th className="px-4 py-2 text-right font-normal">Paid out</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {nights.map((n) => (
              <tr key={n.openTs}>
                <td className="px-4 py-2 whitespace-nowrap">
                  <Link href={`/night/${n.openTs}`} className="text-brass hover:underline">
                    {n.day}
                  </Link>
                </td>
                <td className="px-4 py-2">{n.symbols.join(", ")}</td>
                <td className="px-4 py-2 text-right tabular-nums">{n.positions}</td>
                <td className="px-4 py-2 text-right tabular-nums">{usd(n.premiums)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{usd(n.paid)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Premiums against payouts and the hedge, over the hedge's window. */
function BookTable({ book }: { book: Book }) {
  const rows: [string, number][] = [
    ["Premiums taken", book.premiums],
    ["Paid out at the bell", -book.paid],
    ["Hedge, closed P&L", book.hedgePnl],
    ["Hedge, trading fees", -book.fees],
    ["Hedge, funding", book.funding],
  ];
  return (
    <section className="mt-10">
      <h2 className="font-medium">Payouts against the hedge</h2>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Openings since {nyTime(book.since)} on both chains, next to the TSLA short on Hyperliquid over the same window. The short covers TSLA only.
      </p>
      <div className="mt-3 max-w-md overflow-x-auto rounded-2xl border border-line bg-surface">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-line">
            {rows.map(([label, value]) => (
              <tr key={label}>
                <td className="px-4 py-2">{label}</td>
                <td className="px-4 py-2 text-right tabular-nums">{usd(value)}</td>
              </tr>
            ))}
            <tr className="font-medium">
              <td className="px-4 py-2">Net</td>
              <td className="px-4 py-2 text-right tabular-nums">{usd(book.net)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
