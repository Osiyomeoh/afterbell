import { Activity } from "@/components/Activity";
import { ForAgents } from "@/components/ForAgents";
import { HowItWorks } from "@/components/HowItWorks";
import { Protect } from "@/components/Protect";

export default function Home() {
  return (
    <>
      <section className="py-10 sm:py-14">
        {/* The header says this from `sm` up; on a phone it has no room, so it's said here. */}
        <p className="mb-4 inline-block rounded-full border border-line px-2.5 py-1 text-xs text-muted sm:hidden">Test money only: TestUSD has no value</p>
        <h1 className="max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">Protection for your tokenized stock until the next opening bell.</h1>
        <p className="mt-4 max-w-2xl leading-relaxed text-muted">
          Tokenized stocks trade around the clock; the stock doesn&apos;t. Whatever happens while the exchange is shut lands all at once on the next
          opening print. Pay once, and if the stock opens below your level, the vault pays the difference, settled on-chain by the oracle&apos;s price at
          the 09:30 ET open.
        </p>
        <Activity />
      </section>
      <Protect />
      <HowItWorks />
      <ForAgents />
    </>
  );
}
