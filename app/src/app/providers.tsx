"use client";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { clusterApiUrl } from "@solana/web3.js";
import { useCallback, useEffect, useState } from "react";
import "@solana/wallet-adapter-react-ui/styles.css";

const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC || clusterApiUrl("devnet");

export function Providers({ children }: { children: React.ReactNode }) {
  const [error, setError] = useState<string | null>(null);
  // A wallet that fails (to connect, or to sign) would otherwise do nothing visible. An uninstalled
  // one isn't an error here: the adapter opens its install page instead.
  const onError = useCallback((e: Error) => {
    if (e.name === "WalletNotReadyError") return;
    // The adapter keeps the wallet's own error underneath; its code says more than "Unexpected error" does.
    const inner = (e as Error & { error?: { code?: number | string; message?: string } }).error;
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
      {/* Wallets that implement the Wallet Standard (Phantom, Solflare, Backpack) register themselves. */}
      <WalletProvider wallets={[]} autoConnect onError={onError}>
        <WalletModalProvider>
          {children}
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
