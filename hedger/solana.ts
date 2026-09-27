/**
 * The positions a Solana vault has sold and not yet settled, read from the
 * chain: vault v2's, and v1's while its last series waits for its open. Reads
 * only; the wallet Anchor asks for is a throwaway that never signs.
 */
import anchor from "@anchor-lang/core";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import { stockByFeedId } from "../quoter/stocks";
import * as v1 from "../solana/client/v1";
import * as v2 from "../solana/client/vault";
import type { SeriesState } from "../solana/keeper/plan";
import type { OpenPosition } from "./target";

export type SeriesRecord = { address: string; feedId: string; openTs: number; state: SeriesState };

/** A position as stored: shares with 6 decimals, strikes with 8. v1 closes a claimed position's account, so it has no flag. */
export type PositionRecord = { series: string; shares: bigint; upper: bigint; lower: bigint; closed?: boolean };

const SHARE = 1e6;
const PRICE = 1e8;

/**
 * The positions still exposed: not paid out, in a series not yet settled or
 * voided. Each is named by its stock (the feed id when the registry doesn't
 * know it, so nothing unknown is hedged as something else).
 */
export function openPositions(series: readonly SeriesRecord[], positions: readonly PositionRecord[]): OpenPosition[] {
  const open = new Map(series.filter((s) => s.state === "open").map((s) => [s.address, s]));
  return positions.flatMap((p) => {
    const s = open.get(p.series);
    if (!s || p.closed) return [];
    return [{ symbol: stockByFeedId(s.feedId)?.symbol ?? s.feedId, openTs: s.openTs, shares: Number(p.shares) / SHARE, upper: Number(p.upper) / PRICE, lower: Number(p.lower) / PRICE }];
  });
}

export type VaultVersion = "v1" | "v2";

type Big = { toString(): string };
/** The fields read here, which both versions' accounts share (v2's position adds `closed`). */
type Accounts = {
  series: { all(filters: { memcmp: { offset: number; bytes: string } }[]): Promise<{ publicKey: PublicKey; account: { feedId: number[]; openTs: Big; state: object } }[]> };
  position: { all(filters: { memcmp: { offset: number; bytes: string } }[]): Promise<{ account: { series: PublicKey; shares: Big; upper: Big; lower: Big; closed?: boolean } }[]> };
};

/** Every series and position of the vault at `deployment`, with the program checked against the client's. */
export async function readVault(connection: Connection, version: VaultVersion, deployment: { programId: string; vault: string }): Promise<{ series: SeriesRecord[]; positions: PositionRecord[] }> {
  const client = version === "v1" ? v1 : v2;
  if (client.PROGRAM_ID.toBase58() !== deployment.programId) {
    throw new Error(`the ${version} deployment's program ${deployment.programId} isn't the ${version} client's ${client.PROGRAM_ID.toBase58()}`);
  }
  const accounts: Accounts = client.getProgram(connection, new anchor.Wallet(Keypair.generate())).account;
  // Both versions' series and positions start with their vault's address.
  const byVault = [{ memcmp: { offset: 8, bytes: new PublicKey(deployment.vault).toBase58() } }];
  const [series, positions] = await Promise.all([accounts.series.all(byVault), accounts.position.all(byVault)]);
  return {
    series: series.map((s) => ({
      address: s.publicKey.toBase58(),
      feedId: "0x" + Buffer.from(s.account.feedId).toString("hex"),
      openTs: Number(s.account.openTs.toString()),
      state: Object.keys(s.account.state)[0] as SeriesState,
    })),
    positions: positions.map((p) => ({
      series: p.account.series.toBase58(),
      shares: BigInt(p.account.shares.toString()),
      upper: BigInt(p.account.upper.toString()),
      lower: BigInt(p.account.lower.toString()),
      ...(p.account.closed !== undefined && { closed: p.account.closed }),
    })),
  };
}
