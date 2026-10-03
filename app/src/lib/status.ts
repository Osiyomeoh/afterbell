import type { LedgerRow } from "./api";
import { explorer, nyTime, usd } from "./format";

export type CheckState = "ok" | "warn" | "down";
export type Check = { name: string; state: CheckState; detail: string; href?: string };

/**
 * A keeper is keeping up if no series has waited past the grace period since its open. Past
 * `voidableAfterSecs` it's down: anyone may then void the series, refunding every premium instead of
 * settling it, though it can still be settled until someone does.
 */
export function keeper(
  rows: LedgerRow[],
  now: number,
  graceSecs: number,
  voidableAfterSecs: number,
  txUrl: (tx: string) => string = (tx) => explorer("tx", tx),
): Omit<Check, "name"> {
  const late = rows.filter((r) => r.state === "open" && now > r.openTs + graceSecs).sort((a, b) => a.openTs - b.openTs);
  if (late[0]) {
    const waited = now - late[0].openTs;
    const past = waited >= 7200 ? `${Math.floor(waited / 3600)} hours` : `${Math.round(waited / 60)} minutes`;
    const series = `${late[0].symbol}'s ${nyTime(late[0].openTs)} series is ${past} past its open and not settled yet`;
    if (waited > voidableAfterSecs) {
      return { state: "down", detail: `${series}. Anyone can void it now, refunding every premium; settle it before someone does.` };
    }
    return { state: "warn", detail: `${series}.` };
  }
  const settled = rows.filter((r) => r.state === "settled").sort((a, b) => b.openTs - a.openTs)[0];
  const due = rows.filter((r) => r.state === "open").sort((a, b) => a.openTs - b.openTs)[0];
  const next = due ? ` Next: ${due.symbol} at the ${nyTime(due.openTs)} open.` : "";
  if (!settled) return { state: "ok", detail: `Nothing has settled yet.${next}` };
  // The oracle's print is at the open; the lag is how long after it the price was published on-chain.
  const lag = settled.priceTime !== null ? ` Price published ${minutes(settled.priceTime - settled.openTs)} after the open.` : "";
  return {
    state: "ok",
    detail: `Last settled ${settled.symbol} at ${usd(settled.price ?? 0)} for the ${nyTime(settled.openTs)} open.${lag}${next}`,
    ...(settled.settleTx ? { href: txUrl(settled.settleTx) } : {}),
  };
}

function minutes(secs: number): string {
  const m = Math.max(0, Math.round(secs / 60));
  return m >= 120 ? `${Math.floor(m / 60)} hours` : `${m} minute${m === 1 ? "" : "s"}`;
}
