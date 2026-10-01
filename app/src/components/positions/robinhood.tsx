"use client";

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";

import type { HolderOrder } from "@root/evm/client/renewer";

import { fetchPositions, type MarketResponse, type PositionRow } from "@/lib/api";
import { claimOnRobinhood, evmTxUrl, standingOrders, stopEveryNight, useEvmWallet } from "@/lib/evm";
import { nyTime, usd } from "@/lib/format";

import { type Claimed, Connect, PositionsTable } from "./shared";

export function RobinhoodPositions({ d }: { d: NonNullable<MarketResponse["robinhood"]> }) {
  const evm = useEvmWallet();
  const [rows, setRows] = useState<PositionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<Claimed[]>([]);

  const load = useCallback(() => {
    if (!evm.address) return;
    fetchPositions(evm.address).then((r) => setRows(r.positions), (e: Error) => setError(e.message));
  }, [evm.address]);
  useEffect(load, [load]);

  if (!evm.address) {
    return (
      <Connect onClick={() => evm.connect().catch((e: Error) => setError(e.message))} error={error}>
        Connect the EVM wallet you bought protection with.
      </Connect>
    );
  }

  async function claim(p: PositionRow) {
    if (!evm.address) return;
    try {
      setClaiming(p.address);
      const hash = await claimOnRobinhood(evm.address, d, BigInt(p.address));
      setClaimed((c) => [...c, { key: p.address, url: evmTxUrl(d, hash) }]);
      load();
    } catch (e) {
      const err = e as Error & { shortMessage?: string };
      setError(err.shortMessage ?? err.message);
    } finally {
      setClaiming(null);
    }
  }
  return (
    <>
      <PositionsTable chain="robinhood" rows={rows} error={error} claiming={claiming} claimed={claimed} onClaim={claim} />
      {d.renewer && <StandingOrders d={{ ...d, renewer: d.renewer }} holder={evm.address} />}
    </>
  );
}

/** The wallet's standing orders ("protect every night"), each with a way to stop it. */
function StandingOrders({ d, holder }: { d: NonNullable<MarketResponse["robinhood"]> & { renewer: Address }; holder: Address }) {
  const [orders, setOrders] = useState<HolderOrder[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    standingOrders(d, holder).then(setOrders, (e: Error) => setError(e.message));
  }, [d, holder]);
  useEffect(load, [load]);

  const symbolOf = (feed: Address) => Object.entries(d.feeds).find(([, a]) => a?.toLowerCase() === feed.toLowerCase())?.[0] ?? feed.slice(0, 10);
  async function stop(feed: Address) {
    try {
      setBusy(feed);
      await stopEveryNight(holder, d, feed);
      load();
    } catch (e) {
      const err = e as Error & { shortMessage?: string };
      setError(err.shortMessage ?? err.message);
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
          <li key={o.feed} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
            <span>
              {Number(o.maxShares) / 1e6} {symbolOf(o.feed)}, {o.startBps / 100}% to {o.depthBps / 100}% below the price, at most{" "}
              <span className="num">{usd(Number(o.maxPremium) / 1e6)}</span> a night, until {nyTime(Number(o.until))}
            </span>
            <button onClick={() => stop(o.feed)} disabled={busy === o.feed} className="rounded-lg border border-line px-2.5 py-1 text-xs hover:border-loss disabled:opacity-40">
              {busy === o.feed ? "Stopping…" : "Stop"}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-loss">{error}</p>}
    </div>
  );
}
