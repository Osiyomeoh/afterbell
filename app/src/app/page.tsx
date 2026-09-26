import { ForAgents } from "@/components/ForAgents";
import { HowItWorks } from "@/components/HowItWorks";
import { Protect } from "@/components/Protect";

export default function Home() {
  return (
    <>
      <section className="py-10 sm:py-14">
        <h1 className="max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">Protection for your tokenized stock until the next opening bell.</h1>
        <p className="mt-4 max-w-2xl leading-relaxed text-muted">
          Tokenized stocks trade around the clock; the stock doesn&apos;t. Whatever happens while the exchange is shut lands all at once on the next
          opening print. Pay once, and if the stock opens below your level, the vault pays the difference, settled on-chain by the oracle&apos;s price at
          the 09:30 ET open.
        </p>
      </section>
      <Protect />
      <HowItWorks />
      <ForAgents />
    </>
  );
}
