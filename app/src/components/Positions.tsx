"use client";

import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useCallback, useEffect, useState } from "react";

import { fetchMarket, fetchPositions, type MarketResponse, type PositionRow } from "@/lib/api";
import { claimPosition } from "@/lib/claim";
import { claimOnRobinhood, evmTxUrl, useEvmWallet } from "@/lib/evm";
import { explorer, nyTime, usd } from "@/lib/format";

type Claimed = { key: string; url: string | null };

/** A wallet's protection on each chain, with a claim button once its series has settled or voided. */
export function Positions() {
  const [market, setMarket] = useState<MarketResponse | null>(null);
  useEffect(() => {
    fetchMarket().then(setMarket, () => {});
  }, []);

  return (
    <div className="space-y-10">
      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">Solana devnet</h2>
        {market?.solana ? (
          <SolanaPositions vault={{ vault: market.solana.vault, collateralMint: market.solana.collateralMint }} />
        ) : (
          <Panel>{market ? "The Solana vault v2 isn't deployed yet." : "Loading…"}</Panel>
        )}
      </section>
      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">Robinhood Chain</h2>
        {market?.robinhood ? (
          <RobinhoodPositions d={market.robinhood} />
        ) : (
          <Panel>{market ? "The Robinhood Chain vault isn't deployed yet." : "Loading…"}</Panel>
        )}
      </section>
    </div>
  );
}

function SolanaPositions({ vault }: { vault: { vault: string; collateralMint: string } }) {
  const wallet = useAnchorWallet();
  const { sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { setVisible } = useWalletModal();
  const [rows, setRows] = useState<PositionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<Claimed[]>([]);

  const load = useCallback(() => {
    if (!wallet) return;
    fetchPositions(wallet.publicKey.toBase58()).then((r) => setRows(r.positions), (e: Error) => setError(e.message));
  }, [wallet]);
  useEffect(load, [load]);

  if (!wallet) return <Connect onClick={() => setVisible(true)}>Connect the Solana wallet holding your protection.</Connect>;

  async function claim(p: PositionRow) {
    if (!wallet || !p.nftAccount) return;
    try {
      setClaiming(p.address);
      const sig = await claimPosition(connection, wallet, sendTransaction, { ...vault, series: p.series, position: p.address, nftAccount: p.nftAccount });
      setClaimed((c) => [...c, { key: p.address, url: explorer("tx", sig) }]);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setClaiming(null);
    }
  }
  return <PositionsTable rows={rows} error={error} claiming={claiming} claimed={claimed} onClaim={claim} />;
}

function RobinhoodPositions({ d }: { d: NonNullable<MarketResponse["robinhood"]> }) {
  const evm = useEvmWallet();
  const [rows, setRows] = useState<PositionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<Claimed[]>([]);

  const load = useCallback(() => {
    if (!evm.address) return;
    fetchPositions(evm.address).then((r) => setRows(r.positions), (e: Error) => setError(e.message));
  }, [evm.address]);
  useEffect(load, [load]);

  if (!evm.address) {
    return (
      <Connect onClick={() => evm.connect().catch((e: Error) => setError(e.message))} error={error}>
        Connect the EVM wallet you bought protection with.
      </Connect>
    );
  }

  async function claim(p: PositionRow) {
    if (!evm.address) return;
    try {
      setClaiming(p.address);
      const hash = await claimOnRobinhood(evm.address, d, BigInt(p.address));
      setClaimed((c) => [...c, { key: p.address, url: evmTxUrl(d, hash) }]);
      load();
    } catch (e) {
      const err = e as Error & { shortMessage?: string };
      setError(err.shortMessage ?? err.message);
    } finally {
      setClaiming(null);
    }
  }
  return <PositionsTable rows={rows} error={error} claiming={claiming} claimed={claimed} onClaim={claim} />;
}

function PositionsTable(props: { rows: PositionRow[] | null; error: string | null; claiming: string | null; claimed: Claimed[]; onClaim: (p: PositionRow) => void }) {
  const { error, claiming, claimed, onClaim } = props;
  // The server's read is cached for a few seconds, so drop what was just claimed here.
  const rows = props.rows?.filter((p) => !claimed.some((c) => c.key === p.address)) ?? null;
  if (error && !rows) return <Panel>Couldn&apos;t load your positions: {error}</Panel>;
  if (!rows) return <Panel>Loading…</Panel>;
  if (rows.length === 0 && claimed.length === 0) {
    return <Panel>No open protection. Positions disappear here once they&apos;re paid out; the payout goes straight to the wallet holding the NFT.</Panel>;
  }
  return (
    <div className="scroll-x rounded-2xl border border-line bg-surface">
      <table className="w-full text-sm whitespace-nowrap">
        <thead className="text-left text-muted">
          <tr className="border-b border-line">
            <th className="px-4 py-3 font-normal">Stock</th>
            <th className="px-4 py-3 font-normal">Settles</th>
            <th className="px-4 py-3 font-normal">Shares</th>
            <th className="px-4 py-3 font-normal">Protected</th>
            <th className="px-4 py-3 text-right font-normal">Cost</th>
            <th className="px-4 py-3 text-right font-normal">Pays up to</th>
            <th className="px-4 py-3 font-normal">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.address} className="border-b border-line last:border-0">
              <td className="px-4 py-3">
                {p.art ? (
                  <a className="flex items-center gap-3 hover:underline" href={p.art} target="_blank" rel="noreferrer" title="Its NFT: whoever holds it is paid">
                    <img src={p.art} alt={`${p.symbol} protection NFT`} className="h-12 w-auto rounded border border-line" />
                    {p.symbol}
                  </a>
                ) : (
                  p.symbol
                )}
              </td>
              <td className="px-4 py-3">{nyTime(p.openTs)}</td>
              <td className="num px-4 py-3">{p.shares}</td>
              <td className="num px-4 py-3">
                {usd(p.upper)} → {usd(p.lower)}
              </td>
              <td className="num px-4 py-3 text-right">{usd(p.premium)}</td>
              <td className="num px-4 py-3 text-right">{usd(p.maxPayout)}</td>
              <td className="px-4 py-3">
                <Status p={p} busy={claiming === p.address} onClaim={() => onClaim(p)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p className="border-t border-line px-4 py-3 text-sm text-loss">{error}</p>}
      {claimed.map((c) => (
        <p key={c.key} className="border-t border-line px-4 py-3 text-sm text-gain">
          Claimed.{" "}
          {c.url && (
            <a className="underline" href={c.url} target="_blank" rel="noreferrer">
              View transaction
            </a>
          )}
        </p>
      ))}
    </div>
  );
}

