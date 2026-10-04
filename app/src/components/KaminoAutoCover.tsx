"use client";

import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useCallback, useEffect, useState } from "react";

import { requestQuote } from "@/lib/api";
import { protectEveryNightOnSolana, solanaStandingOrders, stopEveryNightOnSolana, type SolanaStandingOrder } from "@/lib/buy";
import { NIGHT_OPTIONS, standingOrder } from "@/lib/everyNight";
import { pct, usd } from "@/lib/format";
import type { CoverLine } from "@/lib/kaminoCover";
import { useSendTransaction } from "@/lib/send";
import type { LoanCover } from "@/server/kaminoCover";

/** The most shares one quote can carry; a bigger line is left for the holder to split. */
const MAX_SHARES_PER_QUOTE = 1000;

type Covers = { wallet: string; covers: LoanCover[]; readAt: number };
type Where = { vault: string; collateralMint: string; sells: string[] };

const errorMessage = (e: unknown) => (e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? String(e);

/**
 * The opt-in for Kamino auto-cover: the connected wallet's own loans, the cover each needs and its
 * price tonight, and a standing order per stock that the keeper renews each night within a cap.
 * Only the connected wallet is read; there is no field to look up anyone else's.
 */
export function KaminoAutoCover({ vault }: { vault: Where | null }) {
  const wallet = useAnchorWallet();
  const { connection } = useConnection();
  const { setVisible } = useWalletModal();
  const send = useSendTransaction();

  const [data, setData] = useState<Covers | { error: string } | null>(null);
  const [orders, setOrders] = useState<SolanaStandingOrder[]>([]);
  const [where, setWhere] = useState<Where | null>(vault);
  const [nights, setNights] = useState<number>(NIGHT_OPTIONS[0]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sample, setSample] = useState(false);

  const owner = wallet?.publicKey.toBase58();

  const refreshOrders = useCallback(
    async (vault: string) => {
      if (!wallet) return;
      setOrders(await solanaStandingOrders(connection, wallet, vault).catch(() => []));
    },
    [connection, wallet],
  );

  useEffect(() => {
    if (!owner) return setData(null);
    let live = true;
    setData(null);
    fetch(sample ? "/api/kamino/cover?sample=1" : `/api/kamino/cover?wallet=${owner}`, { cache: "no-store" })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? `request failed (${r.status})`);
        return body as Covers;
      })
      .then((d) => live && setData(d))
      .catch((e) => live && setData({ error: errorMessage(e) }));
    return () => {
      live = false;
    };
  }, [owner, sample]);

  useEffect(() => {
    if (where) refreshOrders(where.vault);
  }, [where, refreshOrders]);

  /** Quotes each line tonight and sets its standing order; lines past one quote's size are skipped and said so. */
  async function setOrdersFor(cover: LoanCover) {
    if (!wallet || cover.plan.action !== "cover") return;
    setBusy(true);
    const done: string[] = [];
    const skipped: string[] = [];
    try {
      for (const line of cover.plan.lines) {
        if (vault && !vault.sells.includes(line.symbol)) {
          skipped.push(`${line.symbol} (the Solana vault doesn't sell it yet)`);
          continue;
        }
        const shares = sharesFor(line, cover);
        if (!shares) {
          skipped.push(`${line.symbol} (no price)`);
          continue;
        }
        if (shares > MAX_SHARES_PER_QUOTE) {
          skipped.push(`${line.symbol} (${shares} shares, over ${MAX_SHARES_PER_QUOTE} per order)`);
          continue;
        }
        setStatus(`Quoting ${line.symbol}…`);
        const ref = cover.quote?.lines.find((l) => l.symbol === line.symbol)?.reference.price ?? 0;
        const start = line.startBps / 10_000;
        const stop = (line.startBps + line.depthBps) / 10_000;
        const q = await requestQuote({
          symbol: line.symbol,
          buyer: owner!,
          shares,
          upper: Math.round(ref * (1 - start) * 100) / 100,
          lower: Math.round(ref * (1 - stop) * 100) / 100,
        });
        const { order, allowance } = standingOrder({ shares, start, depth: stop, premium: q.priced.premium, openTs: q.priced.openTs, nights });
        setStatus(`Approve ${line.symbol}'s standing order in your wallet…`);
        await protectEveryNightOnSolana(connection, wallet, send, q.solana, { ...order, allowance });
        setWhere((w) => ({ vault: q.solana.vault, collateralMint: q.solana.collateralMint, sells: w?.sells ?? [] }));
        done.push(line.symbol);
      }
      setStatus(
        [done.length ? `Standing orders set on ${done.join(", ")} for ${nights} nights.` : null, skipped.length ? `Skipped: ${skipped.join("; ")}.` : null]
          .filter(Boolean)
          .join(" ") || null,
      );
    } catch (e) {
      setStatus(`${done.length ? `Set on ${done.join(", ")}, then: ` : ""}${errorMessage(e)}`);
    } finally {
      setBusy(false);
      if (where) refreshOrders(where.vault);
    }
  }

  async function stop(o: SolanaStandingOrder) {
    if (!wallet || !where) return;
    setBusy(true);
    try {
      setStatus(`Stopping ${o.symbol}…`);
      await stopEveryNightOnSolana(connection, wallet, send, where, o.feedId);
      setStatus(`Stopped ${o.symbol}.`);
    } catch (e) {
      setStatus(errorMessage(e));
    } finally {
      setBusy(false);
      refreshOrders(where.vault);
    }
  }

  return (
    <section id="cover" className="mt-10 scroll-mt-6 rounded-2xl border border-line bg-surface p-5">
      <h2 className="font-medium">Auto-cover your own loans</h2>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Connect the wallet that holds the loan. Each loan backed by stocks gets cover that starts paying at the opening that makes it liquidatable,
        sized to repay what that opening pushes over the limit. A standing order buys it again each night, within a cap you set.
      </p>

      {!wallet ? (
        <button className="mt-4 rounded-lg bg-brass px-4 py-2 text-sm font-medium text-ink" onClick={() => setVisible(true)}>
          Connect a wallet
        </button>
      ) : !data ? (
        <p className="mt-4 text-sm text-muted">Reading your loans…</p>
      ) : "error" in data ? (
        <p className="mt-4 text-sm text-muted">Couldn&apos;t read your loans: {data.error}</p>
      ) : data.covers.length === 0 ? (
        <div className="mt-4 text-sm text-muted">
          <p>This wallet has no Kamino loans.</p>
          <button className="mt-2 text-brass hover:underline" onClick={() => setSample(true)}>
            Try it on a sample loan →
          </button>
        </div>
      ) : (
        <>
          {sample && (
            <p className="mt-4 text-sm text-muted">
              A made-up loan, not read from Kamino: $3,000 of TSLA and $2,000 of QQQ, $3,150 borrowed. The orders it sets are real, on devnet test
              money, in your wallet.{" "}
              <button className="text-brass hover:underline" onClick={() => setSample(false)}>
                Back to your loans
              </button>
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Run for</span>
            {NIGHT_OPTIONS.map((n) => (
              <button
                key={n}
                className={`rounded-lg border px-3 py-1 ${n === nights ? "border-brass text-brass" : "border-line text-muted"}`}
                onClick={() => setNights(n)}
              >
                {n} nights
              </button>
            ))}
            <span className="text-faint">The nightly cap is 1.5× tonight&apos;s price.</span>
          </div>
          <ul className="mt-4 space-y-4">
            {data.covers.map((c) => (
              <li key={c.obligation} className="rounded-xl border border-line p-4">
                <p className="text-sm font-medium">{c.marketName}</p>
                {c.plan.action === "skip" ? (
                  <p className="mt-1 text-sm text-muted">No cover: {c.plan.reason}</p>
                ) : (
                  <>
                    <p className="mt-1 text-sm text-muted">
                      Liquidatable if every stock opens <span className="num text-text">{pct(c.plan.gap)}</span> down.
                      {c.quote && (
                        <>
                          {" "}
                          Tonight: <span className="num text-text">{usd(c.quote.totals.premium)}</span> for up to{" "}
                          <span className="num text-text">{usd(c.quote.totals.maxPayout)}</span>.
                        </>
                      )}
                    </p>
                    <ul className="mt-2 text-sm">
                      {c.plan.lines.map((l) => (
                        <li key={l.symbol} className="num text-muted">
                          {l.symbol}: {usd(l.notionalUsd)} of stock, pays from {pct(l.startBps / 10_000)} to {pct((l.startBps + l.depthBps) / 10_000)} down
                          {sharesFor(l, c) ? ` (${sharesFor(l, c)} shares)` : ""}
                        </li>
                      ))}
                    </ul>
                    <button
                      className="mt-3 rounded-lg bg-brass px-4 py-2 text-sm font-medium text-ink disabled:opacity-50"
                      disabled={busy || !c.quote}
                      onClick={() => setOrdersFor(c)}
                    >
                      Set standing order
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {status && <p className="mt-3 text-sm text-brass">{status}</p>}

      {orders.length > 0 && (
        <div className="mt-5">
          <h3 className="text-sm font-medium">Your standing orders</h3>
          <ul className="mt-2 divide-y divide-line text-sm">
            {orders.map((o) => (
              <li key={o.symbol} className="flex items-center justify-between gap-4 py-2">
                <span className="num text-muted">
                  {o.symbol}: {o.maxShares} shares, {pct(o.startBps / 10_000)}–{pct(o.depthBps / 10_000)} down, up to {usd(o.maxPremium)} a night, until{" "}
                  {new Date(o.until * 1000).toLocaleDateString()}
                </span>
                <button className="text-brass hover:underline disabled:opacity-50" disabled={busy} onClick={() => stop(o)}>
                  Stop
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-4 text-xs text-faint">
        Orders keep tonight&apos;s size. Re-sizing them to the loan each night (a sizer you name, within your bounds) comes with the next devnet program
        upgrade. The payout goes to your wallet; repaying the loan with it in the same transaction is still to build.
      </p>
    </section>
  );
}

/** Whole shares for a cover line, at the gap report's reference price. */
function sharesFor(line: CoverLine, cover: LoanCover): number {
  const ref = cover.quote?.lines.find((l) => l.symbol === line.symbol)?.reference.price;
  return ref ? Math.ceil(line.notionalUsd / ref) : 0;
}
