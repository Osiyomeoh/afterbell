"use client";

import { useCallback, useEffect, useState } from "react";

import { fetchMarket, fetchUnderwriter, type MarketResponse, type PoolState, type UnderwriterStake } from "@/lib/api";
import { claimPoolOnRobinhood, evmTxUrl, underwriteOnRobinhood, useEvmWallet, withdrawOnRobinhood } from "@/lib/evm";
import { nyTime, usd } from "@/lib/format";

type Status = { kind: "idle" } | { kind: "busy"; step: string } | { kind: "done"; text: string; url: string | null } | { kind: "error"; message: string };

const units = (v: number) => BigInt(Math.round(v * 1e6));
const shareCount = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 6 });

/** The Robinhood Chain pool: its round and limits, and anyone's stake in it, with deposits, withdrawals and claims. */
export function Pool({ pool }: { pool: PoolState }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-5 text-sm leading-relaxed">
      <h2 className="font-medium">Round {pool.round}</h2>
      <p className="mt-2 text-muted">
        {pool.roundOpenTs ? `Selling protection until the ${nyTime(pool.roundOpenTs)} open.` : "No sales yet; the round's first sale fixes the opening it sells."}{" "}
        The pool was worth {usd(pool.roundNav)} at its last roll. It can sell {usd(pool.room)} more in maximum payouts, and at most {usd(pool.perStock)} on any one stock: {pool.maxUtilizationBps / 100}% of
        the pool at its last roll, {pool.maxFeedBps / 100}% per stock. Whoever pays positions out earns {pool.keeperTipBps / 100}% of each premium.
      </p>
      {(pool.pendingDeposits > 0 || pool.pendingRedeemShares > 0) && (
        <p className="mt-2 text-muted">
          Waiting for the next roll: {usd(pool.pendingDeposits)} to deposit, {shareCount(pool.pendingRedeemShares)} shares to withdraw.
        </p>
      )}
      <Stake />
    </section>
  );
}

