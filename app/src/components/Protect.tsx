"use client";

import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { backtest, type BacktestNight, type BacktestResult } from "@root/pricing/backtest";
import { priceQuote } from "@root/quoter/quoter";

import { fetchHoldings, fetchMarket, requestEvmQuote, requestQuote, toMarket, type Chain, type MarketResponse, type PriceSource } from "@/lib/api";
import { buyProtection, NotEnoughTestUsd } from "@/lib/buy";
import { buyOnRobinhood, evmTxUrl, NeedsGas, useEvmWallet } from "@/lib/evm";
import { nextEvent } from "@/lib/events";
import { countdown, dayLabel, explorer, nyTime, pct, usd } from "@/lib/format";

import { PayoffChart } from "./PayoffChart";
import { TestFunds } from "./TestFunds";

const round2 = (v: number) => Math.round(v * 100) / 100;

const BASIS: Record<string, string> = {
  live: "the live price",
  close: "the last close",
  "live, below the close": "the live price, which is below the last close",
};

type Status =
  | { kind: "idle" }
  | { kind: "busy"; step: string }
  | { kind: "done"; premium: number; openTs: number; url: string | null; nft?: { number: string; art: string } }
  | { kind: "error"; message: string; needsFunds?: boolean };

const CHAINS: { id: Chain; label: string }[] = [
  { id: "solana", label: "Solana devnet" },
  { id: "robinhood", label: "Robinhood Chain" },
];

const SETTLED_BY: Record<Chain, (symbol: string) => string> = {
  solana: () => "Settled by the first Pyth price at or after 09:30 ET.",
  robinhood: (symbol) => `Settled by Chainlink's ${symbol} price in force at 09:30 ET.`,
};

const SOURCE: Record<PriceSource, string> = { pyth: "Pyth", chainlink: "Chainlink", hyperliquid: "Hyperliquid" };

/** Why a chain can't sell this stock right now, or null if it can. */
function unavailableOn(chain: Chain, m: MarketResponse): string | null {
  const listing = m.stocks.find((s) => s.symbol === m.symbol);
  if (chain === "solana") {
    if (!m.solana) return "The Solana vault v2 isn't deployed yet.";
    if (m.solana.selling) return null;
    if (listing?.settles.includes("solana")) return `The Solana vault doesn't take ${m.symbol} yet.`;
    const pyth = m.stocks.filter((s) => s.settles.includes("solana")).map((s) => s.symbol);
    return `Solana settles on Pyth prices, which the quote service can read for ${pyth.join(" and ") || "no stock"} only. ${m.symbol} settles on Robinhood Chain.`;
  }
  const rh = m.robinhood;
  if (!rh) return "The Robinhood Chain vault isn't deployed yet.";
  if (!rh.feeds[m.symbol]) return `The Robinhood Chain vault doesn't take ${m.symbol} yet.`;
  if (!rh.selling) return "Robinhood Chain sales open once the quote service has its key.";
  return null;
}

