import { Connection, PublicKey } from "@solana/web3.js";

import { stockByFeedId } from "@root/quoter/stocks";
import * as v1 from "@root/solana/client/v1";
import { getProgram, parseVaultEvents } from "@root/solana/client/vault";
import type { SeriesState } from "@root/solana/keeper/plan";

import { readOnly, RPC, solanaVaultState } from "./chain";
import { SOLANA_V1_DEPLOYMENT, type SolanaDeployment } from "./deployment";

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

const TTL_MS = 60_000;
let cache: { at: number; rows: Promise<LedgerRow[]> } | null = null;

/** The Solana ledger: vault v2's, and vault v1's before it, once retired. */
export function solanaLedger(): Promise<LedgerRow[]> {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const rows = Promise.all([v2Ledger(), SOLANA_V1_DEPLOYMENT ? v1Ledger(SOLANA_V1_DEPLOYMENT) : []]).then(([a, b]) => [...a, ...b]);
    cache = { at: Date.now(), rows };
    rows.catch(() => (cache = null));
  }
  return cache.rows;
}

/**
 * A vault's transactions since the last read, oldest first, fetched a few at
 * a time so the public RPC doesn't rate-limit us. `cursor` keeps the newest
 * signature read.
 */
async function newTransactions(connection: Connection, vault: PublicKey, cursor: { newest?: string }) {
  const fresh: string[] = [];
  for (let before: string | undefined; ; ) {
    const page = await connection.getSignaturesForAddress(vault, { before, until: cursor.newest, limit: 1000 });
    fresh.push(...page.filter((s) => !s.err).map((s) => s.signature));
    if (page.length < 1000) break;
    before = page[page.length - 1]!.signature;
  }
  const ordered = [...fresh].reverse();
  const txs: { sig: string; logs: string[] }[] = [];
  for (let i = 0; i < ordered.length; i += 4) {
    const batch = ordered.slice(i, i + 4);
    const read = batch.map((sig) =>
      connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).then((tx) => ({ sig, logs: tx?.meta?.logMessages ?? [] })),
    );
    txs.push(...(await Promise.all(read)));
  }
  if (fresh[0]) cursor.newest = fresh[0];
  return txs;
}

/** Vault v2's settle transactions, read from its events as they come. */
const v2Settles = { cursor: {} as { newest?: string }, tx: new Map<string, string>() };

async function v2Ledger(): Promise<LedgerRow[]> {
  const state = solanaVaultState();
  if (!state) return [];
  const s = await state;
  // Read only while a settled series' transaction is still unknown.
  if (s.ledger.some((r) => r.state === "settled" && !v2Settles.tx.has(r.series))) {
    const connection = new Connection(RPC, "confirmed");
    const program = getProgram(connection, readOnly);
    for (const { sig, logs } of await newTransactions(connection, new PublicKey(s.vault), v2Settles.cursor)) {
      for (const e of parseVaultEvents(program, logs)) if (e.name === "seriesSettled") v2Settles.tx.set(e.data.series.toBase58(), sig);
    }
  }
  return s.ledger.map((r) => ({ ...r, settleTx: v2Settles.tx.get(r.series) ?? null }));
}

/**
 * Vault v1's ledger. A claimed v1 position is a closed account, so its sales
 * and payouts come from the program's events, read once each and accumulated,
 * and series state from the series accounts. Read from v1's own cluster.
 */
const v1Acc = {
  cursor: {} as { newest?: string },
  bought: new Map<string, { series: string; premium: bigint; maxPayout: bigint }>(),
  paid: new Map<string, bigint>(),
  settleTx: new Map<string, string>(),
};

async function v1Ledger(d: SolanaDeployment): Promise<LedgerRow[]> {
  const connection = new Connection(d.rpc, "confirmed");
  const program = v1.getProgram(connection, readOnly);
  const vault = new PublicKey(d.vault);
  for (const { sig, logs } of await newTransactions(connection, vault, v1Acc.cursor)) {
    for (const e of v1.parseVaultEvents(program, logs)) {
      if (e.name === "protectionBought") {
        const series = v1.seriesAddress(vault, Uint8Array.from(e.data.feedId), BigInt(e.data.openTs.toString())).toBase58();
        v1Acc.bought.set(e.data.position.toBase58(), { series, premium: BigInt(e.data.premium.toString()), maxPayout: BigInt(e.data.maxPayout.toString()) });
      } else if (e.name === "seriesSettled") {
        v1Acc.settleTx.set(e.data.series.toBase58(), sig);
      } else if (e.name === "claimed") {
        v1Acc.paid.set(e.data.position.toBase58(), BigInt(e.data.amount.toString()));
      }
    }
  }

  const [v, series] = await Promise.all([program.account.vault.fetch(vault), program.account.series.all([{ memcmp: { offset: 8, bytes: vault.toBase58() } }])]);
  const unit = Number(v.collateralUnit.toString());
  return series.map(({ publicKey, account: s }) => {
    const address = publicKey.toBase58();
    const state = Object.keys(s.state)[0] as SeriesState;
    const feed = Buffer.from(s.feedId).toString("hex");
    const sales = [...v1Acc.bought.entries()].filter(([, b]) => b.series === address);
    const paid = sales.map(([position]) => v1Acc.paid.get(position)).filter((x) => x !== undefined);
    return {
      chain: "solana",
      series: address,
      symbol: stockByFeedId(feed)?.symbol ?? `0x${feed.slice(0, 8)}`,
      openTs: s.openTs.toNumber(),
      state,
      price: state === "settled" ? Number(s.price.toString()) / 1e8 : null,
      priceTime: state === "settled" ? s.publishTime.toNumber() : null,
      settleTx: v1Acc.settleTx.get(address) ?? null,
      sales: sales.length,
      premiums: sales.reduce((t, [, b]) => t + Number(b.premium), 0) / unit,
      maxPayouts: sales.reduce((t, [, b]) => t + Number(b.maxPayout), 0) / unit,
      paid: paid.reduce((t, x) => t + Number(x), 0) / unit,
      claims: paid.length,
    };
  });
}
