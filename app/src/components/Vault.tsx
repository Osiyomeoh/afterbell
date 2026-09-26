"use client";

import { useEffect, useState } from "react";

import { fetchVault, type Chain, type VaultResponse } from "@/lib/api";
import { evmAddressUrl } from "@/lib/evm";
import { explorer, nyTime, usd } from "@/lib/format";

const CHAINS: { id: Chain; label: string }[] = [
  { id: "solana", label: "Solana devnet" },
  { id: "robinhood", label: "Robinhood Chain" },
];

export function Vault() {
  const [chain, setChain] = useState<Chain>("solana");
  return (
    <div className="space-y-6">
      <div className="inline-flex rounded-lg border border-line bg-ink p-0.5 text-sm" role="tablist" aria-label="Chain">
        {CHAINS.map((c) => (
          <button
            key={c.id}
            role="tab"
            aria-selected={chain === c.id}
            onClick={() => setChain(c.id)}
            className={`rounded-md px-3 py-1.5 ${chain === c.id ? "bg-raised text-text" : "text-muted hover:text-text"}`}
          >
            {c.label}
          </button>
        ))}
      </div>
      <ChainVault key={chain} chain={chain} />
    </div>
  );
}

function ChainVault({ chain }: { chain: Chain }) {
  const [v, setV] = useState<VaultResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () => fetchVault(chain).then(setV, (e: Error) => setError(e.message));
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [chain]);

  if (error) return <div className="rounded-2xl border border-line bg-surface p-6">Couldn&apos;t read the vault: {error}</div>;
  if (!v) return <div className="rounded-2xl border border-line bg-surface p-6 text-muted">Reading the vault…</div>;
  const solana = chain === "solana";
  const vaultUrl = solana ? explorer("address", v.vault) : evmAddressUrl({ chainId: v.chainId ?? 0 }, v.vault);

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
              <th className="px-4 py-3 font-normal">Stock</th>
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
                  {solana ? (
                    <a className="hover:underline" href={explorer("address", s.address)} target="_blank" rel="noreferrer">
                      {nyTime(s.openTs)}
                    </a>
                  ) : (
                    nyTime(s.openTs)
                  )}
                </td>
                <td className="px-4 py-3">{s.symbol}</td>
                <td className="px-4 py-3">{s.state === "settled" ? `Settled at ${usd(s.price ?? 0)}` : s.state === "voided" ? "Voided, refunded" : "Open"}</td>
                <td className="num px-4 py-3 text-right">{s.positions}</td>
                <td className="num px-4 py-3 text-right">{usd(s.premiums)}</td>
                <td className="num px-4 py-3 text-right">{usd(s.maxPayouts)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        {v.series.length === 0 && <p className="px-4 py-3 text-sm text-muted">No protection sold here yet.</p>}
        {v.series.length > 0 && settled.length === 0 && (
          <p className="border-t border-line px-4 py-3 text-sm text-muted">No series has settled yet. Each settles at the open it protects until.</p>
        )}
      </section>

      <section className="rounded-2xl border border-line bg-surface p-5 text-sm leading-relaxed text-muted">
        <h2 className="font-medium text-text">Hedge</h2>
        <p className="mt-2">
          Planned: the vault will short the matching Hyperliquid perp at the close and close it at the open, so its exposure follows the price its
          protection settles on. Not live yet.
        </p>
        <p className="mt-3">
          Vault{" "}
          {vaultUrl ? (
            <a className="num text-text hover:underline" href={vaultUrl} target="_blank" rel="noreferrer">
              {v.vault.slice(0, 6)}…{v.vault.slice(-4)}
            </a>
          ) : (
            <span className="num text-text">
              {v.vault.slice(0, 6)}…{v.vault.slice(-4)}
            </span>
          )}{" "}
          on {solana ? "Solana devnet, settled by Pyth" : "Robinhood Chain, settled by Chainlink"}. Collateral is TestUSD, a token with no value.
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
