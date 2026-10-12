import Link from "next/link";

import { Activity } from "@/components/Activity";
import { EventBanner } from "@/components/EventBanner";
import { ForAgents } from "@/components/ForAgents";
import { HowItWorks } from "@/components/HowItWorks";
import { Protect } from "@/components/Protect";
import { Waitlist } from "@/components/Waitlist";

export default function Home() {
  return (
    <>
      {/* On wide screens what the vaults are doing sits beside the headline rather than under it. */}
      <section className="py-10 sm:py-14 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:items-end lg:gap-12">
        <div>
          {/* The header says this from `sm` up; on a phone it has no room, so it's said here. */}
          <p className="mb-4 inline-block rounded-full border border-line px-2.5 py-1 text-xs text-muted sm:hidden">Test money only: TestUSD has no value</p>
          <h1 className="max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">Protection for your tokenized stock until the next opening bell.</h1>
          <p className="mt-4 max-w-2xl leading-relaxed text-muted">
            Tokenized stocks trade around the clock; the stock doesn&apos;t. Whatever happens while the exchange is shut lands all at once on the next
            opening print. Pay once, and if the stock opens below your level, the vault pays the difference, settled on-chain by the oracle&apos;s price
            at the 09:30 ET open.
          </p>
          <EventBanner />
        </div>
        <Activity />
      </section>
      {/* The event banner's button scrolls here. */}
      <div id="protect" className="scroll-mt-6">
        <Protect />
      </div>
      {/* What no single-stock put vault does: the pool hedges, and borrowers are covered too. */}
      <section className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link href="/vault" className="rounded-lg border border-line p-5 hover:border-brass">
          <h2 className="font-medium">A hedged pool</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Underwriters don&apos;t just hold the gap risk: the vault shorts the stock on Hyperliquid as it sells cover, and shows the hedge live.
          </p>
        </Link>
        <Link href="/kamino" className="rounded-lg border border-line p-5 hover:border-brass">
          <h2 className="font-medium">Cover for Kamino loans</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Borrowing against xStocks? See how far an overnight gap would push your loan toward liquidation, and cover that gap.
          </p>
        </Link>
        <Link href="/backtest" className="rounded-lg border border-line p-5 hover:border-brass">
          <h2 className="font-medium">Tested on every past night</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Today&apos;s pricing replayed on each recorded opening of 34 stocks, using only the nights before it: what it took in and what it paid.
          </p>
        </Link>
      </section>
      <HowItWorks />
      {/* For anyone who'd use it with real money; /try links here. */}
      <div id="waitlist" className="mt-16 scroll-mt-6">
        <Waitlist />
      </div>
      <ForAgents />
    </>
  );
}
