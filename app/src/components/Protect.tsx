"use client";

import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useEffect, useMemo, useState } from "react";

import { backtest } from "@root/pricing/backtest";
import { priceQuote } from "@root/quoter/quoter";

import { fetchMarket, requestQuote, toMarket, type MarketResponse } from "@/lib/api";
import { buyProtection, NotEnoughTestUsd } from "@/lib/buy";
import { countdown, explorer, nyTime, pct, usd } from "@/lib/format";

import { PayoffChart } from "./PayoffChart";

const round2 = (v: number) => Math.round(v * 100) / 100;

const BASIS: Record<string, string> = {
  live: "the live price",
  close: "the last close",
  "live, below the close": "the live price, which is below the last close",
};

type Status =
  | { kind: "idle" }
  | { kind: "busy"; step: string }
  | { kind: "done"; signature: string; premium: number; openTs: number }
  | { kind: "error"; message: string; needsFunds?: boolean };

export function Protect() {
  const [market, setMarket] = useState<MarketResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [shares, setShares] = useState(10);
  const [start, setStart] = useState(0.02);
  const [depth, setDepth] = useState(0.1);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { sendTransaction } = useWallet();
  const { setVisible } = useWalletModal();

  useEffect(() => {
    const load = () => fetchMarket().then(setMarket, (e: Error) => setLoadError(e.message));
    load();
    const refresh = setInterval(load, 30_000);
    const tick = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => {
      clearInterval(refresh);
      clearInterval(tick);
    };
  }, []);

  const reference = market?.reference?.price ?? null;
  const protection = reference
    ? { shares, upper: round2(reference * (1 - start)), lower: round2(reference * (1 - Math.max(depth, start + 0.01))) }
    : null;

  // The same pricing the quote service signs, run here so the ticket updates as you drag.
  const preview = useMemo(() => {
    if (!market || !protection) return null;
    try {
      return { priced: priceQuote(now, toMarket(market), protection, market.config) };
    } catch (e) {
      return { error: (e as Error).message };
    }
    // `now` moves every second; the price only needs the minute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, protection?.shares, protection?.upper, protection?.lower, Math.floor(now / 60)]);

  const record = useMemo(() => {
    if (!market) return null;
    return backtest(market.history, { deductible: start, depth: Math.max(depth, start + 0.01) }, { shares: 1, annualVol: market.annualVol, margin: market.config.margin });
  }, [market, start, depth]);

  async function buy() {
    if (!wallet || !protection) return setVisible(true);
    try {
      setStatus({ kind: "busy", step: "Getting a signed quote" });
      const q = await requestQuote({ buyer: wallet.publicKey.toBase58(), ...protection });
      setStatus({ kind: "busy", step: "Confirm in your wallet" });
      const { signature } = await buyProtection(connection, wallet, sendTransaction, q.solana);
      setStatus({ kind: "done", signature, premium: q.priced.premium, openTs: q.priced.openTs });
    } catch (e) {
      setStatus({ kind: "error", message: (e as Error).message, needsFunds: e instanceof NotEnoughTestUsd });
    }
  }

  if (loadError) return <Notice>Market data is unavailable: {loadError}</Notice>;
  if (!market) return <Notice>Loading TSLA…</Notice>;

  const priced = preview && "priced" in preview ? preview.priced : null;
  const blocked = market.paused ?? (preview && "error" in preview ? preview.error : null);
  const openTs = priced?.openTs ?? market.nextOpen;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <section className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-medium">Protect TSLA until {nyTime(openTs)}</h2>
          <span className="num text-sm text-muted">opens in {countdown(openTs - now)}</span>
        </div>

        <div className="mt-5 grid gap-5 sm:grid-cols-3">
          <label className="block">
            <span className="text-sm text-muted">Shares</span>
            <input
              type="number"
              min={0.01}
              step={1}
              value={shares}
              onChange={(e) => setShares(Math.max(0.01, Number(e.target.value) || 0.01))}
              className="num mt-1.5 w-full rounded-lg border border-line bg-ink px-3 py-2 text-lg"
            />
          </label>
          <Slider label="Protection starts" value={start} min={0} max={0.1} step={0.005} onChange={setStart} price={protection?.upper} />
          <Slider label="Protection stops" value={Math.max(depth, start + 0.01)} min={start + 0.01} max={0.3} step={0.01} onChange={setDepth} price={protection?.lower} />
        </div>

        {protection && priced && (
          <div className="mt-6">
            <PayoffChart shares={shares} upper={protection.upper} lower={protection.lower} premium={priced.premium} reference={priced.reference.price} />
            <p className="mt-3 text-sm leading-relaxed text-muted">
              If TSLA opens below <span className="num text-text">{usd(protection.upper)}</span>, the vault pays{" "}
              <span className="num text-text">{usd(shares)}</span> for every dollar below it, up to{" "}
              <span className="num text-text">{usd(priced.maxPayout)}</span> at <span className="num text-text">{usd(protection.lower)}</span> or lower. Settled
              by the first Pyth price at or after 09:30 ET.
            </p>
          </div>
        )}
      </section>

      <aside className="flex flex-col gap-4">
        <div className="rounded-2xl border border-line bg-surface p-5">
          <div className="text-sm text-muted">You pay</div>
          <div className="num mt-1 text-3xl font-semibold">{priced ? usd(priced.premium) : "—"}</div>
          <dl className="mt-4 space-y-2 text-sm">
            <Row label="Pays up to" value={priced ? usd(priced.maxPayout) : "—"} />
            <Row label="Chance it pays" value={priced ? pct(priced.probabilityOfPayout) : "—"} />
            <Row label="Priced from" value={priced ? usd(priced.reference.price) : "—"} />
          </dl>
          {priced && <p className="mt-1 text-right text-xs text-faint">{BASIS[priced.reference.basis]}</p>}
          <button
            onClick={buy}
            disabled={!!blocked || status.kind === "busy"}
            className="mt-5 w-full rounded-xl bg-brass px-4 py-3 font-medium text-ink transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {status.kind === "busy" ? status.step : !wallet ? "Connect a wallet" : priced ? `Protect for ${usd(priced.premium)}` : "Protect"}
          </button>
          {blocked && <p className="mt-3 text-sm text-loss">{blocked}</p>}
          {status.kind === "error" && (
            <p className="mt-3 text-sm text-loss">
              {status.message}
              {status.needsFunds && " Get some from the faucet (coming next) or ask the team."}
            </p>
          )}
          {status.kind === "done" && (
            <p className="mt-3 text-sm text-gain">
              Protected for {usd(status.premium)}. It settles {nyTime(status.openTs)}.{" "}
              <a className="underline" href={explorer("tx", status.signature)} target="_blank" rel="noreferrer">
                View transaction
              </a>
            </p>
          )}
        </div>

        <div className="rounded-2xl border border-line bg-surface p-5 text-sm">
          <div className="text-muted">TSLA</div>
          <dl className="mt-2 space-y-2">
            <Row label={`Close, ${nyTime(market.closeTs)}${market.closeSource === "hyperliquid" ? " (Hyperliquid)" : ""}`} value={usd(market.close)} />
            {market.live !== null && <Row label={market.liveSource === "pyth" ? "Now (Pyth)" : "Now (Hyperliquid)"} value={usd(market.live)} />}
          </dl>
          {record && (
            <p className="mt-4 leading-relaxed text-muted">
              Replayed on {record.nights.length} past TSLA openings, each priced only from the ones before it, this protection paid back{" "}
              <span className="num text-text">{Math.round(record.paidPerDollar * 100)}¢</span> per $1 of premium and paid out on{" "}
              {record.paidNights} of them.
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}

function Slider(props: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; price?: number }) {
  return (
    <label className="block">
      <span className="text-sm text-muted">{props.label}</span>
      <div className="mt-1.5 flex items-baseline justify-between">
        <span className="num text-lg">{pct(props.value, 1)} below</span>
        {props.price !== undefined && <span className="num text-sm text-muted">{usd(props.price)}</span>}
      </div>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="mt-2 w-full"
      />
    </label>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="num text-right">{value}</dd>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-line bg-surface p-6 text-muted">{children}</div>;
}
