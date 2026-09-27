import type { Metadata } from "next";

import { Hedge } from "@/components/Hedge";
import { Vault } from "@/components/Vault";

export const metadata: Metadata = { title: "Vault" };

export default function Page() {
  return (
    <>
      <section className="py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Vault</h1>
        <p className="mt-3 max-w-2xl leading-relaxed text-muted">
          Every sale locks its maximum payout, so the vault can always pay every buyer at once. Premiums stay in the vault. Each series settles on
          one price at the 09:30 ET open: Pyth&apos;s first print at or after it on Solana, Chainlink&apos;s price in force at it on Robinhood Chain.
          Anyone can settle it. On both chains the vault is also a pool anyone can underwrite, and each position is an NFT that pays whoever holds it.
        </p>
      </section>
      <Vault />
      <Hedge />
    </>
  );
}
