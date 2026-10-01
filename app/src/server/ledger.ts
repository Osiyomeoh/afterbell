import { Connection, PublicKey } from "@solana/web3.js";

import { stockByFeedId } from "@root/quoter/stocks";
import * as v1 from "@root/solana/client/v1";
import type { SeriesState } from "@root/solana/keeper/plan";

import { readOnly, RPC, rpcFor, solanaVaultState } from "./chain";
import { SOLANA_V1_DEPLOYMENT, SOLANA_V1_LEDGER, type SolanaDeployment } from "./deployment";

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
let lastGood: LedgerRow[] | null = null;

/**
 * The Solana ledger: vault v2's, and vault v1's before it, once retired. A
 * refresh that fails (the public RPC rate-limits) serves the last one read.
 */
export function solanaLedger(): Promise<LedgerRow[]> {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const rows = Promise.all([v2Ledger(), SOLANA_V1_DEPLOYMENT ? v1Ledger(SOLANA_V1_DEPLOYMENT) : []]).then(
      ([a, b]) => (lastGood = [...a, ...b]),
      (e: unknown) => {
        // With nothing to show, let the next request try again; otherwise wait out the TTL.
        if (lastGood) return lastGood;
        cache = null;
        throw e;
      },
    );
    cache = { at: Date.now(), rows };
  }
  return cache.rows;
}

/**
 * A vault's transactions since the last read, oldest first, one at a time.
 * Devnet's public RPC answers only about ten getTransaction calls at a time
 * (28 Sep), so this is for the few new ones: v1's ledger starts from its
 * recorded file. `cursor` keeps the newest signature read.
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
  for (const sig of ordered) {
    const tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    txs.push({ sig, logs: tx?.meta?.logMessages ?? [] });
  }
  if (fresh[0]) cursor.newest = fresh[0];
  return txs;
}

/** Vault v2's settle transactions, found once each. */
const v2SettleTx = new Map<string, string>();

/**
 * The transaction that settled a series: the first to touch it at or after its
 * open, since buying stops at the open and paying out needs the settlement.
 * One call per series, rather than reading the vault's transactions.
 */
async function settleTxOf(connection: Connection, series: string, openTs: number): Promise<string | null> {
  const sigs = await connection.getSignaturesForAddress(new PublicKey(series), { limit: 1000 });
  const after = sigs.filter((s) => !s.err && s.blockTime != null && s.blockTime >= openTs);
  return after.length ? after[after.length - 1]!.signature : null;
}

async function v2Ledger(): Promise<LedgerRow[]> {
  const state = solanaVaultState();
  if (!state) return [];
  const s = await state;
  const unknown = s.ledger.filter((r) => r.state === "settled" && !v2SettleTx.has(r.series));
  if (unknown.length) {
    const connection = new Connection(RPC, "confirmed");
    for (const r of unknown) {
      // Only a link, so a failed read leaves it out (tried again next time) rather than failing the ledger.
      const sig = await settleTxOf(connection, r.series, r.openTs).catch(() => null);
      if (sig) v2SettleTx.set(r.series, sig);
    }
  }
  return s.ledger.map((r) => ({ ...r, settleTx: v2SettleTx.get(r.series) ?? null }));
}

/**
 * Vault v1's ledger. A claimed v1 position is a closed account, so its sales
 * and payouts come from the program's events: those recorded in
 * devnet-v1-ledger.json, then any newer ones, read once each and accumulated.
 * Series state comes from the series accounts.
 */
const v1Acc = { cursor: {} as { newest?: string }, ledger: v1.emptyV1Ledger(), seeded: false };

async function v1Ledger(d: SolanaDeployment): Promise<LedgerRow[]> {
  const connection = new Connection(rpcFor(d), "confirmed");
  const program = v1.getProgram(connection, readOnly);
  const vault = new PublicKey(d.vault);
  if (!v1Acc.seeded) {
    if (SOLANA_V1_LEDGER?.vault === d.vault) {
      v1Acc.ledger = v1.v1LedgerFromJson(SOLANA_V1_LEDGER);
      v1Acc.cursor.newest = SOLANA_V1_LEDGER.through;
    }
    v1Acc.seeded = true;
  }
  for (const { sig, logs } of await newTransactions(connection, vault, v1Acc.cursor)) v1.addV1Events(v1Acc.ledger, vault, sig, v1.parseVaultEvents(program, logs));
  const { bought, paid: paidOut, settleTx } = v1Acc.ledger;

  const [v, series] = await Promise.all([program.account.vault.fetch(vault), program.account.series.all([{ memcmp: { offset: 8, bytes: vault.toBase58() } }])]);
  const unit = Number(v.collateralUnit.toString());
  return series.map(({ publicKey, account: s }) => {
    const address = publicKey.toBase58();
    const state = Object.keys(s.state)[0] as SeriesState;
    const feed = Buffer.from(s.feedId).toString("hex");
    const sales = [...bought.entries()].filter(([, b]) => b.series === address);
    const paid = sales.map(([position]) => paidOut.get(position)).filter((x) => x !== undefined);
    return {
      chain: "solana",
      series: address,
      symbol: stockByFeedId(feed)?.symbol ?? `0x${feed.slice(0, 8)}`,
      openTs: s.openTs.toNumber(),
      state,
      price: state === "settled" ? Number(s.price.toString()) / 1e8 : null,
      priceTime: state === "settled" ? s.publishTime.toNumber() : null,
      settleTx: settleTx.get(address) ?? null,
      sales: sales.length,
      premiums: sales.reduce((t, [, b]) => t + Number(b.premium), 0) / unit,
      maxPayouts: sales.reduce((t, [, b]) => t + Number(b.maxPayout), 0) / unit,
      paid: paid.reduce((t, x) => t + Number(x), 0) / unit,
      claims: paid.length,
    };
  });
}
