"use client";

import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { fetchPositions, type PositionRow } from "@/lib/api";
import { solanaStandingOrders, stopEveryNightOnSolana, type SolanaStandingOrder } from "@/lib/buy";
import { claimPosition } from "@/lib/claim";
import { explorer, nyTime, usd } from "@/lib/format";
import { useSendTransaction } from "@/lib/send";

import { type Claimed, ExampleCard, PositionsTable } from "./shared";

export function SolanaPositions({ vault, nextOpen }: { vault: { vault: string; collateralMint: string }; nextOpen: number }) {
  const wallet = useAnchorWallet();
  const sendTransaction = useSendTransaction();
  const { connection } = useConnection();
  const { setVisible } = useWalletModal();
  const [rows, setRows] = useState<PositionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<Claimed[]>([]);

  const load = useCallback(() => {
    if (!wallet) return;
    fetchPositions(wallet.publicKey.toBase58()).then((r) => setRows(r.positions), (e: Error) => setError(e.message));
  }, [wallet]);
  useEffect(load, [load]);

  if (!wallet) {
    return (
      <div className="grid items-center gap-6 rounded-2xl border border-line bg-surface p-6 sm:grid-cols-[1fr_16rem]">
        <div>
          <p className="text-lg font-medium">Your protection lives in your wallet, as an NFT.</p>
          <ul className="mt-3 space-y-1.5 text-sm leading-relaxed text-muted">
            <li>It shows the stock, the open it covers and where it pays.</li>
            <li>After the bell, it pays whoever holds it: our keeper sends the payout, or you claim it here.</li>
            <li>You can send it to another wallet, and the payout follows it.</li>
          </ul>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button onClick={() => setVisible(true)} className="rounded-xl bg-brass px-4 py-2.5 font-medium text-ink">
              Connect a wallet
            </button>
            <Link href="/" className="text-sm text-muted hover:text-text">
              Or protect a stock first
            </Link>
          </div>
        </div>
        <ExampleCard nextOpen={nextOpen} />
      </div>
    );
  }

  async function claim(p: PositionRow) {
    if (!wallet || !p.nftAccount) return;
    try {
      setClaiming(p.address);
      const sig = await claimPosition(connection, wallet, sendTransaction, { ...vault, series: p.series, position: p.address, nftAccount: p.nftAccount });
      setClaimed((c) => [...c, { key: p.address, url: explorer("tx", sig) }]);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setClaiming(null);
    }
  }
  return (
    <>
      <PositionsTable chain="solana" rows={rows} error={error} claiming={claiming} claimed={claimed} onClaim={claim} />
      <SolanaStandingOrders vault={vault} />
    </>
  );
}

/** The wallet's Solana standing orders, each with a way to stop it. */
function SolanaStandingOrders({ vault }: { vault: { vault: string; collateralMint: string } }) {
  const wallet = useAnchorWallet();
  const sendTransaction = useSendTransaction();
  const { connection } = useConnection();
  const [orders, setOrders] = useState<SolanaStandingOrder[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!wallet) return;
    // A vault deployed before standing orders has none to list.
    solanaStandingOrders(connection, wallet, vault.vault).then(setOrders, () => setOrders([]));
  }, [connection, wallet, vault.vault]);
  useEffect(load, [load]);

  async function stop(o: SolanaStandingOrder) {
    if (!wallet) return;
    try {
      setBusy(o.symbol);
      await stopEveryNightOnSolana(connection, wallet, sendTransaction, vault, o.feedId);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!orders || (orders.length === 0 && !error)) return null;
  return (
    <div className="mt-4 rounded-2xl border border-line bg-surface p-5 text-sm">
      <h3 className="font-medium">Protected every night</h3>
      <ul className="mt-3 divide-y divide-line">
        {orders.map((o) => (
          <li key={o.symbol} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
            <span>
              {o.maxShares} {o.symbol}, {o.startBps / 100}% to {o.depthBps / 100}% below the price, at most <span className="num">{usd(o.maxPremium)}</span> a
              night, until {nyTime(o.until)}
            </span>
            <button onClick={() => stop(o)} disabled={busy === o.symbol} className="rounded-lg border border-line px-2.5 py-1 text-xs hover:border-loss disabled:opacity-40">
              {busy === o.symbol ? "Stopping…" : "Stop"}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-loss">{error}</p>}
    </div>
  );
}
