import { describe, expect, it } from "vitest";

import type { Network } from "./hyperliquid";
import { dexOf, fetchHedgeAccount, fetchMarket, fetchOpenOrders, fetchTopOfBook, type Post } from "./info";

const ACCOUNT = "0x000000000000000000000000000000000000dEaD";

/** Answers as Hyperliquid's /info does (fields the hedger ignores included), and records each request. */
function fakeInfo(answers: Record<string, unknown>) {
  const asked: { network: Network; body: Record<string, unknown> }[] = [];
  const post: Post = async (network, body) => {
    asked.push({ network, body });
    const answer = answers[String(body.type)];
    if (answer === undefined) throw new Error(`nothing recorded for ${String(body.type)}`);
    return answer;
  };
  return { post, asked };
}

const position = (coin: string, szi: string) => ({
  type: "oneWay",
  position: {
    coin,
    szi,
    entryPx: "371.5",
    positionValue: "430.12",
    unrealizedPnl: "-0.35",
    returnOnEquity: "-0.0024",
    liquidationPx: "482.91",
    marginUsed: "143.37",
    maxLeverage: 10,
    leverage: { type: "isolated", value: 3, rawUsd: "573.49" },
    cumFunding: { allTime: "0.01", sinceOpen: "0.01", sinceChange: "0.01" },
  },
});

const state = (...positions: ReturnType<typeof position>[]) => ({
  marginSummary: { accountValue: "500.0", totalNtlPos: "430.12", totalRawUsd: "930.12", totalMarginUsed: "143.37" },
  crossMarginSummary: { accountValue: "0.0", totalNtlPos: "0.0", totalRawUsd: "0.0", totalMarginUsed: "0.0" },
  crossMaintenanceMarginUsed: "0.0",
  withdrawable: "356.63",
  assetPositions: positions,
  time: 1_790_000_000_000,
});

describe("dexOf", () => {
  it("reads the dex from a builder market's name, and none from Hyperliquid's own", () => {
    expect([dexOf("xyz:TSLA"), dexOf("BTC")]).toEqual(["xyz", ""]);
  });
});

describe("fetchMarket", () => {
  it("numbers the market from the network's own dex list", async () => {
    const { post, asked } = fakeInfo({
      perpDexs: [null, { name: "test" }, { name: "xyz", fullName: "XYZ", deployer: "0x0" }],
      meta: { universe: [{ name: "xyz:NVDA", szDecimals: 3, maxLeverage: 10 }, { name: "xyz:TSLA", szDecimals: 3, maxLeverage: 10, marginTableId: 10 }] },
    });
    expect(await fetchMarket(post, "testnet", "xyz:TSLA")).toEqual({ coin: "xyz:TSLA", asset: 120_001, szDecimals: 3, maxLeverage: 10 });
    expect(asked).toEqual([
      { network: "testnet", body: { type: "perpDexs" } },
      { network: "testnet", body: { type: "meta", dex: "xyz" } },
    ]);
  });
});

describe("fetchHedgeAccount", () => {
  it("reads the short from a negative size, asking for the coin's dex", async () => {
    const { post, asked } = fakeInfo({ clearinghouseState: state(position("xyz:NVDA", "2.0"), position("xyz:TSLA", "-1.157")) });
    expect(await fetchHedgeAccount(post, "testnet", ACCOUNT, "xyz:TSLA")).toEqual({
      address: ACCOUNT,
      accountValue: 500,
      withdrawable: 356.63,
      position: { short: 1.157, entryPx: 371.5, unrealizedPnl: -0.35, liquidationPx: 482.91, marginUsed: 143.37, leverage: { type: "isolated", value: 3 } },
    });
    expect(asked).toEqual([{ network: "testnet", body: { type: "clearinghouseState", user: ACCOUNT, dex: "xyz" } }]);
  });

  it("reads a long as a negative short, and no position as none", async () => {
    const long = await fetchHedgeAccount(fakeInfo({ clearinghouseState: state(position("xyz:TSLA", "0.5")) }).post, "testnet", ACCOUNT, "xyz:TSLA");
    expect(long.position?.short).toBe(-0.5);
    const none = await fetchHedgeAccount(fakeInfo({ clearinghouseState: state(position("xyz:NVDA", "-2.0")) }).post, "testnet", ACCOUNT, "xyz:TSLA");
    expect(none.position).toBeNull();
  });

  it("keeps a missing entry or liquidation price as null", async () => {
    const p = position("xyz:TSLA", "-1.0");
    const got = await fetchHedgeAccount(fakeInfo({ clearinghouseState: state({ ...p, position: { ...p.position, entryPx: null, liquidationPx: null } } as never) }).post, "mainnet", ACCOUNT, "xyz:TSLA");
    expect(got.position).toMatchObject({ entryPx: null, liquidationPx: null });
  });
});

describe("fetchOpenOrders", () => {
  it("lists the account's orders in the coin, from the coin's dex, sides and sizes read", async () => {
    const { post, asked } = fakeInfo({
      openOrders: [
        { coin: "xyz:TSLA", side: "B", limitPx: "373.26", sz: "5.0", oid: 101, timestamp: 1_790_000_000_000, origSz: "5.0" },
        { coin: "xyz:NVDA", side: "B", limitPx: "180.1", sz: "1.0", oid: 102, timestamp: 1_790_000_000_000, origSz: "1.0" },
        { coin: "xyz:TSLA", side: "A", limitPx: "373.42", sz: "3.84", oid: 103, timestamp: 1_790_000_000_000, origSz: "5.0" },
      ],
    });
    expect(await fetchOpenOrders(post, "testnet", ACCOUNT, "xyz:TSLA")).toEqual([
      { oid: 101, buy: true, px: 373.26, size: 5 },
      { oid: 103, buy: false, px: 373.42, size: 3.84 },
    ]);
    expect(asked).toEqual([{ network: "testnet", body: { type: "openOrders", user: ACCOUNT, dex: "xyz" } }]);
  });
});

describe("fetchTopOfBook", () => {
  it("reads the best bid and ask, and an empty side as none", async () => {
    // Testnet's xyz:TSLA book on 26 Sep: one stray bid, no asks.
    const { post, asked } = fakeInfo({
      l2Book: { coin: "xyz:TSLA", time: 1_790_000_000_000, levels: [[{ px: "389.78", sz: "0.081", n: 1 }, { px: "260.0", sz: "1.0", n: 1 }], []] },
    });
    expect(await fetchTopOfBook(post, "testnet", "xyz:TSLA")).toEqual({ bid: { px: 389.78, size: 0.081 }, ask: null });
    expect(asked).toEqual([{ network: "testnet", body: { type: "l2Book", coin: "xyz:TSLA" } }]);
  });
});