export function Protect() {
  const [market, setMarket] = useState<MarketResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [shares, setShares] = useState(10);
  const [start, setStart] = useState(0.02);
  const [depth, setDepth] = useState(0.1);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [chain, setChain] = useState<Chain>("solana");
  const [symbol, setSymbol] = useState("TSLA");
  const evm = useEvmWallet();

  // A link can open the ticket on a chain, a stock and a size: /?chain=robinhood&symbol=NVDA&shares=40.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("chain") === "robinhood") setChain("robinhood");
    const s = q.get("symbol");
    if (s && /^[A-Za-z.]{1,10}$/.test(s)) setSymbol(s.toUpperCase());
    const n = Number(q.get("shares"));
    if (n > 0) setShares(Math.max(0.01, Math.min(n, market?.config.maxShares ?? 1_000)));
    // Read once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pickStock(next: string) {
    setSymbol(next);
    setStatus({ kind: "idle" });
    const url = new URL(window.location.href);
    if (next === "TSLA") url.searchParams.delete("symbol");
    else url.searchParams.set("symbol", next);
    window.history.replaceState(null, "", url);
  }

  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { sendTransaction } = useWallet();
  const { setVisible } = useWalletModal();
  const [holdings, setHoldings] = useState<{ symbol: string; shares: number }[]>([]);

  // Tokenized TSLA the wallet holds on mainnet, so protection can match it exactly.
  useEffect(() => {
    if (!wallet) return setHoldings([]);
    fetchHoldings(wallet.publicKey.toBase58()).then((r) => setHoldings(r.holdings), () => setHoldings([]));
  }, [wallet]);
  const held = Math.round(holdings.reduce((a, h) => a + h.shares, 0) * 10_000) / 10_000;

  useEffect(() => {
    let current = true;
    let first = true;
    setLoadError(null);
    const load = () =>
      fetchMarket(symbol).then(
        (m) => {
          if (!current) return;
          // A stock only one chain can settle opens on that chain, whether picked here or named in a link.
          const settles = m.stocks.find((s) => s.symbol === m.symbol)?.settles ?? [];
          if (first && settles.length) setChain((c) => (settles.includes(c) ? c : settles[0]!));
          first = false;
          setMarket(m);
          setLoadError(null);
        },
        (e: Error) => current && setLoadError(e.message),
      );
    load();
    const refresh = setInterval(load, 30_000);
    const tick = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => {
      current = false;
      clearInterval(refresh);
      clearInterval(tick);
    };
  }, [symbol]);

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
    if (!protection) return;
    if (chain === "robinhood") return buyOnEvm();
    if (!wallet) return setVisible(true);
    try {
      setStatus({ kind: "busy", step: "Getting a signed quote" });
      const q = await requestQuote({ symbol, buyer: wallet.publicKey.toBase58(), ...protection });
      setStatus({ kind: "busy", step: "Confirm in your wallet" });
      const { signature, position, number } = await buyProtection(connection, wallet, sendTransaction, q.solana);
      const nft = { number: number.toString(), art: `/api/position-art/solana/${position}/image` };
      setStatus({ kind: "done", premium: q.priced.premium, openTs: q.priced.openTs, url: explorer("tx", signature), nft });
    } catch (e) {
      setStatus({ kind: "error", message: (e as Error).message, needsFunds: e instanceof NotEnoughTestUsd });
    }
  }

  async function buyOnEvm() {
    const d = market?.robinhood;
    if (!d || !protection) return;
    try {
      const buyer = evm.address ?? (await evm.connect());
      setStatus({ kind: "busy", step: "Getting a signed quote" });
      const q = await requestEvmQuote({ symbol, buyer, ...protection });
      const { id, hash } = await buyOnRobinhood(buyer, d, q, (step) => setStatus({ kind: "busy", step }));
      setStatus({ kind: "done", premium: q.priced.premium, openTs: q.priced.openTs, url: evmTxUrl(d, hash), nft: { number: id.toString(), art: `/api/position-art/${id}` } });
    } catch (e) {
      const err = e as Error & { shortMessage?: string };
      setStatus({ kind: "error", message: err.shortMessage ?? err.message, needsFunds: e instanceof NeedsGas });
    }
  }

  if (loadError) return <Notice>Market data for {symbol} is unavailable: {loadError}</Notice>;
  if (!market) return <Notice>Loading {symbol}…</Notice>;
  // Still showing the last stock while the one just picked loads.
  const loading = market.symbol !== symbol;

  const priced = preview && "priced" in preview ? preview.priced : null;
  const blocked = (loading ? `Loading ${symbol}…` : null) ?? unavailableOn(chain, market) ?? market.paused ?? (preview && "error" in preview ? preview.error : null);
  const openTs = priced?.openTs ?? market.nextOpen;
  const connected = chain === "solana" ? !!wallet : !!evm.address;

  // The price and the buy button: beside the ticket on wide screens, inside it (under the sliders) on phones,
  // where the aside only starts below the whole ticket.
  const checkout = (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-sm text-muted">You pay</div>
          <div className="num mt-1 text-3xl font-semibold">{priced ? usd(priced.premium) : "—"}</div>
        </div>
        <div className="text-right">
          <div className="text-sm text-muted">Pays up to</div>
          <div className="num mt-1 text-3xl font-semibold text-gain">{priced ? usd(priced.maxPayout, 0) : "—"}</div>
        </div>
      </div>
      {priced && priced.premium > 0 && (
        <p className="mt-2 text-sm text-muted">
          Up to <span className="num text-text">{multiple(priced.maxPayout / priced.premium)}</span> what you pay, with a{" "}
          <span className="num text-text">{pct(priced.probabilityOfPayout)}</span> chance it pays anything.
        </p>
      )}
      <dl className="mt-4 space-y-2 text-sm">
        <Row label="Priced from" value={priced ? usd(priced.reference.price) : "—"} />
      </dl>
      {priced && <p className="mt-1 text-right text-xs text-faint">{BASIS[priced.reference.basis]}</p>}
      <button
        onClick={buy}
        disabled={!!blocked || status.kind === "busy"}
        className="mt-5 w-full rounded-xl bg-brass px-4 py-3 font-medium text-ink transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {status.kind === "busy"
          ? status.step
          : !connected
            ? chain === "solana"
              ? "Connect a wallet"
              : "Connect an EVM wallet"
            : priced ? `Protect for ${usd(priced.premium)}` : "Protect"}
      </button>
      {blocked && <p className="mt-3 text-sm text-loss">{blocked}</p>}
      {status.kind === "error" && (
        <p className="mt-3 text-sm text-loss">
          {status.message}
          {status.needsFunds && chain === "solana" && " Use “Get test money” below."}
        </p>
      )}
      {status.kind === "done" && (
        <p className="mt-3 text-sm text-gain">
          Protected for {usd(status.premium)}. It settles {nyTime(status.openTs)}.{" "}
          {status.url && (
            <a className="underline" href={status.url} target="_blank" rel="noreferrer">
              View transaction
            </a>
          )}
        </p>
      )}
      {status.kind === "done" && status.nft && (
        <a className="mt-3 block w-40" href={status.nft.art} target="_blank" rel="noreferrer">
          <img src={status.nft.art} alt={`Your protection, NFT #${status.nft.number}`} className="rounded-lg border border-line" />
          <span className="mt-1 block text-xs text-muted">NFT #{status.nft.number}: whoever holds it is paid</span>
        </a>
      )}
    </>
  );

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <section className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-lg border border-line bg-ink p-0.5 text-sm" role="tablist" aria-label="Chain">
            {CHAINS.map((c) => (
              <button
                key={c.id}
                role="tab"
                aria-selected={chain === c.id}
                onClick={() => {
                  setChain(c.id);
                  setStatus({ kind: "idle" });
                }}
                className={`rounded-md px-3 py-1.5 ${chain === c.id ? "bg-raised text-text" : "text-muted hover:text-text"}`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">Stock</span>
            <select
              value={symbol}
              onChange={(e) => pickStock(e.target.value)}
              className="num rounded-lg border border-line bg-ink px-2.5 py-1.5 text-text"
            >
              {market.stocks.map((s) => (
                <option key={s.symbol} value={s.symbol}>
                  {s.symbol} · {s.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-medium">Protect {market.symbol} until {nyTime(openTs)}</h2>
          <span className="num text-sm text-muted">opens in {countdown(openTs - now)}</span>
        </div>
        <EventNote symbol={market.symbol} now={now} openTs={openTs} />

        <div className="mt-5 flex flex-wrap gap-2" role="group" aria-label="Protection presets">
          {PRESETS.map((p) => {
            const on = Math.abs(start - p.start) < 1e-9 && Math.abs(depth - p.depth) < 1e-9;
            return (
              <button
                key={p.label}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  setStart(p.start);
                  setDepth(p.depth);
                }}
                className={`rounded-lg border px-3 py-1.5 text-left text-sm ${on ? "border-brass bg-raised text-text" : "border-line text-muted hover:text-text"}`}
              >
                <span className="block">{p.label}</span>
                <span className="num block text-xs text-faint">
                  {pct(p.start, 0)} to {pct(p.depth, 0)} below
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-5 grid gap-5 sm:grid-cols-[8rem_1fr_1fr]">
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
            {chain === "solana" && market.symbol === "TSLA" && held > 0 && (
              <button type="button" onClick={() => setShares(held)} className="mt-1.5 text-xs text-brass hover:underline">
                You hold {held} ({holdings.map((h) => h.symbol).join(" + ")}). Protect all
              </button>
            )}
          </label>
          <Slider label="Protection starts" value={start} min={0} max={0.1} step={0.005} onChange={setStart} price={protection?.upper} />
          <Slider label="Protection stops" value={Math.max(depth, start + 0.01)} min={start + 0.01} max={0.3} step={0.01} onChange={setDepth} price={protection?.lower} />
        </div>

        <div className="mt-6 rounded-xl border border-line bg-ink p-4 lg:hidden">{checkout}</div>

        {protection && priced && (
          <div className="mt-6">
            <PayoffChart shares={shares} upper={protection.upper} lower={protection.lower} premium={priced.premium} reference={priced.reference.price} />
            <p className="mt-3 text-sm leading-relaxed text-muted">
              If {market.symbol} opens below <span className="num text-text">{usd(protection.upper)}</span>, the vault pays{" "}
              <span className="num text-text">{usd(shares)}</span> for every dollar below it, up to{" "}
              <span className="num text-text">{usd(priced.maxPayout)}</span> at <span className="num text-text">{usd(protection.lower)}</span> or lower. It
              pays more than it costs if {market.symbol} opens below <span className="num text-text">{usd(protection.upper - priced.premium / shares)}</span>.{" "}
              {SETTLED_BY[chain](market.symbol)}
            </p>
          </div>
        )}
      </section>

      <aside className="flex flex-col gap-4">
        <div className="hidden rounded-2xl border border-line bg-surface p-5 lg:block">{checkout}</div>

        {chain === "solana" ? (
          market.solana && <TestFunds mint={market.solana.collateralMint} refreshKey={status.kind} />
        ) : (
          <div className="rounded-2xl border border-line bg-surface p-5 text-sm leading-relaxed text-muted">
            <div className="text-text">Test money on Robinhood Chain</div>
            <p className="mt-2">
              The vault takes TestUSD, a token with no value that anyone can mint; if you have too little, you mint 1,000 as part of buying. Gas is
              paid in ETH on Robinhood Chain, about $0.05 a purchase.
            </p>
            {evm.address && (
              <p className="num mt-2 text-xs text-faint">
                {evm.address.slice(0, 6)}…{evm.address.slice(-4)}
              </p>
            )}
          </div>
        )}

        <div className="rounded-2xl border border-line bg-surface p-5 text-sm">
          <div className="text-muted">
            {market.symbol} · {market.name}
          </div>
          <dl className="mt-2 space-y-2">
            <Row label={`Close, ${nyTime(market.closeTs)} (${SOURCE[market.closeSource]})`} value={usd(market.close)} />
            {market.live !== null && <Row label={`Now (${SOURCE[market.liveSource]})`} value={usd(market.live)} />}
          </dl>
          {record && <Replay record={record} symbol={market.symbol} shares={shares} oracle={SOURCE[market.closeSource === "chainlink" ? "chainlink" : "pyth"]} />}
        </div>
      </aside>
    </div>
  );
}

/** A scheduled event on this stock: covered by this protection, or by protection on sale from the open before it. */
function EventNote({ symbol, now, openTs }: { symbol: string; now: number; openTs: number }) {
  const e = nextEvent(symbol, now);
  if (!e) return null;
  return (
    <p className="mt-3 rounded-lg border border-brass/40 bg-brass-soft px-3 py-2 text-sm leading-relaxed">
      {e.openTs === openTs ? (
        <>
          <span className="text-brass">This covers {e.title}.</span> <span className="text-muted">{e.detail}</span>
        </>
      ) : (
        <>
          <span className="text-brass">
            {e.title}: expected before the {nyTime(e.openTs)} open.
          </span>{" "}
          <span className="text-muted">Protection until that open goes on sale at the open before it. {e.detail}</span>
        </>
      )}
    </p>
  );
}

/**
 * This protection replayed on the stock's past openings: the night it paid most, and that it
 * costs more than it pays back on average, like insurance, with the rest staying with the pool.
 */
function Replay({ record, symbol, shares, oracle }: { record: BacktestResult; symbol: string; shares: number; oracle: string }) {
  const best = record.nights.reduce<BacktestNight | null>((b, n) => (n.paid > (b?.paid ?? 0) ? n : b), null);
  return (
    <p className="mt-4 leading-relaxed text-muted">
      Replayed on {record.nights.length} past {symbol} openings ({oracle}), each priced only from the ones before it, this protection{" "}
      {best ? (
        <>
          paid out on {record.paidNights === 1 ? "one" : record.paidNights} of them
          {record.paidNights > 1 ? ", most" : ""} on {dayLabel(best.to)}, when {symbol} opened {pct(1 - best.open / best.close, 1)} below the close:{" "}
          <span className="num text-text">{usd(best.paid * shares)}</span> back for <span className="num text-text">{usd(best.premium * shares)}</span>.
        </>
      ) : (
        <>never paid out.</>
      )}{" "}
      Across all of them it paid back <span className="num text-text">{Math.round(record.paidPerDollar * 100)}¢</span> per $1 of premium. Like
      insurance, it costs more than it pays back on average; what it doesn&apos;t pay back stays in the pool, with the{" "}
      <Link className="underline hover:text-text" href="/vault">
        underwriters
      </Link>{" "}
      who carry the risk.
    </p>
  );
}

/** One tap for the usual choices; the sliders below still set any levels. */
const PRESETS = [
  { label: "Close cover", start: 0.01, depth: 0.05 },
  { label: "Standard", start: 0.02, depth: 0.1 },
  { label: "Crash cover", start: 0.05, depth: 0.2 },
] as const;

/** 34.5 → "35×", 4.26 → "4.3×". */
const multiple = (x: number) => `${x >= 10 ? Math.round(x) : x.toFixed(1)}×`;

function Slider(props: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; price?: number }) {
  return (
    <label className="block">
      <span className="text-sm text-muted">{props.label}</span>
      <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-2">
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