function Stake() {
  const evm = useEvmWallet();
  const [d, setD] = useState<MarketResponse["robinhood"]>(null);
  const [stake, setStake] = useState<UnderwriterStake | null>(null);
  const [deposit, setDeposit] = useState(1000);
  const [withdraw, setWithdraw] = useState(0);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  useEffect(() => {
    fetchMarket().then((m) => setD(m.robinhood), () => {});
  }, []);
  const load = useCallback(() => {
    if (evm.address) fetchUnderwriter(evm.address).then(setStake, (e: Error) => setStatus({ kind: "error", message: e.message }));
  }, [evm.address]);
  useEffect(load, [load]);

  async function run(what: string, act: (onStep: (step: string) => void) => Promise<`0x${string}` | `0x${string}`[]>) {
    if (!d || !evm.address) return;
    try {
      const out = await act((step) => setStatus({ kind: "busy", step }));
      const hash = Array.isArray(out) ? out[out.length - 1] : out;
      setStatus({ kind: "done", text: what, url: hash ? evmTxUrl(d, hash) : null });
      load();
    } catch (e) {
      const err = e as Error & { shortMessage?: string };
      setStatus({ kind: "error", message: err.shortMessage ?? err.message });
    }
  }

  if (!evm.address) {
    return (
      <div className="mt-4 border-t border-line pt-4">
        <p className="text-muted">Underwrite the pool: earn the premiums buyers pay, and pay what their protection pays.</p>
        <button onClick={() => evm.connect().catch((e: Error) => setStatus({ kind: "error", message: e.message }))} className="mt-3 rounded-xl bg-brass px-4 py-2.5 font-medium text-ink">
          Connect a wallet
        </button>
        {status.kind === "error" && <p className="mt-3 text-loss">{status.message}</p>}
      </div>
    );
  }
  const me = evm.address;
  const busy = status.kind === "busy" || !d;
  const claimable = stake && (stake.claimableShares > 0 || stake.claimableAssets > 0);
  return (
    <div className="mt-4 space-y-4 border-t border-line pt-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Figure label="Your shares" value={stake ? shareCount(stake.shares) : "…"} />
        <Figure label="Worth" value={stake ? usd(stake.value) : "…"} />
        <Figure label="Your TestUSD" value={stake ? usd(stake.testUsd) : "…"} />
      </div>
      {stake && (stake.pendingDeposit > 0 || stake.pendingRedeemShares > 0) && (
        <p className="text-muted">
          Yours waiting for the next roll: {usd(stake.pendingDeposit)} in, {shareCount(stake.pendingRedeemShares)} shares out.
        </p>
      )}
      {claimable && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-gain">
            The last roll filled {stake.claimableShares > 0 ? `${shareCount(stake.claimableShares)} shares for your ${usd(stake.claimableDeposit)}` : ""}
            {stake.claimableShares > 0 && stake.claimableAssets > 0 ? " and " : ""}
            {stake.claimableAssets > 0 ? `${usd(stake.claimableAssets)} for your ${shareCount(stake.claimableRedeemShares)} shares` : ""}.
          </span>
          <button disabled={busy} onClick={() => run("Claimed.", (s) => claimPoolOnRobinhood(me, d!, s))} className="rounded-lg border border-line px-3 py-1.5 hover:border-brass disabled:opacity-40">
            Claim
          </button>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-muted">Deposit TestUSD</span>
          <div className="mt-1.5 flex gap-2">
            <input type="number" min={1} step={100} value={deposit} onChange={(e) => setDeposit(Math.max(0, Number(e.target.value) || 0))} className="num w-full rounded-lg border border-line bg-ink px-3 py-2" />
            <button
              disabled={busy || deposit <= 0}
              onClick={() => run(`Asked to deposit ${usd(deposit)}. It joins the pool at the next roll.`, (s) => underwriteOnRobinhood(me, d!, units(deposit), s))}
              className="shrink-0 rounded-lg bg-brass px-3 py-2 font-medium text-ink disabled:opacity-40"
            >
              Deposit
            </button>
          </div>
        </label>
        <label className="block">
          <span className="text-muted">Withdraw shares</span>
          <div className="mt-1.5 flex gap-2">
            <input type="number" min={0} step={1} value={withdraw} onChange={(e) => setWithdraw(Math.max(0, Number(e.target.value) || 0))} className="num w-full rounded-lg border border-line bg-ink px-3 py-2" />
            <button type="button" onClick={() => stake && setWithdraw(stake.shares)} className="shrink-0 rounded-lg border border-line px-2 text-xs text-muted hover:text-text">
              Max
            </button>
            <button
              disabled={busy || withdraw <= 0 || !stake || withdraw > stake.shares}
              onClick={() => run(`Asked to withdraw ${shareCount(withdraw)} shares. They're paid out at the next roll.`, (s) => withdrawOnRobinhood(me, d!, units(withdraw), s))}
              className="shrink-0 rounded-lg border border-line px-3 py-2 hover:border-brass disabled:opacity-40"
            >
              Withdraw
            </button>
          </div>
        </label>
      </div>
      <p className="text-xs text-muted">
        Deposits and withdrawals wait for the pool&apos;s next roll, after the open, once every position is paid and the pool&apos;s value is exact, so
        nobody can join after seeing the night&apos;s price or leave before paying for it. TestUSD has no value.
      </p>
      {status.kind === "busy" && <p className="text-muted">{status.step}…</p>}
      {status.kind === "error" && <p className="text-loss">{status.message}</p>}
      {status.kind === "done" && (
        <p className="text-gain">
          {status.text}{" "}
          {status.url && (
            <a className="underline" href={status.url} target="_blank" rel="noreferrer">
              View transaction
            </a>
          )}
        </p>
      )}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted">{label}</div>
      <div className="num mt-0.5 text-lg font-semibold">{value}</div>
    </div>
  );
}
