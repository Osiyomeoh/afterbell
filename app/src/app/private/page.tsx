import type { Metadata } from "next";
import Link from "next/link";

import { fromUnits, roundDeposit, toUnits, type DeskRun } from "@root/privacy/book";
import featured from "@root/privacy/featured.json";

import { nyTime, usd } from "@/lib/format";

export const metadata: Metadata = {
  title: "Private protection",
  description:
    "Protection bought without showing the chain what you protected or what you paid: the premium and the payout travel as confidential transfers on Helius's Solana Rings. On devnet, with test money.",
};

const tx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

const run: DeskRun = featured;

/** Protection bought through a private desk, from a run of privacy/desk.ts on devnet. */
export default function PrivatePage() {
  const e = run.entry;
  const deposit = fromUnits(roundDeposit(toUnits(e.premium)));
  const steps: { title: string; sig?: string; shows: string; hides: string }[] = [
    {
      title: "The holder moves a round amount into a private balance",
      sig: e.txs.deposit,
      shows: `Wallet ${short(e.holderWallet)} deposited ${deposit} TestUSD into Solana Rings`,
      hides: "Nothing yet: a deposit is public. It's a round amount, so it doesn't give the premium away",
    },
    {
      title: "The holder pays the desk, privately",
      sig: e.txs.premium,
      shows: `${short(e.holderWallet)} sent something to ${short(run.desk)}`,
      hides: `The token and the amount: ${usd(e.premium)} of TestUSD. Neither is among the transaction's accounts, and its data carries them only encrypted`,
    },
    {
      title: "The desk buys the protection in its own name",
      sig: e.txs.buy,
      shows: `The desk bought ${e.shares} ${e.symbol} protected from ${usd(e.upper)} to ${usd(e.lower)}`,
      hides: "Whose it is: the desk buys for everyone who pays it, and only its book links a position to a holder",
    },
    {
      title: "After the open, the desk pays the holder what it paid",
      sig: e.txs.payout,
      shows: `${e.txs.payout ? "" : "Once sent: "}${short(run.desk)} sent something to ${short(e.holderWallet)}`,
      hides:
        e.paid !== undefined
          ? `The amount: ${usd(e.paid)}, paid from the desk's private float so no deposit matches it`
          : run.throwaway
            ? "The amount. This run's keys were thrown away after step 3, so it has no payout step; a run that keeps them sends one"
            : `The amount. This run settles at ${nyTime(e.openTs)}; the payout is sent after it`,
    },
  ];

  return (
    <>
      <section className="py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Private protection</h1>
        <p className="mt-3 max-w-3xl leading-relaxed text-muted">
          Protection sized to a loan tells anyone watching where that loan breaks. So a holder can pay for it privately: the premium goes to
          Afterbell&apos;s desk as a confidential transfer on Helius&apos;s Solana Rings, the desk buys the protection in its own name, and after
          the open it pays the holder the same way. The chain shows that the holder and the desk dealt with each other, never what was
          protected or for how much.
        </p>
        <p className="mt-3 text-sm text-muted">Solana devnet, test money, and Solana Rings is in alpha. This is a demo, run by the script below.</p>
      </section>

      <ol className="space-y-3">
        {steps.map((s, i) => (
          <li key={s.title} className="rounded-2xl border border-line bg-surface p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 className="font-medium">
                <span className="num text-brass">{i + 1}</span> {s.title}
              </h2>
              {s.sig ? (
                <a className="num text-sm text-muted hover:text-text hover:underline" href={tx(s.sig)} target="_blank" rel="noreferrer">
                  {short(s.sig)} ↗
                </a>
              ) : (
                <span className="text-sm text-faint">after the open</span>
              )}
            </div>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-faint">What the chain shows</dt>
                <dd className="mt-1">{s.shows}</dd>
              </div>
              <div>
                <dt className="text-faint">What it doesn&apos;t</dt>
                <dd className="mt-1">{s.hides}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ol>

      <section className="mt-10 max-w-3xl space-y-3 text-sm leading-relaxed text-muted">
        <h2 className="text-base font-medium text-text">What it rests on</h2>
        <p>
          <span className="text-text">Trust in the desk.</span> The desk holds the positions and the book that says whose each one is, so a
          holder trusts it to pay. The way past that is for the vault to take the premium from a private escrow and pay into one, which
          Solana Rings supports in programs; it means changing the vault, so it comes after the hackathon.
        </p>
        <p>
          <span className="text-text">Checked on devnet.</span> The premium&apos;s transaction has no token balance change, TestUSD&apos;s mint
          isn&apos;t among its accounts, and the amount, as the 8 bytes the vault would use, appears nowhere in it. Its data does carry both
          wallets, as Solana Rings documents.
        </p>
        <p>
          <span className="text-text">Run it.</span> <code className="num text-text">privacy/desk.ts</code> in the repo:{" "}
          <code className="num text-text">pnpm desk buy --shares 1</code>, then <code className="num text-text">pnpm desk payout</code> after the
          open.
        </p>
        <p>
          <Link href="/kamino#loan" className="text-brass hover:underline">
            Find the opening that liquidates a Kamino loan →
          </Link>
        </p>
      </section>
    </>
  );
}
