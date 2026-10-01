import Link from "next/link";

import type { BacktestNight, BacktestResult } from "@root/pricing/backtest";

import { nextEvent } from "@/lib/events";
import { NIGHT_OPTIONS } from "@/lib/everyNight";
import { dayLabel, nyTime, pct, usd } from "@/lib/format";

/** A scheduled event on this stock: covered by this protection, or by protection on sale from the open before it. */
export function EventNote({ symbol, now, openTs }: { symbol: string; now: number; openTs: number }) {
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
            {e.title.charAt(0).toUpperCase() + e.title.slice(1)}: expected before the {nyTime(e.openTs)} open.
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
export function Replay({ record, symbol, shares, oracle }: { record: BacktestResult; symbol: string; shares: number; oracle: string }) {
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
export const PRESETS = [
  { label: "Close cover", start: 0.01, depth: 0.05 },
  { label: "Standard", start: 0.02, depth: 0.1 },
  { label: "Crash cover", start: 0.05, depth: 0.2 },
] as const;

export function Slider(props: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; price?: number }) {
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

/** Protect every night: renew tonight's protection each night, within a nightly cap, for the nights chosen. */
export function EveryNight({ nights, onChange, cap }: { nights: number | null; onChange: (n: number | null) => void; cap: number }) {
  return (
    <div className="mt-4 rounded-lg border border-line p-3 text-sm">
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={nights !== null} onChange={(e) => onChange(e.target.checked ? NIGHT_OPTIONS[1] : null)} />
        <span>
          Protect every night
          {nights !== null && (
            <>
              {" "}
              for{" "}
              <select className="rounded border border-line bg-ink px-1" value={nights} onChange={(e) => onChange(Number(e.target.value))} aria-label="Nights">
                {NIGHT_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>{" "}
              nights
            </>
          )}
          , at most <span className="num">{usd(cap)}</span> a night
        </span>
      </label>
      <p className="mt-1 pl-6 text-xs leading-relaxed text-faint">
        After each open a keeper buys the next night&apos;s protection at the quote service&apos;s price, never above the cap, and it arrives in your
        wallet like tonight&apos;s. Stop it any time from My protection.
      </p>
    </div>
  );
}

/**
 * No Solana wallet in this browser: offer the test wallet, which works at
 * once, then point to a real one, and on a phone (where browsers can't hold
 * one) open the page inside a wallet's own browser.
 */
export function NoWallet() {
  const here = typeof window === "undefined" ? "" : window.location.href;
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const inWallet = (base: string) => `${base}/${encodeURIComponent(here)}?ref=${encodeURIComponent(origin)}`;
  return (
    <div className="mt-3 rounded-lg border border-line p-3 text-sm text-muted">
      <p>No Solana wallet in this browser, so the button above makes a test wallet kept here: it gets test money as it connects, and buys in one click.</p>
      <p className="mt-3">
        For your own wallet, install{" "}
        <a className="text-text underline" href="https://phantom.com/download" target="_blank" rel="noreferrer">
          Phantom
        </a>{" "}
        or{" "}
        <a className="text-text underline" href="https://solflare.com/download" target="_blank" rel="noreferrer">
          Solflare
        </a>{" "}
        and switch it to devnet, or on a phone open this page in the wallet&apos;s own browser:
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <a className="rounded-lg border border-line px-3 py-1.5 text-text hover:bg-raised" href={inWallet("https://phantom.app/ul/browse")}>
          Open in Phantom
        </a>
        <a className="rounded-lg border border-line px-3 py-1.5 text-text hover:bg-raised" href={inWallet("https://solflare.com/ul/v1/browse")}>
          Open in Solflare
        </a>
      </div>
    </div>
  );
}

export function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="num text-right">{value}</dd>
    </div>
  );
}

export function Notice({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-line bg-surface p-6 text-muted">{children}</div>;
}
