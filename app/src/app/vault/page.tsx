import type { Metadata } from "next";

import { Vault } from "@/components/Vault";

export const metadata: Metadata = { title: "Vault" };

export default function Page() {
  return (
    <>
      <section className="py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Vault</h1>
        <p className="mt-3 max-w-2xl leading-relaxed text-muted">
          Every sale locks its maximum payout, so the vault can always pay every buyer at once. Premiums stay in the vault. Each series settles on
          one price, the first Pyth print at or after 09:30 ET, and anyone can settle it.
        </p>
      </section>
      <Vault />
    </>
  );
}
