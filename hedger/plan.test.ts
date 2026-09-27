import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openingModel, type Opening } from "../pricing/model";
import type { Market } from "./hyperliquid";
import type { HedgeAccount } from "./info";
import { AFTER_OPEN_MS, nextRunMs, planHedge, type HedgeInputs } from "./plan";
import type { OpenPosition } from "./target";

const TSLA: Opening[] = JSON.parse(readFileSync(join(import.meta.dirname, "..", "research", "data", "pyth-tsla-gaps.json"), "utf8")).gaps;
const model = openingModel(TSLA, { annualVol: 0.6, years: 0 });

const OPEN = 1_790_000_000;
// Like Monday 28 Sep's five positions (the lower strikes are made up), and one in QQQ.
const book: OpenPosition[] = [
  { symbol: "TSLA", openTs: OPEN, shares: 1, upper: 370.32, lower: 340.09 },
  { symbol: "TSLA", openTs: OPEN, shares: 1, upper: 370.32, lower: 340.09 },
  { symbol: "TSLA", openTs: OPEN, shares: 2, upper: 364.56, lower: 335 },
  { symbol: "TSLA", openTs: OPEN, shares: 1, upper: 364.56, lower: 335 },
  { symbol: "TSLA", openTs: OPEN, shares: 3, upper: 364.15, lower: 335 },
  { symbol: "QQQ", openTs: OPEN, shares: 50, upper: 600, lower: 550 },
];
const testnet: Market = { coin: "xyz:TSLA", asset: 120_001, szDecimals: 3, maxLeverage: 10 };
const holding = (short: number): HedgeAccount => ({
  address: "0x000000000000000000000000000000000000dEaD",
  accountValue: 500,
  withdrawable: 300,
  position: { short, entryPx: 371, unrealizedPnl: 0, liquidationPx: 480, marginUsed: 150, leverage: { type: "isolated", value: 3 } },
});
const inputs = (over: Partial<HedgeInputs> = {}): HedgeInputs => ({
  now: OPEN - 3600,
  symbol: "TSLA",
  positions: book,
  mid: 371.76,
  modelFor: () => model,
  market: testnet,
  account: null,
  maxNotional: 1500,
  ...over,
});

describe("planHedge", () => {
  it("with no account given, sells the whole target on the network's market", () => {
    const p = planHedge(inputs());
    expect(p.current).toBe(0);
    expect(p.exposure.opens).toHaveLength(1);
    expect(p.rebalance.target).toBe(Number(p.exposure.hedge.toFixed(3)));
    expect(p.rebalance.target).toBeGreaterThan(1);
    expect(p.order).toMatchObject({ a: 120_001, b: false, s: String(p.rebalance.target), r: false, t: { limit: { tif: "Ioc" } } });
  });

  it("holds when the account already shorts the target", () => {
    const target = planHedge(inputs()).rebalance.target;
    const p = planHedge(inputs({ account: holding(target) }));
    expect(p.current).toBe(target);
    expect(p.rebalance.trade).toBe(0);
    expect(p.order).toBeNull();
  });

  it("buys the whole short back, reduce-only, once the open comes", () => {
    const p = planHedge(inputs({ now: OPEN, account: holding(1.157) }));
    expect(p.exposure.hedge).toBe(0);
    expect(p.order).toMatchObject({ b: true, s: "1.157", r: true });
  });

  it("treats an account with no position as holding none", () => {
    const none = { ...holding(0), position: null };
    expect(planHedge(inputs({ account: none })).order).toEqual(planHedge(inputs()).order);
  });

  it("sells through a long to reach the short, not reduce-only", () => {
    const p = planHedge(inputs({ account: holding(-0.5) }));
    expect(p.rebalance.trade).toBeCloseTo(p.rebalance.target + 0.5, 9);
    expect(p.order).toMatchObject({ b: false, r: false });
  });

  it("caps the short at the notional limit", () => {
    const p = planHedge(inputs({ mid: 360, maxNotional: 1000 }));
    expect(p.exposure.hedge).toBeGreaterThan(1000 / 360);
    expect(p.rebalance).toMatchObject({ target: 2.777, capped: true });
  });

  it("rounds to the market's own size step", () => {
    const p = planHedge(inputs({ market: { ...testnet, szDecimals: 2 } }));
    expect(p.rebalance.target).toBe(Number(p.exposure.hedge.toFixed(2)));
  });
});

describe("nextRunMs", () => {
  const now = OPEN * 1000 - 10 * 60_000;

  it("runs again after the interval when no open comes sooner", () => {
    expect(nextRunMs(now, 5 * 60_000, [])).toBe(now + 5 * 60_000);
    expect(nextRunMs(now, 5 * 60_000, [OPEN + 86_400])).toBe(now + 5 * 60_000);
  });

  it("runs just after an open that comes before the interval ends, to buy back at the opening price", () => {
    expect(nextRunMs(now, 15 * 60_000, [OPEN + 86_400, OPEN])).toBe(OPEN * 1000 + AFTER_OPEN_MS);
  });

  it("ignores an open already passed", () => {
    expect(nextRunMs(OPEN * 1000 + 5_000, 60_000, [OPEN])).toBe(OPEN * 1000 + 65_000);
  });
});