function Status({ p, busy, onClaim }: { p: PositionRow; busy: boolean; onClaim: () => void }) {
  if (p.state === "open") return <span className="text-muted">Open until the bell</span>;
  const label =
    p.state === "voided"
      ? `Voided: ${usd(p.claimable ?? 0)} back`
      : (p.claimable ?? 0) > 0
        ? `Opened ${usd(p.settlementPrice ?? 0)}: pays ${usd(p.claimable ?? 0)}`
        : `Opened ${usd(p.settlementPrice ?? 0)}: no payout`;
  return (
    <span className="flex items-center gap-3">
      <span className={(p.claimable ?? 0) > 0 ? "text-gain" : "text-muted"}>{label}</span>
      <button onClick={onClaim} disabled={busy} className="rounded-lg border border-line px-2.5 py-1 text-xs hover:border-brass disabled:opacity-40">
        {busy ? "Claiming…" : (p.claimable ?? 0) > 0 ? "Claim" : "Close"}
      </button>
    </span>
  );
}

function Connect({ children, onClick, error }: { children: React.ReactNode; onClick: () => void; error?: string | null }) {
  return (
    <Panel>
      <p className="text-muted">{children}</p>
      <button onClick={onClick} className="mt-4 rounded-xl bg-brass px-4 py-2.5 font-medium text-ink">
        Connect a wallet
      </button>
      {error && <p className="mt-3 text-sm text-loss">{error}</p>}
    </Panel>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-line bg-surface p-6">{children}</div>;
}
