"use client";

import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useEffect, useMemo, useRef, useState } from "react";

import { backtest } from "@root/pricing/backtest";
import { priceQuote } from "@root/quoter/quoter";

import { fetchHoldings, fetchMarket, requestEvmQuote, requestQuote, toMarket, type Chain, type MarketResponse, type PriceSource } from "@/lib/api";
import { buyProtection, NotEnoughTestUsd, protectEveryNightOnSolana } from "@/lib/buy";
import { buyOnRobinhood, evmTxUrl, NeedsGas, protectEveryNight, useEvmWallet } from "@/lib/evm";
import { countdown, explorer, nyTime, pct, usd } from "@/lib/format";
import { standingOrder } from "@/lib/everyNight";
import { sharePath } from "@/lib/share";
import { TestWalletName } from "@/lib/testWallet";
import { useSendTransaction } from "@/lib/send";

import { Board } from "./Board";
import { OvernightChart } from "./OvernightChart";
import { PayoffChart } from "./PayoffChart";
import { Checkout } from "./protect/Checkout";
import { MobileBar } from "./protect/MobileBar";
import { EventNote, Notice, PRESETS, Replay, Row, Slider } from "./protect/parts";
import type { Status } from "./protect/status";
import { TestFunds } from "./TestFunds";

const round2 = (v: number) => Math.round(v * 100) / 100;
/** The deepest a link may set protection to stop, as a fraction below the price: as deep as the gap report prices. */
const MAX_STOP = 0.5;

const CHAINS: { id: Chain; label: string }[] = [
  { id: "solana", label: "Solana devnet" },
  { id: "robinhood", label: "Robinhood Chain" },
];

const SETTLED_BY: Record<Chain, (symbol: string) => string> = {
  solana: () => "Settled by the first Pyth price at or after 09:30 ET.",
  robinhood: (symbol) => `Settled by Chainlink's ${symbol} price in force at 09:30 ET.`,
};

const SOURCE: Record<PriceSource, string> = { pyth: "Pyth", chainlink: "Chainlink", hyperliquid: "Hyperliquid" };

/** Why the ticket can't sell this stock on this chain, in plain words, or null when it can. */
/** A wallet's error in words: viem's short message when it has one. */
const errorMessage = (e: unknown) => {
  const err = e as Error & { shortMessage?: string };
  return err.shortMessage ?? err.message;
};

