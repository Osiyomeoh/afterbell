"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { fetchRecord, type LedgerRow } from "@/lib/api";
import { nyTime, usd } from "@/lib/format";

/**
 * What the vaults are doing, from the track record: protection open for the
 * next opens, and what settled openings have paid. Shows nothing until read.
 */
export function Activity() {
  const [rows, setRows] = useState<LedgerRow[] | null>(null);

  useEffect(() => {
    const load = () => fetchRecord().then((r) => setRows(r.series), () => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  if (!rows) return null;
  const open = rows.filter((r) => r.state === "open");
  const settled = rows.filter((r) => r.state === "settled");
  const next = open.length ? Math.min(...open.map((r) => r.openTs)) : null;
  const sum = (xs: LedgerRow[], f: (r: LedgerRow) => number) => xs.reduce((t, r) => t + f(r), 0);
  // Both chains' vaults can settle the same opening, so count and sum by opening, not by vault.
  const openings = new Set(settled.map((r) => r.openTs)).size;
  const last = [...settled].sort((a, b) => b.openTs - a.openTs)[0];
  const atLast = last ? settled.filter((r) => r.openTs === last.openTs && r.symbol === last.symbol) : [];
  const positionsAtLast = sum(atLast, (r) => r.claims);

  const protectedCount = sum(open, (r) => r.sales);
  const protectedNow = (
    <Stat
      label="Protected now"
      value={open.length ? `${protectedCount} position${protectedCount === 1 ? "" : "s"}` : "None open"}
      note={next !== null ? `${usd(sum(open, (r) => r.maxPayouts))} locked for ${nyTime(next)}` : "The next sale opens a series"}
    />
  );
  // Before anything has settled, say when the first settlement is rather than show empty totals.
  if (!last) {
    return (
      <div className="mt-6 grid grid-cols-2 gap-3 sm:max-w-2xl lg:mt-0 lg:max-w-none lg:grid-cols-1">
        {protectedNow}
        <Stat label="First settlement" value={next !== null ? nyTime(next).split(",")[0]! : "Not yet"} note={next !== null ? `at the ${nyTime(next).split(", ")[1]} open` : "Every settlement is listed on the track record"} href="/record" />
      </div>
    );
  }
  return (
    <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:mt-0 lg:grid-cols-1">
      {protectedNow}
      <Stat label="Paid out" value={usd(sum(rows, (r) => r.paid))} note={`on ${openings} settled opening${openings === 1 ? "" : "s"}`} />
      <Stat
        label="Last settlement"
        value={`${last.symbol} ${usd(last.price ?? 0)}`}
        note={`${nyTime(last.openTs)}: ${usd(sum(atLast, (r) => r.paid))} across ${positionsAtLast} position${positionsAtLast === 1 ? "" : "s"}`}
        href="/record"
        wide
      />
    </div>
  );
}

function Stat({ label, value, note, href, wide }: { label: string; value: string; note: string; href?: string; wide?: boolean }) {
  const body = (
    <>
      <div className="text-xs text-muted">{label}</div>
      <div className="num mt-1 text-base font-semibold sm:text-lg">{value}</div>
      <div className="mt-0.5 text-xs text-faint">{note}</div>
    </>
  );
  const cls = `${wide ? "col-span-2 sm:col-span-1 " : ""}min-w-0 rounded-xl border border-line bg-surface px-3 py-2.5 sm:px-4 sm:py-3`;
  return href ? (
    <Link href={href} className={`${cls} block hover:border-muted`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
