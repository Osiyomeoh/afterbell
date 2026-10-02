"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { fetchHistory, type HistoryRow } from "@/lib/api";
import { nyTime, usd } from "@/lib/format";
import { sharePath } from "@/lib/share";

import { DataTable } from "../DataTable";

/** Everything a wallet bought on one chain, paid out or not, each linking to its position page. */
export function History({ owner }: { owner: string }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchHistory(owner).then((r) => setRows(r.history), (e: Error) => setError(e.message));
  }, [owner]);

  if (error) return <p className="mt-3 text-sm text-loss">Couldn&apos;t load your history: {error}</p>;
  if (!rows || rows.length === 0) return null;
  const won = rows.filter((h) => h.paid !== null && h.paid > 0 && h.openTs * 1000 > Date.now() - 7 * 86_400_000);
  return (
    <div className="mt-6">
      {won.length > 0 && (
        <p className="mb-3 rounded-lg border border-gain/40 px-4 py-3 text-sm">
          Paid out this week: <span className="text-gain">{usd(won.reduce((t, h) => t + h.paid!, 0))}</span> on {won.map((h) => h.symbol).join(", ")}, sent to your wallet.
        </p>
      )}
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-muted">History</h3>
        <button type="button" onClick={() => downloadCsv(rows)} className="text-xs text-muted hover:underline">
          Export CSV
        </button>
      </div>
      <div className="overflow-hidden rounded-2xl border border-line bg-surface">
        <DataTable
          rows={rows}
          rowKey={(h) => h.address}
          columns={[
            {
              label: "Stock",
              phone: "title",
              cell: (h) => (
                <>
                  <Link href={sharePath(h.chain, h.address)} className="hover:underline">
                    {h.symbol}
                  </Link>
                  {h.renewed && <span className="ml-2 text-xs text-muted">renewed</span>}
                </>
              ),
            },
            { label: "Open", cell: (h) => nyTime(h.openTs) },
            { label: "Paid", numeric: true, cell: (h) => <Tx href={h.buyTx}>{usd(h.premium)}</Tx> },
            { label: "Received", numeric: true, phone: "corner", cell: (h) => <Tx href={h.payTx}><Outcome h={h} /></Tx> },
          ]}
        />
      </div>
    </div>
  );
}

function Outcome({ h }: { h: HistoryRow }) {
  if (h.paid === null) return <span className="text-muted">{h.state === "open" ? "Open" : "Unclaimed"}</span>;
  if (h.forfeited) return <span className="text-muted">Forfeited</span>;
  return <span className={h.paid > 0 ? "text-gain" : "text-muted"}>{h.paid > 0 ? usd(h.paid) : "No payout"}</span>;
}

function Tx({ href, children }: { href: string | null; children: React.ReactNode }) {
  if (!href) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="hover:underline" title="View the transaction">
      {children}
    </a>
  );
}

function downloadCsv(rows: HistoryRow[]) {
  const head = ["chain", "position", "symbol", "open", "state", "premium", "received", "forfeited", "renewed", "buy_tx", "payout_tx"];
  const lines = rows.map((h) =>
    [h.chain, h.address, h.symbol, new Date(h.openTs * 1000).toISOString(), h.state, h.premium, h.paid ?? "", h.forfeited, h.renewed, h.buyTx ?? "", h.payTx ?? ""].join(","),
  );
  const url = URL.createObjectURL(new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `afterbell-history-${rows[0]!.chain}.csv` });
  a.click();
  URL.revokeObjectURL(url);
}
