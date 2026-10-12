"use client";

import Link from "next/link";

import { svg } from "@root/solana/client/art";

import { type PositionRow } from "@/lib/api";
import { nyTime, usd } from "@/lib/format";
import { sharePath, type ShareView } from "@/lib/share";

import { DataTable } from "../DataTable";

/** A position marked claimed in this session, with its transaction. */
export type Claimed = { key: string; url: string | null };

export function PositionsTable(props: {
  chain: ShareView["chain"];
  rows: PositionRow[] | null;
  error: string | null;
  claiming: string | null;
  claimed: Claimed[];
  onClaim: (p: PositionRow) => void;
  /** Claim and repay a Kamino loan with the payout, where the vault pays in USDC. */
  onRepay?: (p: PositionRow) => void;
}) {
  const { error, claiming, claimed, onClaim, onRepay } = props;
  // The server's read is cached for a few seconds, so drop what was just claimed here.
  const rows =
    props.rows?.filter((p) => !claimed.some((c) => c.key === p.address)) ??
    null;
  if (error && !rows)
    return <Panel>Couldn&apos;t load your positions: {error}</Panel>;
  if (!rows) return <Panel>Loading…</Panel>;
  if (rows.length === 0 && claimed.length === 0) {
    return (
      <Panel>
        No open protection. Positions disappear here once they&apos;re paid out;
        the payout goes straight to the wallet holding the NFT.{" "}
        <Link href="/" className="text-brass hover:underline">
          Protect a stock
        </Link>
      </Panel>
    );
  }
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface">
      <DataTable
        rows={rows}
        rowKey={(p) => p.address}
        columns={[
          {
            label: "Stock",
            phone: "title",
            cell: (p) => (
              <>
                {p.art ? (
                  <a
                    className="flex items-center gap-3 hover:underline"
                    href={p.art}
                    target="_blank"
                    rel="noreferrer"
                    title="Its NFT: whoever holds it is paid"
                  >
                    <img
                      src={p.art}
                      alt={`${p.symbol} protection NFT`}
                      className="h-12 w-auto rounded border border-line"
                    />
                    {p.symbol}
                  </a>
                ) : (
                  p.symbol
                )}
                <Link
                  href={sharePath(props.chain, p.address)}
                  className="mt-1 block text-xs font-normal text-muted underline hover:text-text"
                >
                  Share
                </Link>
              </>
            ),
          },
          { label: "Settles", cell: (p) => nyTime(p.openTs) },
          { label: "Shares", numeric: true, cell: (p) => p.shares },
          {
            label: "Protected",
            numeric: true,
            cell: (p) => `${usd(p.upper)} → ${usd(p.lower)}`,
          },
          { label: "Cost", numeric: true, cell: (p) => usd(p.premium) },
          { label: "Pays up to", numeric: true, cell: (p) => usd(p.maxPayout) },
          {
            label: "Status",
            phone: "corner",
            cell: (p) => (
              <Status
                p={p}
                busy={claiming === p.address}
                onClaim={() => onClaim(p)}
                onRepay={onRepay && (() => onRepay(p))}
              />
            ),
          },
        ]}
      />
      {error && (
        <p className="border-t border-line px-4 py-3 text-sm text-loss">
          {error}
        </p>
      )}
      {claimed.map((c) => (
        <p
          key={c.key}
          className="border-t border-line px-4 py-3 text-sm text-gain"
        >
          Claimed.{" "}
          {c.url && (
            <a
              className="underline"
              href={c.url}
              target="_blank"
              rel="noreferrer"
            >
              View transaction
            </a>
          )}
        </p>
      ))}
    </div>
  );
}

export function Status({
  p,
  busy,
  onClaim,
  onRepay,
}: {
  p: PositionRow;
  busy: boolean;
  onClaim: () => void;
  onRepay?: () => void;
}) {
  if (p.state === "open")
    return <span className="text-muted">Open until the bell</span>;
  const label =
    p.state === "voided"
      ? `Voided: ${usd(p.claimable ?? 0)} back`
      : (p.claimable ?? 0) > 0
        ? `Opened ${usd(p.settlementPrice ?? 0)}: pays ${usd(p.claimable ?? 0)}`
        : `Opened ${usd(p.settlementPrice ?? 0)}: no payout`;
  return (
    <span className="flex items-center gap-3">
      <span className={(p.claimable ?? 0) > 0 ? "text-gain" : "text-muted"}>
        {label}
      </span>
      <button
        onClick={onClaim}
        disabled={busy}
        className="rounded-lg border border-line px-2.5 py-1 text-xs hover:border-brass disabled:opacity-40"
      >
        {busy ? "Claiming…" : (p.claimable ?? 0) > 0 ? "Claim" : "Close"}
      </button>
      {onRepay && (p.claimable ?? 0) > 0 && (
        <button
          onClick={onRepay}
          disabled={busy}
          title="Claim the payout and repay your USDC loan on Kamino with it, in one transaction"
          className="rounded-lg border border-line px-2.5 py-1 text-xs hover:border-brass disabled:opacity-40"
        >
          Repay Kamino
        </button>
      )}
    </span>
  );
}

/** What a position's NFT looks like, drawn by the same code as the real ones, with example numbers and marked as an example. */
export function ExampleCard({ nextOpen }: { nextOpen: number }) {
  const card = svg({
    number: 1n,
    symbol: "TSLA",
    openTs: BigInt(nextOpen),
    shares: 10_000_000n,
    upper: 36_460_000_000n,
    lower: 33_484_000_000n,
    premium: 8_610_000n,
    maxPayout: 297_600_000n,
    state: "open",
    price: 0n,
    payout: 0n,
    closed: false,
    forfeited: false,
  });
  return (
    <figure>
      <img
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(card)}`}
        alt="An example position NFT: 10 TSLA protected from $364.60 down to $334.84"
        className="w-full rounded-xl border border-line"
      />
      <figcaption className="mt-2 text-center text-xs text-faint">
        An example, with made-up numbers
      </figcaption>
    </figure>
  );
}

export function Connect({
  children,
  onClick,
  error,
}: {
  children: React.ReactNode;
  onClick: () => void;
  error?: string | null;
}) {
  return (
    <Panel>
      <p className="text-muted">{children}</p>
      <button
        onClick={onClick}
        className="mt-4 rounded-xl bg-brass px-4 py-2.5 font-medium text-ink"
      >
        Connect a wallet
      </button>
      {error && <p className="mt-3 text-sm text-loss">{error}</p>}
    </Panel>
  );
}

export function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-6">
      {children}
    </div>
  );
}
