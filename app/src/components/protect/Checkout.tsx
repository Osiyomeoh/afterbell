import Link from "next/link";

import type { Chain, StockListing } from "@/lib/api";
import { CAP_OVER_TONIGHT } from "@/lib/everyNight";
import { MAX_MULTIPLE, nyTime, pct, usd } from "@/lib/format";
import type { PricedProtection } from "@root/quoter/quoter";

import { EveryNight, NoWallet, Row } from "./parts";
import type { Status } from "./status";

/** What the price is quoted from, in words. */
const BASIS: Record<string, string> = {
  live: "the live price",
  close: "the last close",
  "live, below the close": "the live price, which is below the last close",
};

/** 34.5 → "35×", 4.26 → "4.3×". */
const multiple = (x: number) => `${x >= 10 ? Math.round(x) : x.toFixed(1)}×`;

/**
 * The price, the buy button and what came of buying: beside the ticket on wide screens, inside it (under the
 * sliders) on phones, where the aside only starts below the whole ticket.
 */
export function Checkout(props: {
  priced?: PricedProtection | null;
  chain: Chain;
  status: Status;
  label: string;
  blocked?: string | null;
  unavailable: string | null;
  /** Stocks on sale on some chain, offered when this one isn't. */
  onSale: StockListing[];
  onSwitch: (symbol: string, on: Chain) => void;
  /** The standing-order choice, where this chain can renew. */
  everyNight: { nights: number | null; onChange: (n: number | null) => void } | null;
  showNoWallet: boolean;
  onBuy: () => void;
}) {
  const { priced, chain, status, label, blocked, unavailable, onSale, onSwitch, everyNight, showNoWallet, onBuy } = props;
  return (
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
            {priced.maxPayout / priced.premium <= MAX_MULTIPLE ? (
              <>
                Up to <span className="num text-text">{multiple(priced.maxPayout / priced.premium)}</span> what you pay, with a{" "}
              </>
            ) : (
              "A "
            )}
            <span className="num text-text">{pct(priced.probabilityOfPayout)}</span> chance it pays anything.
          </p>
        )}
        <dl className="mt-4 space-y-2 text-sm">
          <Row label="Priced from" value={priced ? usd(priced.reference.price) : "—"} />
        </dl>
        {priced && <p className="mt-1 text-right text-xs text-faint">{BASIS[priced.reference.basis]}</p>}
        {everyNight && priced && <EveryNight nights={everyNight.nights} onChange={everyNight.onChange} cap={priced.premium * CAP_OVER_TONIGHT} />}
        <button
          onClick={onBuy}
          disabled={!!blocked || status.kind === "busy"}
          className="mt-5 w-full rounded-xl bg-brass px-4 py-3 font-medium text-ink transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {label}
        </button>
        {blocked && <p className="mt-3 text-sm text-loss">{blocked}</p>}
        {unavailable && onSale.length > 0 && (
          <div className="mt-3">
            <p className="text-sm text-muted">On sale now:</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {onSale.map((s) => {
                const on: Chain = s.solana ? "solana" : "robinhood";
                return (
                  <button
                    key={s.symbol}
                    type="button"
                    onClick={() => onSwitch(s.symbol, on)}
                    className="rounded-lg border border-brass/60 px-3 py-1.5 text-sm text-brass hover:bg-raised"
                  >
                    {s.symbol} on {on === "solana" ? "Solana" : "Robinhood Chain"}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {showNoWallet && <NoWallet />}
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
        {status.kind === "done" && status.renews && (
          <p className={`mt-2 text-sm ${"error" in status.renews ? "text-loss" : "text-gain"}`}>
            {"error" in status.renews
              ? `Tonight is bought, but the standing order wasn't set: ${status.renews.error}`
              : `It renews every night until ${nyTime(status.renews.until)}, at most ${usd(status.renews.cap)} a night. Stop it any time from My protection.`}
          </p>
        )}
        {status.kind === "done" && status.nft && (
          <Link href={status.nft.share} className="mt-2 inline-block text-sm text-brass hover:underline">
            Share your protection →
          </Link>
        )}
      </>
  );
}
