import Link from "next/link";

import { robinhoodChain } from "@root/evm/client/vault";

import { explorer } from "@/lib/format";
import { SOLANA_DEPLOYMENT } from "@/server/deployment";
import { evmDeployment } from "@/server/evmDeployment";

const REPO = "https://github.com/Osiyomeoh/afterbell";

/** What every page ends on: that this is test money, what the payout depends on, and where to check it all. */
export function Footer() {
  const robinhood = evmDeployment();
  const links = [
    { href: REPO, label: "Source" },
    { href: `${REPO}/blob/main/docs/design.md`, label: "Design" },
    SOLANA_DEPLOYMENT && { href: explorer("address", SOLANA_DEPLOYMENT.vault), label: "Solana vault" },
    robinhood?.chainId === robinhoodChain.id && {
      href: `${robinhoodChain.blockExplorers.default.url}/address/${robinhood.vault}`,
      label: "Robinhood Chain vault",
    },
  ].filter((l): l is { href: string; label: string } => !!l);

  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-8 text-sm sm:flex-row sm:justify-between sm:px-6">
        <p className="max-w-xl leading-relaxed text-faint">
          Test money only: the vaults hold TestUSD, a token with no value. A position pays on the oracle&apos;s price at the open, whether or not you
          hold the stock. Nothing here is financial advice.
        </p>
        <nav className="flex flex-wrap gap-x-5 gap-y-2 text-muted">
          <Link className="whitespace-nowrap hover:text-text" href="/gap">
            Gap report
          </Link>
          <Link className="whitespace-nowrap hover:text-text" href="/status">
            Status
          </Link>
          {links.map((l) => (
            <a key={l.label} className="whitespace-nowrap hover:text-text" href={l.href} target="_blank" rel="noreferrer">
              {l.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
