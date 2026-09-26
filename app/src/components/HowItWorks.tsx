import { DEFAULT_QUOTER_CONFIG } from "@root/quoter/quoter";
import { DEFAULT_CONFIG } from "@root/solana/client/vault";

import { evmDeployment } from "@/server/evmDeployment";

const margin = `${Math.round(DEFAULT_QUOTER_CONFIG.margin * 100)}%`;

const STEPS = [
  {
    title: "Choose your levels",
    body: `Pick the shares and where protection starts and stops. It's priced from how TSLA has actually opened after every recorded close, from Pyth, plus a ${margin} margin. Outside the session it's quoted from the lower of the last close and the live price, so a drop after the close can't buy cheap protection.`,
  },
  {
    title: "Pay once",
    body: `The quote service signs the price for ${DEFAULT_QUOTER_CONFIG.ttlSecs} seconds. Your wallet sends one transaction: Solana's Ed25519 program checks the signature, and the vault takes the premium and locks the most it could pay. Every position is fully backed from the moment it's bought.`,
  },
  {
    title: "The bell settles it",
    body: `Every position for an open settles on the first Pyth price at or after 09:30 ET. The program accepts only a print published within ${DEFAULT_CONFIG.settleWindowSecs} seconds of the open whose previous print came before it, so nobody can choose a convenient price. Anyone may settle; our keeper does.`,
  },
  {
    title: "Get paid",
    body: `If TSLA opened below where your protection starts, you're paid the difference on every share, down to where it stops. The keeper claims into your wallet, or you can claim on My protection. If no valid price arrives, as in a halt, every premium is refunded after ${DEFAULT_CONFIG.voidDelaySecs / 3600} hours.`,
  },
];

export function HowItWorks() {
  const robinhood = evmDeployment();
  return (
    <section className="mt-16">
      <h2 className="text-xl font-semibold tracking-tight">How it works</h2>
      <ol className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s, i) => (
          <li key={s.title} className="rounded-2xl border border-line bg-surface p-5">
            <div className="num text-sm text-brass">{i + 1}</div>
            <h3 className="mt-1 font-medium">{s.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">{s.body}</p>
          </li>
        ))}
      </ol>
      <p className="mt-4 max-w-3xl text-sm leading-relaxed text-faint">
        {robinhood
          ? "On Robinhood Chain, the same vault takes an EIP-712 signed quote and settles on Chainlink's TSLA price in force at 09:30 ET. Both vaults take TestUSD, a token with no value; the only real cost is gas on Robinhood Chain. "
          : "Afterbell runs on Solana devnet with TestUSD, a token with no value, so everything here is free to try. "}
        The payout works like a put spread: it
        doesn&apos;t check that you hold the stock. The quote service sets prices but never holds money; the vault pays only on the oracle&apos;s price.
      </p>
    </section>
  );
}
