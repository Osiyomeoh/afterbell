"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { formatBook, type BookLine } from "@root/quoter/gapReport";

import { fetchGapReport, fetchMarket, type GapReportResponse } from "@/lib/api";
import { dayLabel, nyTime, pct, usd } from "@/lib/format";

import { DataTable } from "./DataTable";
import { Stat, Stats } from "./Stats";

type Row = { symbol: string; amount: string; unit: "shares" | "usd" };

const MAX_SHARES_PER_QUOTE = 1_000;
const DEFAULT_ROWS: Row[] = [{ symbol: "TSLA", amount: "100", unit: "shares" }];

const toBook = (rows: Row[]): BookLine[] =>
  rows.flatMap((r) => {
    const n = Number(r.amount);
    return n > 0 ? [r.unit === "usd" ? { symbol: r.symbol, value: n } : { symbol: r.symbol, shares: n }] : [];
  });

const fromBook = (book: string): Row[] =>
  book.split(",").flatMap((part) => {
    const m = /^([A-Za-z.]{1,10}):(\$)?([0-9.]+)$/.exec(part.trim());
    return m ? [{ symbol: m[1]!.toUpperCase(), amount: m[3]!, unit: m[2] ? ("usd" as const) : ("shares" as const) }] : [];
  });

/**
 * What the hours the exchange is shut could cost a book of tokenized stocks,
 * and what protecting it until the next open costs now. The link carries the
 * book, so a report can be shared: /gap?book=TSLA:100,NVDA:$25000.
 */
