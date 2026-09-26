import { Connection, PublicKey } from "@solana/web3.js";

import { getProgram, parseVaultEvents, seriesAddress } from "@root/solana/client/v1";
import type { SeriesState } from "@root/solana/keeper/plan";

import { readOnly, RPC, vaultState } from "./chain";
import { SOLANA_DEPLOYMENT } from "./deployment";

/** Every series a vault has sold, with what it took in and what it paid out. */
export type LedgerRow = {
  chain: "solana" | "robinhood";
  series: string;
  symbol: string;
  openTs: number;
  state: SeriesState;
  /** Settlement price in dollars, and when the oracle published it. */
  price: number | null;
  priceTime: number | null;
  settleTx: string | null;
  sales: number;
  premiums: number;
  maxPayouts: number;
  /** Paid to buyers so far: payouts, or premiums refunded if the series voided. */
  paid: number;
  claims: number;
};

/**
 * The Solana vault's ledger. Claimed positions are closed accounts, so sales
 * and payouts come from the program's events in the vault's transactions,
 * read once each and accumulated, and series state from the series accounts.
 */
const acc = {
  newest: undefined as string | undefined,
  bought: new Map<string, { series: string; premium: bigint; maxPayout: bigint }>(),
  paid: new Map<string, bigint>(),
  settleTx: new Map<string, string>(),
};

const TTL_MS = 60_000;
let cache: { at: number; rows: Promise<LedgerRow[]> } | null = null;

export function solanaLedger(): Promise<LedgerRow[]> {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const rows = load();
    cache = { at: Date.now(), rows };
    rows.catch(() => (cache = null));
  }
  return cache.rows;
}

async function load(): Promise<LedgerRow[]> {
  const connection = new Connection(RPC, "confirmed");
  const program = getProgram(connection, readOnly);
  const vault = new PublicKey(SOLANA_DEPLOYMENT.vault);

  // Signatures newer than the last we read, newest first.
  const fresh: string[] = [];
  for (let before: string | undefined; ; ) {
    const page = await connection.getSignaturesForAddress(vault, { before, until: acc.newest, limit: 1000 });
    fresh.push(...page.filter((s) => !s.err).map((s) => s.signature));
    if (page.length < 1000) break;
    before = page[page.length - 1]!.signature;
  }
  // Oldest first, a few at a time, so the public RPC doesn't rate-limit us.
  const ordered = [...fresh].reverse();
  const txs = [];
  for (let i = 0; i < ordered.length; i += 4) {
    const batch = ordered.slice(i, i + 4);
    txs.push(...(await Promise.all(batch.map((sig) => connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).then((tx) => ({ sig, tx }))))));
  }
  for (const { sig, tx } of txs) {
    for (const e of parseVaultEvents(program, tx?.meta?.logMessages ?? [])) {
      if (e.name === "protectionBought") {
        const series = seriesAddress(vault, Uint8Array.from(e.data.feedId), BigInt(e.data.openTs.toString())).toBase58();
        acc.bought.set(e.data.position.toBase58(), { series, premium: BigInt(e.data.premium.toString()), maxPayout: BigInt(e.data.maxPayout.toString()) });
      } else if (e.name === "seriesSettled") {
        acc.settleTx.set(e.data.series.toBase58(), sig);
      } else if (e.name === "claimed") {
        acc.paid.set(e.data.position.toBase58(), BigInt(e.data.amount.toString()));
      }
    }
  }
  if (fresh[0]) acc.newest = fresh[0];

  const [v, state] = await Promise.all([program.account.vault.fetch(vault), vaultState()]);
  const unit = Number(v.collateralUnit.toString());
  return state.series.map((s) => {
    const sales = [...acc.bought.entries()].filter(([, b]) => b.series === s.address);
    const paid = sales.map(([position]) => acc.paid.get(position)).filter((x) => x !== undefined);
    return {
      chain: "solana",
      series: s.address,
      symbol: s.symbol,
      openTs: s.openTs,
      state: s.state,
      price: s.price,
      priceTime: s.publishTime,
      settleTx: acc.settleTx.get(s.address) ?? null,
      sales: sales.length,
      premiums: sales.reduce((t, [, b]) => t + Number(b.premium), 0) / unit,
      maxPayouts: sales.reduce((t, [, b]) => t + Number(b.maxPayout), 0) / unit,
      paid: paid.reduce((t, x) => t + Number(x), 0) / unit,
      claims: paid.length,
    };
  });
}
