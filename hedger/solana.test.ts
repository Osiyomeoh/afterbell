import anchor from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { QQQ, TSLA } from "../quoter/stocks";
import * as v1 from "../solana/client/v1";
import * as v2 from "../solana/client/vault";
import { openPositions, readVault, type PositionRecord, type SeriesRecord } from "./solana";
import { fakeCluster } from "./testing";

const OPEN = 1_790_000_000;
const series: SeriesRecord[] = [
  { address: "tsla-open", feedId: TSLA.feedId, openTs: OPEN, state: "open" },
  { address: "tsla-settled", feedId: TSLA.feedId, openTs: OPEN - 86_400, state: "settled" },
  { address: "tsla-voided", feedId: TSLA.feedId, openTs: OPEN - 86_400, state: "voided" },
  // Stored without 0x and in upper case: still QQQ.
  { address: "qqq-open", feedId: QQQ.feedId.slice(2).toUpperCase(), openTs: OPEN, state: "open" },
  { address: "unknown-open", feedId: "0x" + "ab".repeat(32), openTs: OPEN, state: "open" },
];
// 1.5 shares protected from $370.32 down to $340.09, as the vault stores them.
const position = (s: string, extra: Partial<PositionRecord> = {}): PositionRecord => ({ series: s, shares: 1_500_000n, upper: 37_032_000_000n, lower: 34_009_000_000n, ...extra });

describe("openPositions", () => {
  it("turns stored units into shares and dollars, named by the stock", () => {
    expect(openPositions(series, [position("tsla-open")])).toEqual([{ symbol: "TSLA", openTs: OPEN, shares: 1.5, upper: 370.32, lower: 340.09 }]);
  });

  it("keeps only positions in series still open, and not paid out", () => {
    const got = openPositions(series, [
      position("tsla-open"),
      position("tsla-open", { closed: true }),
      position("tsla-open", { closed: false }),
      position("tsla-settled"),
      position("tsla-voided"),
      position("no-such-series"),
    ]);
    expect(got).toHaveLength(2);
  });

  it("names each by its own feed, and an unknown feed by its id, so it's never hedged as another stock", () => {
    const got = openPositions(series, [position("qqq-open"), position("unknown-open")]);
    expect(got.map((p) => p.symbol)).toEqual(["QQQ", "0x" + "ab".repeat(32)]);
  });
});

describe("readVault", () => {
  const { BN } = anchor;
  const ours = Keypair.generate().publicKey;
  const theirs = Keypair.generate().publicKey;
  const feedId = Array.from(Buffer.from(TSLA.feedId.slice(2), "hex"));
  const key = () => Keypair.generate().publicKey;
  const coder = (client: typeof v1 | typeof v2) => client.getProgram(fakeCluster([]), new anchor.Wallet(Keypair.generate())).coder.accounts;

  it("decodes v2's series and positions, only this vault's, with v2's closed flag", async () => {
    const c = coder(v2);
    const series = (vault: PublicKey) =>
      c.encode("series", { vault, feedId, openTs: new BN(OPEN), state: { open: {} }, price: new BN(0), publishTime: new BN(0), lowestLower: new BN(34_009_000_000), highestUpper: new BN(37_032_000_000), locked: new BN(0), sold: 2, paid: 0, bump: 255 });
    const position = (vault: PublicKey, s: PublicKey, closed: boolean) =>
      c.encode("position", {
        vault, series: s, buyer: key(), mint: key(), nonce: Array(32).fill(7), number: new BN(1),
        shares: new BN(1_500_000), upper: new BN(37_032_000_000), lower: new BN(34_009_000_000), premium: new BN(2_000_000),
        maxPayout: new BN(45_345_000), tip: new BN(40_000), closed, paid: new BN(0), paidTo: PublicKey.default, bump: 254, mintBump: 253,
      });
    const s1 = key();
    const cluster = fakeCluster([
      { owner: v2.PROGRAM_ID, pubkey: s1, data: await series(ours) },
      { owner: v2.PROGRAM_ID, pubkey: key(), data: await position(ours, s1, false) },
      { owner: v2.PROGRAM_ID, pubkey: key(), data: await position(ours, s1, true) },
      { owner: v2.PROGRAM_ID, pubkey: key(), data: await series(theirs) },
      { owner: v2.PROGRAM_ID, pubkey: key(), data: await position(theirs, s1, false) },
    ]);
    const got = await readVault(cluster, "v2", { programId: v2.PROGRAM_ID.toBase58(), vault: ours.toBase58() });
    expect(got.series).toEqual([{ address: s1.toBase58(), feedId: TSLA.feedId, openTs: OPEN, state: "open" }]);
    expect(got.positions).toEqual([
      { series: s1.toBase58(), shares: 1_500_000n, upper: 37_032_000_000n, lower: 34_009_000_000n, closed: false },
      { series: s1.toBase58(), shares: 1_500_000n, upper: 37_032_000_000n, lower: 34_009_000_000n, closed: true },
    ]);
    expect(openPositions(got.series, got.positions)).toEqual([{ symbol: "TSLA", openTs: OPEN, shares: 1.5, upper: 370.32, lower: 340.09 }]);
  });

  it("decodes v1's accounts, which have no closed flag", async () => {
    const c = coder(v1);
    const s1 = key();
    const cluster = fakeCluster([
      { owner: v1.PROGRAM_ID, pubkey: s1, data: await c.encode("series", { vault: ours, feedId, openTs: new BN(OPEN), state: { settled: {} }, price: new BN(36_000_000_000), publishTime: new BN(OPEN + 1), bump: 255 }) },
      {
        owner: v1.PROGRAM_ID,
        pubkey: key(),
        data: await c.encode("position", { vault: ours, series: s1, buyer: key(), nonce: Array(32).fill(1), shares: new BN(3_000_000), upper: new BN(36_415_000_000), lower: new BN(33_500_000_000), premium: new BN(1), maxPayout: new BN(1), bump: 254 }),
      },
    ]);
    const got = await readVault(cluster, "v1", { programId: v1.PROGRAM_ID.toBase58(), vault: ours.toBase58() });
    expect(got.series).toEqual([{ address: s1.toBase58(), feedId: TSLA.feedId, openTs: OPEN, state: "settled" }]);
    expect(got.positions).toEqual([{ series: s1.toBase58(), shares: 3_000_000n, upper: 36_415_000_000n, lower: 33_500_000_000n }]);
    // Settled, so no longer exposed.
    expect(openPositions(got.series, got.positions)).toEqual([]);
  });

  it("refuses a deployment whose program isn't the client's", async () => {
    await expect(readVault(fakeCluster([]), "v1", { programId: v2.PROGRAM_ID.toBase58(), vault: ours.toBase58() })).rejects.toThrow(/isn't the v1 client's/);
  });
});
