import { describe, expect, it } from "vitest";

import type { Network } from "./hyperliquid";
import { dexOf, FILLS_PER_PAGE, FUNDING_PER_PAGE, fetchHedgeAccount, fetchHedgeActivity, fetchMarket, fetchOpenOrders, fetchTopOfBook, type Post } from "./info";

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
      unified: false,
    });
    expect(asked).toEqual([
      { network: "testnet", body: { type: "clearinghouseState", user: ACCOUNT, dex: "xyz" } },
      { network: "testnet", body: { type: "userAbstraction", user: ACCOUNT } },
    ]);
  });

  it("reads a unified account's USDC from its spot state, which backs every dex", async () => {
    const { post, asked } = fakeInfo({
      clearinghouseState: state(position("xyz:TSLA", "-1.157")),
      userAbstraction: "unifiedAccount",
      spotClearinghouseState: { balances: [{ coin: "USDC", token: 0, total: "498.0", hold: "143.37", entryNtl: "0.0" }, { coin: "USDH", token: 5, total: "0.0", hold: "0.0" }] },
    });
    const got = await fetchHedgeAccount(post, "testnet", ACCOUNT, "xyz:TSLA");
    expect(got).toMatchObject({ accountValue: 498, withdrawable: 498 - 143.37, unified: true, position: { short: 1.157 } });
    expect(asked.map((a) => a.body.type)).toEqual(["clearinghouseState", "userAbstraction", "spotClearinghouseState"]);
  });

  it("treats an account in the default mode as margining each dex separately", async () => {
    const got = await fetchHedgeAccount(fakeInfo({ clearinghouseState: state(), userAbstraction: "disabled" }).post, "testnet", ACCOUNT, "xyz:TSLA");
    expect(got).toMatchObject({ accountValue: 500, unified: false, position: null });
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

describe("fetchHedgeActivity", () => {
  const SINCE = 1_790_000_000;
  const ms = (s: number) => s * 1000;
  // As Hyperliquid's SDK recorded them, fields the hedger ignores included.
  const fill = (coin: string, side: "A" | "B", sz: string, px: string, fee: string, closedPnl: string, dir: string, at: number) => ({
    closedPnl, coin, crossed: true, dir, fee, feeToken: "USDC", hash: `0x${at.toString(16)}`, oid: at, px, side, startPosition: "0.0", sz, tid: at, time: ms(at),
  });
  const funding = (coin: string, usdc: string, szi: string, at: number) => ({
    delta: { coin, fundingRate: "0.0000125", nSamples: null, szi, type: "funding", usdc }, hash: `0x${at.toString(16)}`, time: ms(at),
  });

  it("keeps the coin's fills, newest first, and sums fees, closed P&L and funding received", async () => {
    const { post, asked } = fakeInfo({
      userFillsByTime: [
        fill("xyz:TSLA", "A", "0.906", "372.17", "0.030347", "0.0", "Open Short", SINCE + 60),
        fill("BTC", "B", "0.01", "65000.0", "0.29", "0.0", "Open Long", SINCE + 90),
        fill("xyz:TSLA", "B", "0.906", "370.0", "0.030170", "1.96602", "Close Short", SINCE + 3600),
        fill("xyz:TSLA", "A", "0.1", "380.0", "0.0", "0.0", "Open Short", SINCE - 60),
      ],
      userFunding: [funding("xyz:TSLA", "0.004214", "-0.906", SINCE + 1800), funding("xyz:TSLA", "-0.001", "-0.906", SINCE + 3000), funding("BTC", "-0.5", "0.01", SINCE + 1800)],
    });
    const a = await fetchHedgeActivity(post, "testnet", ACCOUNT, "xyz:TSLA", SINCE);
    expect(asked.map((q) => q.body)).toEqual([
      { type: "userFillsByTime", user: ACCOUNT, startTime: ms(SINCE), aggregateByTime: true },
      { type: "userFunding", user: ACCOUNT, startTime: ms(SINCE) },
    ]);
    expect(a.fills).toEqual([
      { time: SINCE + 3600, sell: false, size: 0.906, price: 370, fee: 0.03017, closedPnl: 1.96602, dir: "Close Short" },
      { time: SINCE + 60, sell: true, size: 0.906, price: 372.17, fee: 0.030347, closedPnl: 0, dir: "Open Short" },
    ]);
    expect(a.trades).toBe(2);
    expect(a.fees).toBeCloseTo(0.060517, 9);
    expect(a.closedPnl).toBeCloseTo(1.96602, 9);
    expect(a.funding).toBeCloseTo(0.003214, 9);
    expect(a.fundingPayments).toBe(2);
    expect(a.since).toBe(SINCE);
  });

  it("shows only the latest fills but counts them all", async () => {
    const many = Array.from({ length: 12 }, (_, i) => fill("xyz:TSLA", i % 2 ? "B" : "A", "0.05", "372.0", "0.001", "0.0", "Open Short", SINCE + i));
    const { post } = fakeInfo({ userFillsByTime: many, userFunding: [] });
    const a = await fetchHedgeActivity(post, "testnet", ACCOUNT, "xyz:TSLA", SINCE);
    expect(a.fills).toHaveLength(10);
    expect(a.fills[0]?.time).toBe(SINCE + 11);
    expect(a.trades).toBe(12);
    expect(a.fees).toBeCloseTo(0.012, 9);
  });

  it("pages through more fills and funding than one answer holds, and counts them all", async () => {
    const fills = Array.from({ length: FILLS_PER_PAGE + 3 }, (_, i) => fill("xyz:TSLA", "A", "0.01", "372.0", "0.001", "0.5", "Close Short", SINCE + i));
    const paid = Array.from({ length: FUNDING_PER_PAGE + 1 }, (_, i) => funding("xyz:TSLA", "0.002", "-1.0", SINCE + i));
    const asked: Record<string, unknown>[] = [];
    // As Hyperliquid pages: the earliest entries from startTime on, up to a page.
    const post: Post = async (_network, body) => {
      asked.push(body);
      const all = body.type === "userFillsByTime" ? fills : paid;
      const size = body.type === "userFillsByTime" ? FILLS_PER_PAGE : FUNDING_PER_PAGE;
      return all.filter((x) => x.time >= Number(body.startTime)).slice(0, size);
    };
    const a = await fetchHedgeActivity(post, "testnet", ACCOUNT, "xyz:TSLA", SINCE);
    expect(a.trades).toBe(FILLS_PER_PAGE + 3);
    expect(a.closedPnl).toBeCloseTo(0.5 * (FILLS_PER_PAGE + 3), 6);
    expect(a.fundingPayments).toBe(FUNDING_PER_PAGE + 1);
    // Each next page starts a millisecond after the last page's latest entry.
    expect(asked.filter((q) => q.type === "userFillsByTime").map((q) => q.startTime)).toEqual([ms(SINCE), ms(SINCE + FILLS_PER_PAGE - 1) + 1]);
    expect(asked.filter((q) => q.type === "userFunding").map((q) => q.startTime)).toEqual([ms(SINCE), ms(SINCE + FUNDING_PER_PAGE - 1) + 1]);
  });

  it("reads an account that hasn't traded as nothing", async () => {
    const { post } = fakeInfo({ userFillsByTime: [], userFunding: [] });
    expect(await fetchHedgeActivity(post, "testnet", ACCOUNT, "xyz:TSLA", SINCE)).toEqual({ since: SINCE, fills: [], trades: 0, fees: 0, closedPnl: 0, funding: 0, fundingPayments: 0 });
  });
});
