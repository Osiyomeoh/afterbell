"use client";

import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useRef, useState } from "react";

import { requestTestFunds } from "@/lib/api";
import { explorer, usd } from "@/lib/format";
import { TestWalletName } from "@/lib/testWallet";

/** The connected wallet's TestUSD and SOL, with a button to top up from the devnet faucet. */
export function TestFunds({ mint, refreshKey }: { mint: string; refreshKey?: unknown }) {
  const { publicKey, wallet } = useWallet();
  const { connection } = useConnection();
  const [balances, setBalances] = useState<{ testUsd: number; sol: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string; signature?: string } | null>(null);

  const load = useCallback(async () => {
    if (!publicKey) return;
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), publicKey);
    const [t, s] = await Promise.all([
      connection.getTokenAccountBalance(ata).then((b) => b.value.uiAmount ?? 0, () => 0),
      connection.getBalance(publicKey),
    ]);
    setBalances({ testUsd: t, sol: s / LAMPORTS_PER_SOL });
  }, [publicKey, connection, mint]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const topUp = useCallback(async () => {
    if (!publicKey) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await requestTestFunds(publicKey.toBase58());
      setMessage(
        r.alreadyFunded
          ? { ok: true, text: "You already have enough test money." }
          : { ok: true, text: `Sent ${[r.testUsd && `${r.testUsd.toLocaleString()} TestUSD`, r.sol && `${r.sol} SOL`].filter(Boolean).join(" and ")}.`, signature: r.signature ?? undefined },
      );
      await load();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [publicKey, load]);

  // A test wallet is there to be tried at once: fund it as soon as it connects with nothing in it.
  const isTestWallet = wallet?.adapter.name === TestWalletName;
  const autoFunded = useRef(false);
  useEffect(() => {
    if (!isTestWallet || !balances || autoFunded.current || (balances.testUsd > 0 && balances.sol > 0)) return;
    autoFunded.current = true;
    topUp();
  }, [isTestWallet, balances, topUp]);

  // Before a wallet connects, say up front that this runs on test money and where it comes from.
  if (!publicKey) {
    return (
      <div className="rounded-2xl border border-line bg-surface p-5 text-sm leading-relaxed">
        <div className="text-muted">Test money</div>
        <p className="mt-2 text-muted">
          This runs on Solana devnet with TestUSD, a token with no value. Connect a wallet and get 1,000 TestUSD and a little devnet SOL for fees
          here, free.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-line bg-surface p-5 text-sm">
      <div className="flex items-baseline justify-between">
        <span className="text-muted">Your test money</span>
        <button onClick={topUp} disabled={busy} className="rounded-lg border border-line px-2.5 py-1 text-xs hover:border-brass disabled:opacity-40">
          {busy ? "Sending…" : "Get test money"}
        </button>
      </div>
      <div className="num mt-2">
        {balances ? `${usd(balances.testUsd)} TestUSD · ${balances.sol.toFixed(3)} SOL` : "…"}
      </div>
      {message && (
        <p className={`mt-2 ${message.ok ? "text-gain" : "text-loss"}`}>
          {message.text}{" "}
          {message.signature && (
            <a className="underline" href={explorer("tx", message.signature)} target="_blank" rel="noreferrer">
              View
            </a>
          )}
        </p>
      )}
      <p className="mt-2 text-xs text-faint">
        Devnet only. TestUSD has no value.
        {isTestWallet && " This test wallet is kept in this browser: fine for test money, never for real funds."}
      </p>
    </div>
  );
}
