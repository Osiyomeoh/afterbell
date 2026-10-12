"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useCallback, useEffect, useState } from "react";

import { fetchWaitlist, requestTestFunds } from "@/lib/api";
import { explorer } from "@/lib/format";
import { useSendTransaction } from "@/lib/send";
import { TestWalletName } from "@/lib/testWallet";
import { joinWaitlistTx, MAX_STOCKS, ROLES, tally, type Role, type WaitlistView } from "@/lib/waitlist";

const POPULAR = ["TSLA", "NVDA", "AAPL", "MSFT", "AMZN", "META", "GOOGL", "COIN", "MSTR", "PLTR", "SPY", "QQQ"];

// Optional: where someone can leave a way to reach them. Nothing private goes on-chain.
const CONTACT_URL = process.env.NEXT_PUBLIC_WAITLIST_CONTACT_URL;

type Status = { kind: "busy"; step: string } | { kind: "done"; signature: string } | { kind: "error"; text: string } | null;

/** Join the mainnet waitlist with one devnet transaction that sends nothing, and see how many have. */
export function Waitlist() {
  const { connection } = useConnection();
  const { publicKey, wallets, select } = useWallet();
  const { setVisible } = useWalletModal();
  const send = useSendTransaction();
  const [view, setView] = useState<WaitlistView | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [stocks, setStocks] = useState<string[]>(["TSLA"]);
  const [status, setStatus] = useState<Status>(null);

  const load = useCallback(() => fetchWaitlist().then(setView, () => {}), []);
  useEffect(() => {
    load();
  }, [load]);

  const mine = publicKey ? view?.signups.find((s) => s.wallet === publicKey.toBase58()) : undefined;
  useEffect(() => {
    if (mine) {
      setRole(mine.role);
      setStocks(mine.stocks);
    }
  }, [mine]);

  const toggle = (s: string) =>
    setStocks((now) => (now.includes(s) ? now.filter((x) => x !== s) : now.length < MAX_STOCKS ? [...now, s] : now));

  async function join() {
    if (!publicKey) {
      const ownWallet = wallets.some((w) => w.adapter.name !== TestWalletName && (w.readyState === "Installed" || w.readyState === "Loadable"));
      return ownWallet ? setVisible(true) : select(TestWalletName);
    }
    if (!role) return setStatus({ kind: "error", text: "Pick the line that fits you best." });
    try {
      // The fee is 0.000005 SOL; a new wallet gets a little from the faucet first.
      if ((await connection.getBalance(publicKey)) < 10_000) {
        setStatus({ kind: "busy", step: "Getting a little devnet SOL for the fee" });
        await requestTestFunds(publicKey.toBase58());
      }
      setStatus({ kind: "busy", step: "Confirm in your wallet" });
      const tx = joinWaitlistTx(publicKey, role, stocks);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.feePayer = publicKey;
      tx.recentBlockhash = blockhash;
      const signature = await send(tx, connection);
      const r = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      if (r.value.err) throw new Error(`the signup failed on-chain: ${JSON.stringify(r.value.err)}`);
      setStatus({ kind: "done", signature });
      // The server re-reads the list every 20 seconds; show this signup now rather than wait for it.
      setView((v) => {
        if (!v) return v;
        const wallet = publicKey.toBase58();
        const signups = [{ wallet, role, stocks, signature, time: Math.floor(Date.now() / 1000) }, ...v.signups.filter((s) => s.wallet !== wallet)];
        // Whether this wallet bought test cover is the server's to say; keep its counts until the next read.
        return { ...tally(signups, new Set(), new Set()), tried: v.tried, testers: v.testers };
      });
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message });
    }
  }

  const busy = status?.kind === "busy";
  const label = !publicKey ? "Connect a wallet to join" : busy ? status.step : mine || status?.kind === "done" ? "Update my answer" : "Join the waitlist";

  return (
    <section className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-medium">Join the mainnet waitlist</h2>
        {view && (
          <span className="num text-sm text-muted">
            {view.count} {view.count === 1 ? "wallet" : "wallets"} on the list
          </span>
        )}
      </div>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Afterbell runs on test money today. Join to say you&apos;d use it with real money, and on which stocks. You sign one devnet transaction that
        sends nothing; the list lives on-chain, so anyone can count it. What you sign is public: your wallet address and the answers below,
        nothing else.
      </p>

      <fieldset className="mt-4">
        <legend className="text-sm text-muted">Which fits you best?</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {(Object.keys(ROLES) as Role[]).map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={role === r}
              onClick={() => setRole(r)}
              className={`rounded-lg border px-3 py-1.5 text-sm ${role === r ? "border-brass bg-raised text-text" : "border-line text-muted hover:text-text"}`}
            >
              {ROLES[r]}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-4">
        <legend className="text-sm text-muted">Stocks you&apos;d protect (up to {MAX_STOCKS})</legend>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {POPULAR.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={stocks.includes(s)}
              onClick={() => toggle(s)}
              className={`num rounded-md border px-2 py-1 text-xs ${stocks.includes(s) ? "border-brass bg-raised text-text" : "border-line text-muted hover:text-text"}`}
            >
              {s}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button onClick={join} disabled={busy} className="rounded-lg bg-brass px-4 py-2 text-sm font-medium text-ink hover:opacity-90 disabled:opacity-50">
          {label}
        </button>
        {mine && status?.kind !== "done" && <span className="text-sm text-muted">You&apos;re on the list.</span>}
        {status?.kind === "done" && (
          <span className="text-sm">
            You&apos;re on the list.{" "}
            <a className="underline" href={explorer("tx", status.signature)} target="_blank" rel="noreferrer">
              Your signup
            </a>
          </span>
        )}
        {status?.kind === "error" && <span className="text-sm text-loss">{status.text}</span>}
      </div>

      {view && (
        <p className="mt-5 border-t border-line pt-4 text-xs leading-relaxed text-faint">
          {view.wanted.length > 0 && <>Most asked for: {view.wanted.slice(0, 5).map((w) => `${w.symbol} (${w.count})`).join(", ")}. </>}
          {view.count > 0 && <>{view.tried} of them bought test cover first. </>}
          {view.testers > 0 && (
            <>
              {view.testers} outside {view.testers === 1 ? "wallet has" : "wallets have"} bought test cover since 2 October.{" "}
            </>
          )}
          <a className="underline" href={explorer("address", view.address)} target="_blank" rel="noreferrer">
            Every signup
          </a>
          {CONTACT_URL && (
            <>
              {" · "}
              <a className="underline" href={CONTACT_URL} target="_blank" rel="noreferrer">
                Want a message when it opens? Leave a contact (private)
              </a>
            </>
          )}
        </p>
      )}
    </section>
  );
}
