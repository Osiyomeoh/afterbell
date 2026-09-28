"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { fetchMarket, fetchRecord, type LedgerRow, type MarketResponse } from "@/lib/api";
import { currentEvent, openBefore } from "@/lib/events";
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
  const salesOpen = openBefore(event.openTs, new Set(market.holidays));
  const salesClose = event.openTs - market.config.stopBeforeOpenSecs;
  const settled = mine.find((r) => r.state === "settled");

  let status: React.ReactNode;
  let action: { href: string; label: string } | null = null;
  if (settled) {
    const paid = mine.reduce((t, r) => t + r.paid, 0);
    status = `${event.symbol} opened at ${usd(settled.price ?? 0)}. ${sold} protection${sold === 1 ? "" : "s"} settled on it, paying ${usd(paid)} in all.`;
    action = { href: "/record", label: "See every settlement" };
  } else if (now >= event.openTs) {
    status = sold ? `The bell has rung: ${sold} protection${sold === 1 ? "" : "s"} settle on ${event.symbol}'s opening price.` : "The bell has rung.";
  } else if (market.nextOpen === event.openTs && now < salesClose) {
    const soFar = sold ? `${sold} sold so far, ${usd(cover)} of cover. ` : "";
    status = `On sale now: protection until the ${nyTime(event.openTs)} open, which is expected to carry the number. ${soFar}Sales close in ${countdown(salesClose - now)}.`;
    action = { href: "#protect", label: `Protect ${event.symbol} through it` };
  } else if (now < salesOpen) {
    status = `Expected before the ${nyTime(event.openTs)} open. Protection until that open goes on sale at the ${nyTime(salesOpen)} open, in ${countdown(salesOpen - now)}.`;
  } else {
    status = `Expected before the ${nyTime(event.openTs)} open. Sales for it open once the vault has settled the open before it.`;
  }

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
