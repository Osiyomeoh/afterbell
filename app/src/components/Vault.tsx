"use client";

import { useEffect, useState } from "react";

import { fetchVault, type Chain, type VaultResponse } from "@/lib/api";
import { evmAddressUrl } from "@/lib/evm";
import { explorer, nyTime, usd } from "@/lib/format";

import { Pool } from "./Underwrite";

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
      {v.pool ? (
        <div className="grid gap-4 sm:grid-cols-3">
          {/* While protection is open, the contract values the pool as if every position pays its maximum. */}
          <Stat label={v.locked > 0 ? "Pool value if every position pays in full" : "Pool value (TestUSD)"} value={usd(v.pool.nav)} />
          <Stat label={v.locked > 0 ? "Share price, same worst case" : "Share price"} value={usd(v.pool.sharePrice, 6)} />
          <Stat label="Locked for open protection" value={usd(v.locked)} />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat label="Collateral (TestUSD)" value={usd(v.collateral)} />
          <Stat label="Locked for open protection" value={usd(v.locked)} />
          <Stat label="Free to sell against" value={usd(v.collateral - v.locked)} />
        </div>
      )}
      {v.pool && <Pool pool={v.pool} chain={chain} />}

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

      {v.firstVault && <FirstVault f={v.firstVault} />}

      <section className="rounded-2xl border border-line bg-surface p-5 text-sm leading-relaxed text-muted">
        <p>
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

/**
 * Solana's first vault sells nothing new, but what it sold stays open until it
 * settles, and the hedge counts it: listed here so this page counts it too.
 * Nothing shows once it has nothing open.
 */
function FirstVault({ f }: { f: NonNullable<VaultResponse["firstVault"]> }) {
  if (!("error" in f) && f.open.length === 0) return null;
  return (
    <section className="rounded-2xl border border-line bg-surface">
      <h2 className="border-b border-line px-4 py-3 font-medium">Still open in the first vault</h2>
      <p className="px-4 py-3 text-sm leading-relaxed text-muted">
        Solana&apos;s first vault,{" "}
        <a className="num text-text hover:underline" href={explorer("address", f.vault)} target="_blank" rel="noreferrer">
          {f.vault.slice(0, 6)}…{f.vault.slice(-4)}
        </a>
        , no longer sells protection. What it sold before this vault opened stays open until its series settles at the open, and it pays from the
        first vault&apos;s own collateral. The hedge below counts it.
      </p>
      {"error" in f ? (
        <p className="border-t border-line px-4 py-3 text-sm">Couldn&apos;t read it: {f.error}</p>
      ) : (
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full text-sm">
            <thead className="text-left text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-3 font-normal">Open</th>
                <th className="px-4 py-3 font-normal">Stock</th>
                <th className="px-4 py-3 text-right font-normal">Positions</th>
                <th className="px-4 py-3 text-right font-normal">Shares</th>
                <th className="px-4 py-3 text-right font-normal">Locked</th>
              </tr>
            </thead>
            <tbody>
              {f.open.map((s) => (
                <tr key={s.address} className="border-b border-line last:border-0">
                  <td className="whitespace-nowrap px-4 py-3">
                    <a className="hover:underline" href={explorer("address", s.address)} target="_blank" rel="noreferrer">
                      {nyTime(s.openTs)}
                    </a>
                  </td>
                  <td className="px-4 py-3">{s.symbol}</td>
                  <td className="num px-4 py-3 text-right">{s.positions}</td>
                  <td className="num px-4 py-3 text-right">{Number(s.shares.toFixed(6))}</td>
                  <td className="num px-4 py-3 text-right">{usd(s.maxPayout)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
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
