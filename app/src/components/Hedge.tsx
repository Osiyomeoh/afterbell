"use client";

import { useEffect, useState } from "react";

import { fetchHedge, type HedgeResponse } from "@/lib/api";
import { nyTime, usd } from "@/lib/format";

const shares = (x: number) => `${x.toFixed(3)} TSLA`;

/** Hyperliquid's explorer page for an account on the network the hedge trades on. */
const accountUrl = (network: HedgeResponse["network"], address: string) =>
  `https://app.${network === "mainnet" ? "hyperliquid.xyz" : "hyperliquid-testnet.xyz"}/explorer/address/${address}`;

export function Hedge() {
  const [h, setH] = useState<HedgeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      fetchHedge().then(
        (r) => {
          setH(r);
          setError(null);
        },
        (e: Error) => setError(e.message),
      );
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <section className="space-y-4 pt-10">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Hedge on Hyperliquid</h2>
        <p className="mt-2 max-w-2xl leading-relaxed text-muted">
          Open protection pays more the further TSLA falls. A short in Hyperliquid&apos;s xyz:TSLA perp, sized to how much more it pays for each $1
          fall, pays part of that back. The size comes from the same model that prices the protection; the short follows the price through the night
          and is bought back at the open.
        </p>
      </div>
      {error && !h && <div className="rounded-2xl border border-line bg-surface p-6">Couldn&apos;t read the hedge: {error}</div>}
      {!error && !h && <div className="rounded-2xl border border-line bg-surface p-6 text-muted">Reading the hedge…</div>}
      {h && <HedgeView h={h} />}
    </section>
  );
}

function HedgeView({ h }: { h: HedgeResponse }) {
  const p = h.account?.position ?? null;
  const held = h.account ? (p ? p.short : 0) : null;
  return (
    <div className="space-y-4">
      <p className="rounded-2xl border border-line bg-surface p-4 text-sm leading-relaxed text-muted">
        {h.account ? (
          <>
            Trading on Hyperliquid {h.network} with test money. Testnet&apos;s TSLA market has almost no other orders, so our own quoting account quotes
            at mainnet&apos;s price and the hedge trades against it.
          </>
        ) : (
          <>Not running yet: no hedge account holds the short. Below is the short the open protection calls for now.</>
        )}
      </p>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="TSLA on Hyperliquid mainnet" value={usd(h.mid)} />
        <Stat label="Short to hold" value={shares(h.target)} note={`${usd(h.target * h.mid)} of TSLA`} />
        <Stat label="Short held" value={held === null ? "None yet" : shares(held)} note={p?.entryPx ? `from ${usd(p.entryPx)}` : undefined} />
      </div>

      <section className="rounded-2xl border border-line bg-surface">
        <h3 className="border-b border-line px-4 py-3 font-medium">Open protection in TSLA</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-3 font-normal">Open</th>
                <th className="px-4 py-3 text-right font-normal">Positions</th>
                <th className="px-4 py-3 text-right font-normal">Shares</th>
                <th className="px-4 py-3 text-right font-normal">Pays at most</th>
                <th className="px-4 py-3 text-right font-normal">Short for it</th>
              </tr>
            </thead>
            <tbody>
              {h.opens.map((o) => (
                <tr key={o.openTs} className="border-b border-line last:border-0">
                  <td className="px-4 py-3">{nyTime(o.openTs)}</td>
                  <td className="num px-4 py-3 text-right">{o.positions}</td>
                  <td className="num px-4 py-3 text-right">{o.shares}</td>
                  <td className="num px-4 py-3 text-right">{usd(o.maxPayout)}</td>
                  <td className="num px-4 py-3 text-right">{shares(o.hedge)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {h.opens.length === 0 && <p className="px-4 py-3 text-sm text-muted">Nothing open in TSLA, so no short is needed.</p>}
      </section>

      <div className="space-y-2 text-sm leading-relaxed text-muted">
        {h.capped && (
          <p>
            The short is capped at {usd(h.maxNotional, 0)} of TSLA; the open protection calls for {shares(h.hedge)}, so part of it isn&apos;t hedged.
          </p>
        )}
        {h.notHedged.map((n) => (
          <p key={n.symbol}>
            {n.symbol}: {n.positions} open position{n.positions === 1 ? "" : "s"}, not hedged (the hedge trades TSLA only).
          </p>
        ))}
        {h.account && (
          <p>
            Hedge account{" "}
            <a className="num text-text hover:underline" href={accountUrl(h.network, h.account.address)} target="_blank" rel="noreferrer">
              {h.account.address.slice(0, 6)}…{h.account.address.slice(-4)}
            </a>{" "}
            on Hyperliquid {h.network}: {usd(h.account.accountValue)} on the xyz market
            {p && (
              <>
                , P&amp;L {usd(p.unrealizedPnl)}, {usd(p.marginUsed)} of margin, {p.leverage.type} {p.leverage.value}×
                {p.liquidationPx !== null && <>, liquidated if TSLA reaches {usd(p.liquidationPx)}</>}
              </>
            )}
            .
          </p>
        )}
        <p>
          {counted(h.vaults)}
          {!h.vaults.some((v) => v.chain === "robinhood") && <> Robinhood Chain&apos;s vault isn&apos;t counted yet: it isn&apos;t deployed.</>}
        </p>
      </div>
    </div>
  );
}

const CHAINS = [
  { id: "solana", name: "Solana" },
  { id: "robinhood", name: "Robinhood Chain" },
] as const;

/** Which vaults the hedge counts, chain by chain: "It counts the protection sold on Solana (the current vault: 0 open; …)." */
function counted(vaults: HedgeResponse["vaults"]): string {
  const parts = CHAINS.flatMap((c) => {
    const mine = vaults.filter((v) => v.chain === c.id);
    return mine.length ? [`on ${c.name} (${mine.map((v) => `${v.label}: ${v.positions} open`).join("; ")})`] : [];
  });
  return parts.length ? `It counts the protection sold ${parts.join(" and ")}.` : "No vault is deployed for it to count.";
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <div className="text-sm text-muted">{label}</div>
      <div className="num mt-1 text-2xl font-semibold">{value}</div>
      {note && <div className="num mt-1 text-sm text-muted">{note}</div>}
    </div>
  );
}
