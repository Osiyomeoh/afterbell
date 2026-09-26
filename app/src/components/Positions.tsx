"use client";

import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useCallback, useEffect, useState } from "react";

import { fetchMarket, fetchPositions, type PositionRow } from "@/lib/api";
import { claimPosition } from "@/lib/claim";
import { explorer, nyTime, usd } from "@/lib/format";

export function Positions() {
  const wallet = useAnchorWallet();
  const { sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { setVisible } = useWalletModal();
  const [rows, setRows] = useState<PositionRow[] | null>(null);
  const [vault, setVault] = useState<{ vault: string; collateralMint: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    if (!wallet) return;
    fetchPositions(wallet.publicKey.toBase58()).then((r) => setRows(r.positions), (e: Error) => setError(e.message));
  }, [wallet]);

  useEffect(() => {
    load();
    fetchMarket().then((m) => setVault({ vault: m.solana.vault, collateralMint: m.solana.collateralMint }), () => {});
  }, [load]);

  if (!wallet) {
    return (
      <Panel>
        <p className="text-muted">Connect the wallet you bought protection with.</p>
        <button onClick={() => setVisible(true)} className="mt-4 rounded-xl bg-brass px-4 py-2.5 font-medium text-ink">
          Connect a wallet
        </button>
      </Panel>
    );
  }
  if (error) return <Panel>Couldn&apos;t load your positions: {error}</Panel>;
  if (!rows) return <Panel>Loading…</Panel>;
  if (rows.length === 0 && Object.keys(claimed).length === 0) {
    return <Panel>No open protection. Positions disappear here once they&apos;re claimed; the payout goes straight to your wallet.</Panel>;
  }

  async function claim(p: PositionRow) {
    if (!wallet || !vault) return;
    try {
      setClaiming(p.address);
      const sig = await claimPosition(connection, wallet, sendTransaction, { ...vault, series: p.series, position: p.address });
      setClaimed((c) => ({ ...c, [p.address]: sig }));
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setClaiming(null);
    }
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
      <table className="w-full text-sm">
        <thead className="text-left text-muted">
          <tr className="border-b border-line">
            <th className="px-4 py-3 font-normal">Settles</th>
            <th className="px-4 py-3 font-normal">Shares</th>
            <th className="px-4 py-3 font-normal">Protected</th>
            <th className="px-4 py-3 text-right font-normal">Paid</th>
            <th className="px-4 py-3 text-right font-normal">Pays up to</th>
            <th className="px-4 py-3 font-normal">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.address} className="border-b border-line last:border-0">
              <td className="px-4 py-3">{nyTime(p.openTs)}</td>
              <td className="num px-4 py-3">{p.shares}</td>
              <td className="num px-4 py-3">
                {usd(p.upper)} → {usd(p.lower)}
              </td>
              <td className="num px-4 py-3 text-right">{usd(p.premium)}</td>
              <td className="num px-4 py-3 text-right">{usd(p.maxPayout)}</td>
              <td className="px-4 py-3">
                <Status p={p} busy={claiming === p.address} onClaim={() => claim(p)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {Object.entries(claimed).map(([pos, sig]) => (
        <p key={pos} className="border-t border-line px-4 py-3 text-sm text-gain">
          Claimed.{" "}
          <a className="underline" href={explorer("tx", sig)} target="_blank" rel="noreferrer">
            View transaction
          </a>
        </p>
      ))}
    </div>
  );
}

function Status({ p, busy, onClaim }: { p: PositionRow; busy: boolean; onClaim: () => void }) {
  if (p.state === "open") return <span className="text-muted">Open until the bell</span>;
  const label =
    p.state === "voided"
      ? `Voided: ${usd(p.claimable ?? 0)} back`
      : (p.claimable ?? 0) > 0
        ? `Opened ${usd(p.settlementPrice ?? 0)}: pays ${usd(p.claimable ?? 0)}`
        : `Opened ${usd(p.settlementPrice ?? 0)}: no payout`;
  return (
    <span className="flex items-center gap-3">
      <span className={(p.claimable ?? 0) > 0 ? "text-gain" : "text-muted"}>{label}</span>
      <button onClick={onClaim} disabled={busy} className="rounded-lg border border-line px-2.5 py-1 text-xs hover:border-brass disabled:opacity-40">
        {busy ? "Claiming…" : (p.claimable ?? 0) > 0 ? "Claim" : "Close"}
      </button>
    </span>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-line bg-surface p-6">{children}</div>;
}
