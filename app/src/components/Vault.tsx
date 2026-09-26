"use client";

import { useEffect, useState } from "react";

import { fetchVault, type VaultResponse } from "@/lib/api";
import { explorer, nyTime, usd } from "@/lib/format";

export function Vault() {
  const [v, setV] = useState<VaultResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () => fetchVault().then(setV, (e: Error) => setError(e.message));
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  if (error) return <div className="rounded-2xl border border-line bg-surface p-6">Couldn&apos;t read the vault: {error}</div>;
  if (!v) return <div className="rounded-2xl border border-line bg-surface p-6 text-muted">Reading the vault…</div>;

  const settled = v.series.filter((s) => s.state !== "open");
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Collateral (TestUSD)" value={usd(v.collateral)} />
        <Stat label="Locked for open protection" value={usd(v.locked)} />
        <Stat label="Free to sell against" value={usd(v.collateral - v.locked)} />
      </div>

      <section className="rounded-2xl border border-line bg-surface">
        <h2 className="border-b border-line px-4 py-3 font-medium">Series</h2>
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted">
            <tr className="border-b border-line">
              <th className="px-4 py-3 font-normal">Open</th>
              <th className="px-4 py-3 font-normal">State</th>
              <th className="px-4 py-3 text-right font-normal">Positions</th>
              <th className="px-4 py-3 text-right font-normal">Premiums</th>
              <th className="px-4 py-3 text-right font-normal">Locked</th>
            </tr>
          </thead>
          <tbody>
            {v.series.map((s) => (
              <tr key={s.address} className="border-b border-line last:border-0">
                <td className="px-4 py-3">
                  <a className="hover:underline" href={explorer("address", s.address)} target="_blank" rel="noreferrer">
                    {nyTime(s.openTs)}
                  </a>
                </td>
                <td className="px-4 py-3">{s.state === "settled" ? `Settled at ${usd(s.price ?? 0)}` : s.state === "voided" ? "Voided, refunded" : "Open"}</td>
                <td className="num px-4 py-3 text-right">{s.positions}</td>
                <td className="num px-4 py-3 text-right">{usd(s.premiums)}</td>
                <td className="num px-4 py-3 text-right">{usd(s.maxPayouts)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        {settled.length === 0 && <p className="border-t border-line px-4 py-3 text-sm text-muted">No series has settled yet. The first settles on Monday 28 September's open.</p>}
      </section>

      <section className="rounded-2xl border border-line bg-surface p-5 text-sm leading-relaxed text-muted">
        <h2 className="font-medium text-text">Hedge</h2>
        <p className="mt-2">
          Planned: the vault will short the matching Hyperliquid perp at the close and close it at the open, so its exposure follows the price its
          protection settles on. Not live yet.
        </p>
        <p className="mt-3">
          Vault{" "}
          <a className="num text-text hover:underline" href={explorer("address", v.vault)} target="_blank" rel="noreferrer">
            {v.vault.slice(0, 4)}…{v.vault.slice(-4)}
          </a>{" "}
          on Solana devnet. Collateral is TestUSD, a token with no value.
        </p>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <div className="text-sm text-muted">{label}</div>
      <div className="num mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}
