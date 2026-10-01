/**
 * The positions a Solana vault has sold and not yet settled, read from the
 * chain: vault v2's, and v1's while its last series waits for its open. Reads
 * only; the wallet Anchor asks for refuses to sign.
 */
import { Connection, PublicKey } from "@solana/web3.js";

import { stockByFeedId } from "../quoter/stocks";
import * as v1 from "../solana/client/v1";
import * as v2 from "../solana/client/vault";
import type { SeriesState } from "../solana/keeper/plan";
import type { VaultSource } from "./state";
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
  return stillOpen(series, positions).map(({ s, p }) => ({ symbol: symbolOf(s), openTs: s.openTs, shares: Number(p.shares) / SHARE, upper: Number(p.upper) / PRICE, lower: Number(p.lower) / PRICE }));
}

/** A series with positions still open: how many, their shares, and the most they pay together. */
export type OpenSeries = { address: string; symbol: string; openTs: number; positions: number; shares: number; maxPayout: number };

/**
 * The same open positions as `openPositions`, by series, soonest open first,
 * so a page listing them counts what the hedge counts.
 */
export function openSeries(series: readonly SeriesRecord[], positions: readonly PositionRecord[]): OpenSeries[] {
  const out = new Map<string, OpenSeries>();
  for (const { s, p } of stillOpen(series, positions)) {
    const row = out.get(s.address) ?? { address: s.address, symbol: symbolOf(s), openTs: s.openTs, positions: 0, shares: 0, maxPayout: 0 };
    row.positions += 1;
    row.shares += Number(p.shares) / SHARE;
    row.maxPayout += ((Number(p.shares) / SHARE) * Number(p.upper - p.lower)) / PRICE;
    out.set(s.address, row);
  }
  return [...out.values()].sort((a, b) => a.openTs - b.openTs);
}

const symbolOf = (s: SeriesRecord) => stockByFeedId(s.feedId)?.symbol ?? s.feedId;

/** Each position not paid out, in a series not yet settled or voided, with its series. */
function stillOpen(series: readonly SeriesRecord[], positions: readonly PositionRecord[]): { s: SeriesRecord; p: PositionRecord }[] {
  const open = new Map(series.filter((s) => s.state === "open").map((s) => [s.address, s]));
  return positions.flatMap((p) => {
    const s = open.get(p.series);
    return s && !p.closed ? [{ s, p }] : [];
  });
}

export type VaultVersion = "v1" | "v2";

/** What Anchor takes as a wallet, for reading: it has no key and refuses to sign. */
const readOnly = {
  publicKey: PublicKey.default,
  signTransaction: () => Promise.reject(new Error("read-only")),
  signAllTransactions: () => Promise.reject(new Error("read-only")),
};

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
  const accounts: Accounts = client.getProgram(connection, readOnly).account;
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

/** A Solana vault, either version, as a source for the hedge. */
export function solanaVault(label: string, version: VaultVersion, connection: Connection, deployment: { programId: string; vault: string }): VaultSource {
  return {
    chain: "solana",
    label,
    vault: deployment.vault,
    read: async () => {
      const { series, positions } = await readVault(connection, version, deployment);
      return openPositions(series, positions);
    },
  };
}