function unavailableOn(chain: Chain, m: MarketResponse): string | null {
  const listing = m.stocks.find((s) => s.symbol === m.symbol);
  const sym = m.symbol;
  if (chain === "solana") {
    if (!m.solana) return "The Solana vault isn't deployed yet.";
    if (m.solana.selling) return null;
    if (listing?.settles.includes("solana")) return `${sym} isn't on sale on Solana yet.`;
    // Solana settles on Pyth's prices, and the quote service reads them for these only.
    const sold = m.stocks.filter((s) => s.solana).map((s) => s.symbol);
    const there = m.robinhood ? "Robinhood Chain" : "Robinhood Chain, once that vault is deployed";
    return `${sym} isn't sold on Solana${sold.length ? `, which sells ${sold.join(" and ")}` : ""}. ${sym} is for ${there}.`;
  }
  const rh = m.robinhood;
  if (!rh) return `Robinhood Chain's vault isn't deployed yet, so ${sym} isn't on sale there.`;
  if (!rh.feeds[sym]) return `${sym} isn't on sale on Robinhood Chain yet.`;
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
  // Protect every night (Robinhood Chain): the nights to renew for, or null for tonight only.
  const [everyNight, setEveryNight] = useState<number | null>(null);
  const [chain, setChain] = useState<Chain>("solana");
  const [symbol, setSymbol] = useState("TSLA");
  const evm = useEvmWallet();

  // A link can open the ticket on a chain, a stock, a size and levels in percent below the price:
  // /?chain=robinhood&symbol=NVDA&shares=40&start=2&stop=25 (the loan check links down to a loan's liquidation price).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("chain") === "robinhood") setChain("robinhood");
    const s = q.get("symbol");
    if (s && /^[A-Za-z.]{1,10}$/.test(s)) setSymbol(s.toUpperCase());
    const n = Number(q.get("shares"));
    if (n > 0) setShares(Math.max(0.01, Math.min(n, market?.config.maxShares ?? 1_000)));
    const from = q.has("start") ? Number(q.get("start")) : 2;
    const to = Number(q.get("stop"));
    if (from >= 0 && from <= 10) setStart(from / 100);
    if (q.has("stop") && to >= from + 1 && to <= MAX_STOP * 100) setDepth(to / 100);
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
  const { wallets, select } = useWallet();
  const sendTransaction = useSendTransaction();
  // Wallets register themselves a moment after the page loads; until then, don't say there are none.
  const [walletsSettled, setWalletsSettled] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWalletsSettled(true), 1200);
    return () => clearTimeout(t);
  }, []);
  // No wallet of the person's own: the test wallet is always there, so it doesn't count.
  const noSolanaWallet = walletsSettled && !wallets.some((w) => w.adapter.name !== TestWalletName && (w.readyState === "Installed" || w.readyState === "Loadable"));
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

  /**
   * Tonight is bought; set the standing order that renews it. One that fails to set leaves tonight
   * bought, and says why.
   */
  async function thenEveryNight(
    done: Extract<Status, { kind: "done" }>,
    set: (order: ReturnType<typeof standingOrder>["order"], allowance: ReturnType<typeof standingOrder>["allowance"]) => Promise<unknown>,
  ) {
    if (!protection || everyNight === null) return setStatus(done);
    try {
      const { order, allowance } = standingOrder({ shares: protection.shares, start, depth, premium: done.premium, openTs: done.openTs, nights: everyNight });
      await set(order, allowance);
      setStatus({ ...done, renews: { until: Number(order.until), cap: Number(order.maxPremium) / 1e6 } });
    } catch (e) {
      setStatus({ ...done, renews: { error: errorMessage(e) } });
    }
  }

  async function buy() {
    if (!protection) return;
    if (chain === "robinhood") return buyOnEvm();
    // With no wallet of their own, the one button starts the test wallet rather than a modal listing nothing.
    if (!wallet) return noSolanaWallet ? select(TestWalletName) : setVisible(true);
    try {
      setStatus({ kind: "busy", step: "Getting a signed quote" });
      const q = await requestQuote({ symbol, buyer: wallet.publicKey.toBase58(), ...protection });
      setStatus({ kind: "busy", step: "Confirm in your wallet" });
      const { signature, position, number } = await buyProtection(connection, wallet, sendTransaction, q.solana);
      const nft = { number: number.toString(), art: `/api/position-art/solana/${position}/image`, share: sharePath("solana", position.toString()) };
      const done = { kind: "done", premium: q.priced.premium, openTs: q.priced.openTs, url: explorer("tx", signature), nft } as const;
      await thenEveryNight(done, async (order, allowance) => {
        setStatus({ kind: "busy", step: "Confirm the standing order in your wallet" });
        await protectEveryNightOnSolana(connection, wallet, sendTransaction, q.solana, { ...order, allowance });
      });
    } catch (e) {
      setStatus({ kind: "error", message: errorMessage(e), needsFunds: e instanceof NotEnoughTestUsd });
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
      const done = { kind: "done", premium: q.priced.premium, openTs: q.priced.openTs, url: evmTxUrl(d, hash), nft: { number: id.toString(), art: `/api/position-art/${id}`, share: sharePath("robinhood", id.toString()) } } as const;
      const feed = d.feeds[symbol];
      if (everyNight === null || !d.renewer || !feed) return setStatus(done);
      await thenEveryNight(done, (order, allowance) =>
        protectEveryNight(buyer, { ...d, renewer: d.renewer! }, feed, order, allowance, (step) => setStatus({ kind: "busy", step })),
      );
    } catch (e) {
      setStatus({ kind: "error", message: errorMessage(e), needsFunds: e instanceof NeedsGas });
    }
  }

  // On a phone the checkout sits under the sliders; while the ticket is on screen but the checkout isn't, a bar
  // at the bottom keeps the price and the button in reach.
  const ticketRef = useRef<HTMLElement>(null);
  const checkoutRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState({ ticket: false, checkout: false });
  useEffect(() => {
    const ticket = ticketRef.current;
    const box = checkoutRef.current;
    if (!ticket || !box) return;
    const observer = new IntersectionObserver((entries) =>
      setInView((v) => {
        const next = { ...v };
        for (const e of entries) next[e.target === ticket ? "ticket" : "checkout"] = e.isIntersecting;
        return next;
      }),
    );
    observer.observe(ticket);
    observer.observe(box);
    return () => observer.disconnect();
  }, [!!market]);

  if (loadError) return <Notice>Market data for {symbol} is unavailable: {loadError}</Notice>;
  if (!market) return <Notice>Loading {symbol}…</Notice>;
  // Still showing the last stock while the one just picked loads.
  const loading = market.symbol !== symbol;

  const priced = preview && "priced" in preview ? preview.priced : null;
  const unavailable = loading ? null : unavailableOn(chain, market);
  const blocked = (loading ? `Loading ${symbol}…` : null) ?? unavailable ?? market.paused ?? (preview && "error" in preview ? preview.error : null);
  // Where protection is on sale now, for a stock or chain where it isn't.
  const onSale = market.stocks.filter((s) => s.solana || s.robinhood);
  function switchTo(next: string, on: Chain) {
    pickStock(next);
    setChain(on);
  }
  const openTs = priced?.openTs ?? market.nextOpen;
  const connected = chain === "solana" ? !!wallet : !!evm.address;

  const buttonLabel = (() => {
    if (status.kind === "busy") return status.step;
    if (unavailable) return "Not on sale yet";
    if (!connected) {
      if (chain === "robinhood") return "Connect an EVM wallet";
      return noSolanaWallet ? "Try it with a test wallet" : "Connect a wallet";
    }
    return priced ? `Protect for ${usd(priced.premium)}` : "Protect";
  })();


  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <section ref={ticketRef} className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-lg border border-line bg-ink p-0.5 text-sm" role="tablist" aria-label="Chain">
            {CHAINS.map((c) => (
              <button
                key={c.id}
                role="tab"
                aria-selected={chain === c.id}
                onClick={() => {
                  // A chain that doesn't sell this stock opens on one it does, rather than on a ticket that can't sell.
                  const sold = market.stocks.filter((s) => (c.id === "solana" ? s.solana : s.robinhood));
                  if (sold.length && !sold.some((s) => s.symbol === market.symbol)) pickStock(sold[0]!.symbol);
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
        {protection && <OvernightChart symbol={market.symbol} openTs={openTs} now={now} upper={protection.upper} lower={protection.lower} />}

        <div className="mt-5 grid grid-cols-3 gap-2" role="group" aria-label="Protection presets">
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
                className={`min-w-0 rounded-lg border px-2.5 py-1.5 text-left text-sm ${on ? "border-brass bg-raised text-text" : "border-line text-muted hover:text-text"}`}
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
          <Slider label="Protection stops" value={Math.max(depth, start + 0.01)} min={start + 0.01} max={Math.max(0.3, depth)} step={0.01} onChange={setDepth} price={protection?.lower} />
        </div>

        <div ref={checkoutRef} className="mt-6 rounded-xl border border-line bg-ink p-4 lg:hidden">
          <Checkout
            priced={priced}
            chain={chain}
            status={status}
            label={buttonLabel}
            blocked={blocked}
            unavailable={unavailable}
            onSale={onSale}
            onSwitch={switchTo}
            everyNight={chain === "solana" || market.robinhood?.renewer ? { nights: everyNight, onChange: setEveryNight } : null}
            showNoWallet={chain === "solana" && !unavailable && !connected && noSolanaWallet}
            onBuy={buy}
          />
        </div>

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
        <div className="hidden rounded-2xl border border-line bg-surface p-5 lg:block">
          <Checkout
            priced={priced}
            chain={chain}
            status={status}
            label={buttonLabel}
            blocked={blocked}
            unavailable={unavailable}
            onSale={onSale}
            onSwitch={switchTo}
            everyNight={chain === "solana" || market.robinhood?.renewer ? { nights: everyNight, onChange: setEveryNight } : null}
            showNoWallet={chain === "solana" && !unavailable && !connected && noSolanaWallet}
            onBuy={buy}
          />
        </div>

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

      {inView.ticket && !inView.checkout && <MobileBar priced={priced} blocked={blocked} busy={status.kind === "busy"} label={buttonLabel} onBuy={buy} />}

      <div className="lg:col-span-2">
        <Board
          current={symbol}
          onPick={(s) => {
            pickStock(s);
            ticketRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        />
      </div>
    </div>
  );
}
