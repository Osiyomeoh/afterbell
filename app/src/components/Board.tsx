"use client";

import { useEffect, useState } from "react";

import { fetchBoard, type BoardRow } from "@/lib/api";
import { nyTime, pct, usd } from "@/lib/format";

/**
 * Every stock at a glance: standard cover (2% to 10% below) on one share, what
 * it costs, the most it pays and the chance it pays, priced as the ticket
 * prices it. Stocks a deployed vault sells come first; tapping one opens it in
 * the ticket.
 */
export function Board({ current, onPick }: { current: string; onPick: (symbol: string) => void }) {
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    const load = () => fetchBoard().then((r) => setRows(r.rows), () => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  if (!rows) return null;
  const selling = (r: BoardRow) => r.solana || r.robinhood;
  const sorted = [...rows].sort((a, b) => Number(selling(b)) - Number(selling(a)) || a.symbol.localeCompare(b.symbol));
  const priced = rows.find((r): r is Extract<BoardRow, { price: unknown }> => "price" in r);

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-semibold tracking-tight">Every stock, tonight</h2>
        <p className="text-sm text-muted">
          Standard cover, 2% to 10% below, on one share{priced ? `, until ${nyTime(priced.price.openTs)}` : ""}.
        </p>
      </div>
      <ul className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        {sorted.map((r, i) => (
          // Eight at first, the rest on request; the current stock always shows.
          <li key={r.symbol} className={!all && i >= FIRST && r.symbol !== current ? "hidden" : undefined}>
            <button
              type="button"
              onClick={() => onPick(r.symbol)}
              aria-pressed={r.symbol === current}
              className={`block h-full w-full rounded-xl border bg-surface p-3 text-left transition hover:border-muted sm:p-4 ${r.symbol === current ? "border-brass" : "border-line"}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="num font-semibold">{r.symbol}</span>
                {"price" in r && <Change price={r.price} />}
              </div>
              <div className="truncate text-xs text-muted">{r.name}</div>
              {"price" in r ? (
                <>
                  <div className="mt-3 flex items-baseline justify-between gap-2">
                    <span className="num text-lg font-semibold">{r.price.premium < 0.01 ? "< $0.01" : usd(r.price.premium)}</span>
                    <span className="num text-sm text-gain">{usd(r.price.maxPayout)}</span>
                  </div>
                  <div className="flex items-baseline justify-between gap-2 text-xs text-faint">
                    <span>costs</span>
                    <span>pays up to</span>
                  </div>
                  <div className="num mt-2 text-xs text-muted">
                    {r.price.premium >= 0.01 ? `${Math.round(r.price.maxPayout / r.price.premium)}× · ` : ""}
                    {pct(r.price.probabilityOfPayout)} chance
                  </div>
                </>
              ) : (
                <div className="mt-3 text-xs text-faint">Can&apos;t be priced right now.</div>
              )}
              <div className="mt-2 text-xs">
                {r.solana ? (
                  <span className="text-brass">On sale on Solana</span>
                ) : r.robinhood ? (
                  <span className="text-brass">On sale on Robinhood Chain</span>
                ) : (
                  <span className="text-faint">{r.settles.includes("robinhood") ? "Robinhood Chain, once deployed" : "Priced, not on sale"}</span>
                )}
              </div>
            </button>
          </li>
        ))}
      </ul>
      {!all && sorted.length > FIRST && (
        <button type="button" onClick={() => setAll(true)} className="mt-4 w-full rounded-xl border border-line px-4 py-2.5 text-sm text-muted hover:text-text">
          Show all {sorted.length} stocks
        </button>
      )}
    </section>
  );
}

const FIRST = 8;

function Change({ price }: { price: { close: number; live: number | null } }) {
  if (price.live === null) return null;
  const c = price.live / price.close - 1;
  return (
    <span className={`num text-xs ${c >= 0 ? "text-gain" : "text-loss"}`}>
      {c >= 0 ? "+" : ""}
      {pct(c, 2)}
    </span>
  );
}
