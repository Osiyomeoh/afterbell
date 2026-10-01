"use client";

import { ConnectionProvider, useWallet, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { clusterApiUrl } from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import "@solana/wallet-adapter-react-ui/styles.css";

import { TestWalletAdapter } from "@/lib/testWallet";

const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC || clusterApiUrl("devnet");

export function Providers({ children }: { children: React.ReactNode }) {
  const [error, setError] = useState<string | null>(null);
  const wallets = useMemo(() => [new TestWalletAdapter()], []);
  // A wallet that fails (to connect, or to sign) would otherwise do nothing visible. An uninstalled
  // one isn't an error here: the adapter opens its install page instead.
  const onError = useCallback((e: Error) => {
    if (e.name === "WalletNotReadyError") return;
    // The adapter keeps the wallet's own error underneath; its code says more than "Unexpected error" does.
    const inner = (e as Error & { error?: { code?: number | string; message?: string } }).error;
    // A rejection is the person's own answer, and the page says what it means where it matters. On a
    // reload the page also asks quietly to reconnect, which the wallet declines the same way.
    if (inner?.code === 4001 || /user rejected/i.test(e.message)) return;
    const detail = inner && (inner.code !== undefined || (inner.message && inner.message !== e.message)) ? ` (${[inner.code !== undefined ? `code ${inner.code}` : "", inner.message && inner.message !== e.message ? inner.message : ""].filter(Boolean).join(": ")})` : "";
    setError((e.message || e.name.replace(/Error$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()) + detail);
  }, []);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 10_000);
    return () => clearTimeout(t);
  }, [error]);

  return (
    <ConnectionProvider endpoint={endpoint}>
      {/* Wallets that implement the Wallet Standard (Phantom, Solflare, Backpack) register themselves; the test wallet is ours. */}
      <WalletProvider wallets={wallets} autoConnect onError={onError}>
        <WalletModalProvider>
          {children}
          <ConnectingHint />
          {error && (
            <div role="alert" className="fixed inset-x-4 top-4 z-[1100] mx-auto flex max-w-md items-start gap-3 rounded-xl border border-loss/50 bg-surface px-4 py-3 text-sm shadow-lg">
              <span className="flex-1">
                <span className="text-loss">Your wallet reported:</span> {error}
              </span>
              <button type="button" onClick={() => setError(null)} aria-label="Dismiss" className="text-muted hover:text-text">
                ×
              </button>
            </div>
          )}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

/**
 * A wallet asked to connect answers in its own window, which can open behind
 * the browser or wait for the wallet to be unlocked. After a few seconds of
 * "Connecting…", say where to look, and offer a way out.
 */
function ConnectingHint() {
  const { connecting, wallet } = useWallet();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!connecting) return setSlow(false);
    const t = setTimeout(() => setSlow(true), 6_000);
    return () => clearTimeout(t);
  }, [connecting]);
  if (!connecting || !slow) return null;
  const name = wallet?.adapter.name ?? "your wallet";
  return (
    <div role="status" className="fixed inset-x-4 top-4 z-[1100] mx-auto max-w-md rounded-xl border border-line bg-surface px-4 py-3 text-sm shadow-lg">
      <p>
        Waiting for {name} to answer. Approve the connection in its window. If none opened, click {name}&apos;s icon in your browser&apos;s toolbar
        (unlock it if asked): the request is waiting there.
      </p>
      {/* A request the wallet never answers can't be withdrawn; forgetting the wallet and reloading starts clean. */}
      <button
        type="button"
        onClick={() => {
          try {
            localStorage.removeItem("walletName");
          } catch {}
          window.location.reload();
        }}
        className="mt-2 text-muted underline hover:text-text"
      >
        Cancel and start again
      </button>
    </div>
  );
}
