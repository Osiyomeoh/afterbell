import { DEFAULT_QUOTER_CONFIG } from "@root/quoter/quoter";
import { DEFAULT_PARAMS } from "@root/solana/client/vault";

import { SOLANA_DEPLOYMENT } from "@/server/deployment";
import { evmDeployment } from "@/server/evmDeployment";

const margin = `${Math.round(DEFAULT_QUOTER_CONFIG.margin * 100)}%`;

// Each step says what happens in a line; how it's checked opens underneath.
const STEPS = [
  {
    title: "Choose your levels",
    body: "Pick a stock, your shares, and where protection starts and stops.",
    detail: `Priced from how that stock has actually opened after every recorded close, read from the oracle it settles on, plus a ${margin} margin, and never under ${DEFAULT_QUOTER_CONFIG.minRate * 100}% of the most it can pay. Outside the session it's quoted from the lower of the last close and the live price, so a drop after the close can't buy cheap protection.`,
  },
  {
    title: "Pay once",
    body: "One transaction. The vault locks the full payout, and you get an NFT.",
    detail: `The quote service signs the price for ${DEFAULT_QUOTER_CONFIG.ttlSecs} seconds, and Solana's Ed25519 program checks that signature in the same transaction.`,
  },
  {
    title: "The bell settles it",
    body: "The oracle's first price at the 09:30 ET open decides every position.",
    detail: `The program accepts only a Pyth print published within ${DEFAULT_PARAMS.settleWindowSecs} seconds of the open whose previous print came before it, so nobody can choose a convenient price. Anyone may settle; our keeper does.`,
  },
  {
    title: "Get paid",
    body: "If it opened below your level, the NFT's holder is paid the difference.",
    detail: `The keeper pays it into the holder's wallet, or the holder claims it on My protection. If no valid price arrives, as in a halt, every premium is refunded after ${DEFAULT_PARAMS.voidDelaySecs / 3600} hours.`,
  },
];

export function HowItWorks() {
  const robinhood = evmDeployment();
  const onSolana = SOLANA_DEPLOYMENT ? `Solana sells ${Object.keys(SOLANA_DEPLOYMENT.feeds).join(" and ")}` : "Solana's vault v2 isn't deployed yet";
  return (
    <section className="mt-16">
      <h2 className="text-xl font-semibold tracking-tight">How it works</h2>
      <ol className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s, i) => (
          <li key={s.title} className="rounded-2xl border border-line bg-surface p-5">
            <div className="num text-sm text-brass">{i + 1}</div>
            <h3 className="mt-1 font-medium">{s.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">{s.body}</p>
            <details className="mt-2 text-xs leading-relaxed text-faint">
              <summary className="cursor-pointer text-muted hover:text-text">How it&apos;s checked</summary>
              <p className="mt-1.5">{s.detail}</p>
            </details>
          </li>
        ))}
      </ol>
      <p className="mt-4 max-w-3xl text-sm leading-relaxed text-faint">
        {robinhood
          ? "On Robinhood Chain, the same vault takes an EIP-712 signed quote and settles on Chainlink's price in force at 09:30 ET, for every US stock Chainlink publishes there. Both vaults take TestUSD, a token with no value; the only real cost is gas on Robinhood Chain. "
          : `Afterbell runs on Solana devnet with TestUSD, a token with no value, so everything here is free to try. ${onSolana}; the other stocks here are priced for Robinhood Chain, where the vault settles on Chainlink and isn't deployed yet. `}
        The payout works like a put spread: it
        doesn&apos;t check that you hold the stock. The quote service sets prices but never holds money; the vault pays only on the oracle&apos;s price.
      </p>
    </section>
  );
}