export function GapReport() {
  const [stocks, setStocks] = useState<{ symbol: string; name: string }[]>([]);
  const [rows, setRows] = useState<Row[]>(DEFAULT_ROWS);
  const [owner, setOwner] = useState("");
  const [start, setStart] = useState("2");
  const [stop, setStop] = useState("10");
  const [report, setReport] = useState<GapReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchMarket().then((m) => setStocks(m.stocks.map((s) => ({ symbol: s.symbol, name: s.name }))), () => {});
  }, []);

  const run = useCallback(async (q: { rows: Row[]; owner: string; start: string; stop: string }) => {
    const book = toBook(q.rows);
    setBusy(true);
    setError(null);
    try {
      const params = { book: book.length ? formatBook(book) : undefined, owner: q.owner.trim() || undefined, start: Number(q.start), stop: Number(q.stop) };
      setReport(await fetchGapReport(params));
      // The address bar keeps the book, so the report can be shared as a link.
      const url = new URL(window.location.href);
      url.search = "";
      if (params.book) url.searchParams.set("book", params.book);
      if (params.owner) url.searchParams.set("owner", params.owner);
      if (q.start !== "2") url.searchParams.set("start", q.start);
      if (q.stop !== "10") url.searchParams.set("stop", q.stop);
      window.history.replaceState(null, "", url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  // A shared link opens with its book and runs straight away.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const shared = { rows: q.get("book") ? fromBook(q.get("book")!) : [], owner: q.get("owner") ?? "", start: q.get("start") ?? "2", stop: q.get("stop") ?? "10" };
    if (shared.rows.length) setRows(shared.rows);
    setOwner(shared.owner);
    setStart(shared.start);
    setStop(shared.stop);
    if (shared.rows.length || shared.owner) run(shared);
  }, [run]);

  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const choices = stocks.length ? stocks : rows.map((r) => ({ symbol: r.symbol, name: r.symbol }));

  return (
    <div className="space-y-6">
      <form
        className="space-y-5 rounded-2xl border border-line bg-surface p-5 sm:p-6"
        onSubmit={(e) => {
          e.preventDefault();
          run({ rows, owner, start, stop });
        }}
      >
        <div>
          <div className="text-sm text-muted">The book</div>
          <div className="mt-2 space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <select
                  value={r.symbol}
                  onChange={(e) => setRow(i, { symbol: e.target.value })}
                  aria-label="Stock"
                  className="num w-full min-w-0 rounded-lg border border-line bg-ink px-2.5 py-2 text-sm sm:w-auto sm:max-w-64 sm:flex-1"
                >
                  {choices.map((s) => (
                    <option key={s.symbol} value={s.symbol}>
                      {s.symbol} · {s.name}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={r.amount}
                  onChange={(e) => setRow(i, { amount: e.target.value })}
                  aria-label="Amount"
                  className="num w-28 rounded-lg border border-line bg-ink px-3 py-2 text-sm"
                />
                <select
                  value={r.unit}
                  onChange={(e) => setRow(i, { unit: e.target.value as Row["unit"] })}
                  aria-label="Unit"
                  className="rounded-lg border border-line bg-ink px-2.5 py-2 text-sm"
                >
                  <option value="shares">shares</option>
                  <option value="usd">dollars</option>
                </select>
                {rows.length > 1 && (
                  <button type="button" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} className="px-2 text-sm text-muted hover:text-text">
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
          <button type="button" onClick={() => setRows((rs) => [...rs, { symbol: "NVDA", amount: "10000", unit: "usd" }])} className="mt-2 text-sm text-brass hover:underline">
            Add a stock
          </button>
        </div>

        <label className="block">
          <span className="text-sm text-muted">Or add what a Solana wallet holds (its TSLAx and TSLAon, read on mainnet)</span>
          <input
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            placeholder="Wallet address"
            className="num mt-1.5 w-full rounded-lg border border-line bg-ink px-3 py-2 text-sm"
          />
        </label>

        <div className="flex flex-wrap items-end gap-4">
          <Percent label="Protection starts" value={start} onChange={setStart} />
          <Percent label="and stops" value={stop} onChange={setStop} />
          <button type="submit" disabled={busy} className="ml-auto rounded-xl bg-brass px-5 py-2.5 font-medium text-ink hover:brightness-110 disabled:opacity-40">
            {busy ? "Reading prices…" : "Run the report"}
          </button>
        </div>
        {error && <p className="text-sm text-loss">{error}</p>}
      </form>

      {report && <Results report={report} copied={copied} onCopy={() => navigator.clipboard.writeText(window.location.href).then(() => setCopied(true), () => {})} />}
    </div>
  );
}

function Percent({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-sm text-muted">{label}</span>
      <span className="mt-1.5 flex items-center gap-2">
        <input
          type="number"
          min={0}
          max={50}
          step={0.5}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="num w-20 rounded-lg border border-line bg-ink px-3 py-2 text-sm"
        />
        <span className="text-sm text-muted">% below the price</span>
      </span>
    </label>
  );
}

function Results({ report, copied, onCopy }: { report: GapReportResponse; copied: boolean; onCopy: () => void }) {
  const t = report.totals;
  const openTs = report.lines.flatMap((l) => ("openTs" in l.tonight ? [l.tonight.openTs] : []))[0];
  const { deductible, depth } = report.structure;
  return (
    <section className="space-y-4">
      <Stats>
        <Stat label="The book" value={usd(t.value, 0)} note={`${report.lines.length} stock${report.lines.length === 1 ? "" : "s"}`} />
        <Stat label="Each stock's worst opening, at once" value={`−${usd(t.worstNightLoss, 0)}`} note={`protection would pay ${usd(t.worstNightPaid, 0)}`} />
        <Stat label="Protect it until the next open" value={usd(t.premium)} note={`pays up to ${usd(t.maxPayout, 0)}`} />
      </Stats>

      <div className="overflow-hidden rounded-2xl border border-line bg-surface">
        <DataTable
          dense
          top
          rows={report.lines.map((l) => ({ ...l, rounded: Math.round(l.shares * 10_000) / 10_000 }))}
          rowKey={(l) => l.symbol}
          columns={[
            {
              label: "Stock",
              phone: "title",
              cell: (l) => (
                <>
                  <div>{l.symbol}</div>
                  <div className="text-xs font-normal text-muted">{report.names[l.symbol]}</div>
                </>
              ),
            },
            {
              label: "Value",
              numeric: true,
              cell: (l) => (
                <>
                  <div>{usd(l.value, 0)}</div>
                  <div className="text-xs text-muted">
                    {l.rounded} sh at {usd(l.reference.price)}
                  </div>
                </>
              ),
            },
            {
              label: "Opened 2%+ down",
              numeric: true,
              cell: (l) => (
                <>
                  <div>{l.history.downAtLeast.find((d) => d.move === 0.02)?.nights ?? 0}</div>
                  <div className="text-xs text-muted">of {l.history.openings}</div>
                </>
              ),
            },
            {
              label: "Worst opening",
              numeric: true,
              cell: (l) => (
                <>
                  <div className={l.history.worst.gap < 0 ? "text-loss" : ""}>{pct(l.history.worst.gap, 1)}</div>
                  <div className="text-xs text-muted">{dayLabel(l.history.worst.to)}</div>
                </>
              ),
            },
            {
              label: "That night, now",
              numeric: true,
              cell: (l) => (
                <>
                  <div>{l.worstNight.loss > 0 ? `−${usd(l.worstNight.loss, 0)}` : usd(0, 0)}</div>
                  <div className="text-xs text-muted">cover pays {usd(l.worstNight.protectionPays, 0)}</div>
                </>
              ),
            },
            {
              label: "Protect until the open",
              numeric: true,
              cell: (l) =>
                "premium" in l.tonight ? (
                  <>
                    <div>{usd(l.tonight.premium)}</div>
                    <div className="text-xs text-muted">pays up to {usd(l.tonight.maxPayout, 0)}</div>
                  </>
                ) : (
                  <div className="ml-auto max-w-56 text-xs whitespace-normal text-muted">{l.tonight.unavailable}</div>
                ),
            },
            {
              label: "Replayed",
              numeric: true,
              cell: (l) =>
                l.replay ? (
                  <>
                    <div>{Math.round(l.replay.paidPerDollar * 100)}¢ per $1</div>
                    <div className="text-xs text-muted">
                      paid {l.replay.paidNights} of {l.replay.nights}
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-muted">too few openings</div>
                ),
            },
            {
              label: "",
              phone: "corner",
              cell: (l) =>
                "premium" in l.tonight && l.rounded <= MAX_SHARES_PER_QUOTE ? (
                  <Link className="text-brass hover:underline" href={`/?symbol=${l.symbol}&shares=${l.rounded}`}>
                    Protect
                  </Link>
                ) : null,
            },
          ]}
        />
      </div>

      {report.skipped.length > 0 && (
        <p className="text-sm text-muted">Not in the report: {report.skipped.map((s) => `${s.symbol} (${s.reason})`).join("; ")}.</p>
      )}
      {report.wallet && (
        <p className="text-sm text-muted">
          From the wallet: {report.wallet.holdings.map((h) => `${Math.round(h.shares * 10_000) / 10_000} ${h.symbol}`).join(" and ") || "no TSLAx or TSLAon"}.
        </p>
      )}

      <div className="space-y-2 text-sm leading-relaxed text-faint">
        <p>
          Protection here starts {pct(deductible, 1)} and stops {pct(depth, 1)} below each stock&apos;s price{openTs ? `, until ${nyTime(openTs)}` : ""}. Each
          stock&apos;s openings{report.lines.length ? ` (since ${dayLabel(report.lines[0]!.history.from)} for ${report.lines[0]!.symbol})` : ""} are read the way it settles: Pyth&apos;s first print for TSLA and QQQ, Chainlink&apos;s round in force on Robinhood
          Chain for the rest. The worst opening is the worst close-to-open move on record, applied to today&apos;s price; adding them up assumes every stock
          has its worst night at once, which is a bound, not a forecast.
        </p>
        <p>
          Tonight&apos;s price is for the whole book, as an indication. One purchase covers at most {MAX_SHARES_PER_QUOTE.toLocaleString()} shares, and each
          vault&apos;s pool limits what it sells per night and per stock. &ldquo;Replayed&rdquo; prices the same protection on every past opening from only the
          ones before it: what it paid back per $1 of premium.
        </p>
      </div>

      <button type="button" onClick={onCopy} className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:border-brass hover:text-text">
        {copied ? "Link copied" : "Copy a link to this report"}
      </button>
    </section>
  );
}
