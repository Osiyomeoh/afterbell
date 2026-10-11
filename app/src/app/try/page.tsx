import type { Metadata } from "next";
import Link from "next/link";

import { Protect } from "@/components/Protect";
import { Waitlist } from "@/components/Waitlist";

export const metadata: Metadata = {
  title: "Try Afterbell",
  description: "Buy protection on a tokenized stock until the next opening bell, on Solana devnet with test money, then join the mainnet waitlist.",
};

// Optional: where testers tell us what broke or what they'd want.
const FEEDBACK_URL = process.env.NEXT_PUBLIC_FEEDBACK_URL;

const STEPS: { title: string; body: React.ReactNode }[] = [
  {
    title: "Get a wallet with test money",
    body: "Press Use a test wallet below: it makes one kept in this browser, funded at once with 1,000 TestUSD and a little devnet SOL. Phantom or Solflare set to devnet works too.",
  },
  {
    title: "Protect a stock until the next open",
    body: "Pick a stock, how many shares, and how far down to cover, then buy. You pay one premium; the most it can pay is fixed before you buy.",
  },
  {
    title: "Watch it settle at 09:30 ET",
    body: (
      <>
        The vault settles on the oracle&apos;s opening price. <Link className="underline" href="/positions">My protection</Link> shows what it
        opened at and what your cover paid.
      </>
    ),
  },
  {
    title: "Join the mainnet waitlist",
    body: "If you'd use it with real money, say so below. It's one devnet transaction that sends nothing.",
  },
];

export default function Page() {
  return (
    <>
      <section className="py-10">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Try Afterbell in two minutes</h1>
        <p className="mt-3 max-w-2xl leading-relaxed text-muted">
          Tokenized stocks trade all night; the stock opens at 09:30 ET, and whatever happened in between lands at once. Afterbell protects you
          until that open. Here it runs on Solana devnet with TestUSD, a token with no value: nothing to install, nothing to pay.
        </p>
        <ol className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className="rounded-lg border border-line p-4">
              <div className="num text-xs text-faint">{i + 1}</div>
              <h2 className="mt-1 font-medium">{s.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>
      <div id="protect" className="scroll-mt-6">
        <Protect />
      </div>
      <div id="waitlist" className="mt-12 scroll-mt-6">
        <Waitlist />
      </div>
      {FEEDBACK_URL && (
        <p className="mt-6 text-sm text-muted">
          Something broke, or something missing?{" "}
          <a className="text-text underline" href={FEEDBACK_URL} target="_blank" rel="noreferrer">
            Tell us
          </a>
          .
        </p>
      )}
    </>
  );
}
