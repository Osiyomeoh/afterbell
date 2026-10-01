"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { fetchMarket, fetchRecord, type LedgerRow, type MarketResponse } from "@/lib/api";
import { currentEvent, eventPhase } from "@/lib/events";
import { countdown, nyTime, usd } from "@/lib/format";

const SYMBOL = "TSLA";

/**
 * The week's scheduled news, on the home page: when protection for the open
 * that carries it goes on sale, then how much has sold and when sales close,
 * then what that open paid. Nothing when no event is near.
 */
export function EventBanner() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [market, setMarket] = useState<MarketResponse | null>(null);
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const event = currentEvent(SYMBOL, now);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!event) return;
    const load = () => {
      fetchMarket(SYMBOL).then(setMarket, () => {});
      fetchRecord().then((r) => setRows(r.series), () => {});
    };
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [event?.openTs]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!event || !market || !rows) return null;
  const mine = rows.filter((r) => r.symbol === event.symbol && r.openTs === event.openTs);
  const sold = mine.reduce((t, r) => t + r.sales, 0);
  const cover = mine.reduce((t, r) => t + r.maxPayouts, 0);
  const settled = mine.find((r) => r.state === "settled");
  const phase = eventPhase(event, now, { nextOpen: market.nextOpen, holidays: new Set(market.holidays), stopBeforeOpenSecs: market.config.stopBeforeOpenSecs }, settled?.price ?? null);
  const protections = `${sold} protection${sold === 1 ? "" : "s"}`;
  const open = nyTime(event.openTs);

  let status: string;
  let action: { href: string; label: string } | null = null;
  switch (phase.phase) {
    case "settled":
      status = `${event.symbol} opened at ${usd(phase.price)}. ${protections} settled on it, paying ${usd(mine.reduce((t, r) => t + r.paid, 0))} in all.`;
      action = { href: "/event", label: "See how it settled" };
      break;
    case "bell-rung":
      status = sold ? `The bell has rung: ${protections} settle on ${event.symbol}'s opening price.` : "The bell has rung.";
      break;
    case "sales-closed":
      status = `Sales have closed${sold ? ` with ${sold} sold, ${usd(cover)} of cover` : ""}. The ${open} open settles every position.`;
      break;
    case "on-sale":
      status = `On sale now: protection until the ${open} open, which is expected to carry the number. ${sold ? `${sold} sold so far, ${usd(cover)} of cover. ` : ""}Sales close in ${countdown(phase.salesClose - now)}.`;
      action = { href: "#protect", label: `Protect ${event.symbol} through it` };
      break;
    case "waiting":
      status = `Expected before the ${open} open. Sales for it open once the vault has settled the open before it, in a few minutes.`;
      break;
    case "before-sales":
      status = `Expected before the ${open} open. Protection until that open goes on sale at the ${nyTime(phase.salesOpen)} open, in ${countdown(phase.salesOpen - now)}.`;
      break;
  }

  // Until it's on sale or settled, the event's own page follows it.
  action ??= { href: "/event", label: "Follow it" };

  return (
    <div className="mt-8 flex flex-col gap-3 rounded-2xl border border-brass/40 bg-brass-soft px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="min-w-0">
        <div className="text-xs font-medium tracking-wide text-brass uppercase">This week</div>
        <div className="mt-0.5 font-medium">{event.title}</div>
        <p className="mt-1 text-sm leading-relaxed text-muted">{status}</p>
      </div>
      {action && (
        <Link href={action.href} className="shrink-0 self-start rounded-lg bg-brass px-3.5 py-2 text-sm font-medium text-ink hover:opacity-90 sm:self-center">
          {action.label} →
        </Link>
      )}
    </div>
  );
}
