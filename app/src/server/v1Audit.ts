/**
 * Vault v1's positions for the audit. Its claimed positions are closed
 * accounts and its events carry no strikes, so each position's terms come from
 * the `buy` instruction in the transaction that opened it.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { stockByFeedId } from "@root/quoter/stocks";
import * as v1 from "@root/solana/client/v1";
import type { SeriesState } from "@root/solana/keeper/plan";
import { readOnly, rpcFor } from "./chain";
import { SOLANA_V1_LEDGER, type SolanaDeployment } from "./deployment";
import type { AuditRow } from "./vaultTypes";

type BuyArgs = { shares: { toString(): string }; upper: { toString(): string }; lower: { toString(): string } };

export async function v1AuditRows(d: SolanaDeployment): Promise<AuditRow[]> {
  if (SOLANA_V1_LEDGER?.vault !== d.vault) return [];
  const connection = new Connection(rpcFor(d), "confirmed");
  const program = v1.getProgram(connection, readOnly);
  const ledger = v1.v1LedgerFromJson(SOLANA_V1_LEDGER);
  const v = await program.account.vault.fetch(new PublicKey(d.vault));
  const unit = Number(v.collateralUnit.toString());
  const seriesIds = [...new Set([...ledger.bought.values()].map((b) => b.series))];
  const fetched = await program.account.series.fetchMultiple(seriesIds.map((s) => new PublicKey(s)));
  const seriesAccounts = new Map(seriesIds.flatMap((id, i) => (fetched[i] ? [[id, fetched[i]] as const] : [])));

  const rows: AuditRow[] = [];
  for (const [position, b] of ledger.bought) {
    const s = seriesAccounts.get(b.series);
    if (!s) continue;
    const sigs = await connection.getSignaturesForAddress(new PublicKey(position), { limit: 1000 });
    const first = sigs.at(-1);
    if (!first) continue;
    const tx = await connection.getTransaction(first.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    const keys = tx?.transaction.message.getAccountKeys();
    let args: BuyArgs | null = null;
    for (const ix of tx?.transaction.message.compiledInstructions ?? []) {
      if (!keys?.get(ix.programIdIndex)?.equals(program.programId)) continue;
      const decoded = (program.coder.instruction as unknown as { decode(d: Buffer): { name: string; data: unknown } | null }).decode(Buffer.from(ix.data));
      if (decoded?.name === "buy") args = (decoded.data as { q: BuyArgs }).q;
    }
    if (!args) continue;
    const state = Object.keys(s.state)[0] as SeriesState;
    const feed = Buffer.from(s.feedId).toString("hex");
    const paid = ledger.paid.get(position);
    rows.push({
      address: position,
      series: b.series,
      symbol: stockByFeedId(feed)?.symbol ?? `0x${feed.slice(0, 8)}`,
      buyer: "",
      openTs: s.openTs.toNumber(),
      state,
      shares: Number(args.shares.toString()) / 1e6,
      upper: Number(args.upper.toString()) / 1e8,
      lower: Number(args.lower.toString()) / 1e8,
      premium: Number(b.premium) / unit,
      maxPayout: Number(b.maxPayout) / unit,
      claimable: null,
      settlementPrice: state === "settled" ? Number(s.price.toString()) / 1e8 : null,
      paid: paid === undefined ? null : Number(paid) / unit,
      forfeited: false,
    });
  }
  return rows;
}
