import { readFileSync } from "node:fs";
import { join } from "node:path";

import anchor from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import type { Opening } from "../pricing/model";
import { hedgeShares } from "../pricing/putSpread";
import { modelFor } from "../quoter/quoter";
import { QQQ, TSLA } from "../quoter/stocks";
import * as v2 from "../solana/client/vault";
import type { Post } from "./info";
import { readHedgeState, summarize, type ModelInputs } from "./state";
import { fakeCluster } from "./testing";

const { BN } = anchor;
const NOW = 1_790_000_000;
const OPEN = NOW + 3600;
const history: Opening[] = JSON.parse(readFileSync(join(import.meta.dirname, "..", "research", "data", "pyth-tsla-gaps.json"), "utf8")).gaps;
const inputs: ModelInputs = { history, annualVol: 0.6, holidays: new Set(), earlyCloses: new Map() };
const ACCOUNT = "0x000000000000000000000000000000000000dEaD";

/** A v2 vault on a fake cluster: an open TSLA series with one live and one paid position, and an open QQQ series with one. */
async function cluster() {
  const c = v2.getProgram(fakeCluster([]), new anchor.Wallet(Keypair.generate())).coder.accounts;
  const vault = Keypair.generate().publicKey;
  const key = () => Keypair.generate().publicKey;
  const feed = (id: string) => Array.from(Buffer.from(id.slice(2), "hex"));
  const series = (feedId: string) =>
    c.encode("series", { vault, feedId: feed(feedId), openTs: new BN(OPEN), state: { open: {} }, price: new BN(0), publishTime: new BN(0), lowestLower: new BN(1), highestUpper: new BN(1), locked: new BN(0), sold: 1, paid: 0, bump: 255 });
  const position = (s: PublicKey, shares: number, upper: number, lower: number, closed: boolean) =>
    c.encode("position", {
      vault, series: s, buyer: key(), mint: key(), nonce: Array(32).fill(1), number: new BN(1),
      shares: new BN(shares * 1e6), upper: new BN(Math.round(upper * 1e8)), lower: new BN(Math.round(lower * 1e8)), premium: new BN(1), maxPayout: new BN(1), tip: new BN(0),
      closed, paid: new BN(0), paidTo: PublicKey.default, bump: 254, mintBump: 253,
    });
  const tsla = key();
  const qqq = key();
  const connection = fakeCluster([
    { owner: v2.PROGRAM_ID, pubkey: tsla, data: await series(TSLA.feedId) },
    { owner: v2.PROGRAM_ID, pubkey: qqq, data: await series(QQQ.feedId) },
    { owner: v2.PROGRAM_ID, pubkey: key(), data: await position(tsla, 2, 370, 340, false) },
    { owner: v2.PROGRAM_ID, pubkey: key(), data: await position(tsla, 5, 370, 340, true) },
    { owner: v2.PROGRAM_ID, pubkey: key(), data: await position(qqq, 10, 600, 550, false) },
  ]);
  return { connection, vault: vault.toBase58() };
}

const info: Post = async (_network, body) => {
  if (body.type === "perpDexs") return [null, { name: "test" }, { name: "xyz" }];
  if (body.type === "meta") return { universe: [{ name: "xyz:NVDA", szDecimals: 3, maxLeverage: 10 }, { name: "xyz:TSLA", szDecimals: 3, maxLeverage: 10 }] };
  if (body.type === "clearinghouseState") {
    const position = { coin: "xyz:TSLA", szi: "-0.25", entryPx: "371.0", unrealizedPnl: "0.1", liquidationPx: "480.0", marginUsed: "31.0", leverage: { type: "isolated", value: 3 } };
    return { marginSummary: { accountValue: "500.0" }, withdrawable: "469.0", assetPositions: [{ position }] };
  }
  throw new Error(`nothing recorded for ${String(body.type)}`);
};

describe("readHedgeState", () => {
  it("sizes the hedge from every open position the vaults hold, against the account's short", async () => {
    const { connection, vault } = await cluster();
    const st = await readHedgeState({
      stock: TSLA,
      vaults: [{ label: "Solana v2", version: "v2", connection, deployment: { programId: v2.PROGRAM_ID.toBase58(), vault } }],
      network: "testnet",
      address: ACCOUNT,
      maxNotional: 1500,
      model: async () => inputs,
      post: info,
      mid: async () => 372,
      now: NOW,
    });
    // The paid position no longer counts; QQQ's is read but not hedged in TSLA.
    expect(st.books).toEqual([{ label: "Solana v2", vault, positions: [expect.objectContaining({ symbol: "TSLA", shares: 2 }), expect.objectContaining({ symbol: "QQQ", shares: 10 })] }]);
    const hedge = hedgeShares(modelFor(NOW, OPEN, inputs), 372, { shares: 2, upper: 370, lower: 340 });
    expect(st.plan.exposure.hedge).toBeCloseTo(hedge, 12);
    expect(st.plan.current).toBe(0.25);
    expect(st.market.asset).toBe(120_001);

    const summary = summarize(st, TSLA, "testnet", 1500);
    expect(summary).toMatchObject({
      symbol: "TSLA",
      coin: "xyz:TSLA",
      network: "testnet",
      mid: 372,
      vaults: [{ label: "Solana v2", vault, positions: 2 }],
      target: Number(hedge.toFixed(3)),
      capped: false,
      account: { address: ACCOUNT, accountValue: 500, position: { short: 0.25 } },
      notHedged: [{ symbol: "QQQ", positions: 1 }],
    });
    expect(summary.opens).toEqual([{ openTs: OPEN, positions: 1, shares: 2, maxPayout: 60, hedge: st.plan.exposure.hedge }]);
    // Plain JSON, so the route can send it as it is.
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  it("with no account, takes the short held as none and reads no account", async () => {
    const asked: string[] = [];
    const post: Post = (network, body) => {
      asked.push(String(body.type));
      return info(network, body);
    };
    const st = await readHedgeState({ stock: TSLA, vaults: [], network: "testnet", address: null, maxNotional: 1500, model: async () => inputs, post, mid: async () => 372, now: NOW });
    expect(st.account).toBeNull();
    expect(st.plan.exposure.opens).toEqual([]);
    expect(asked.sort()).toEqual(["meta", "perpDexs"]);
  });
});
