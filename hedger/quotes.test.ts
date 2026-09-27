import { describe, expect, it } from "vitest";

import { hedgeOrder, type Market, type OrderWire } from "./hyperliquid";
import { DEFAULT_QUOTE_RULES, quoteOrders, refreshQuotes, type RestingOrder } from "./quotes";
import { DEFAULT_BAND, rebalance } from "./target";

const testnet: Market = { coin: "xyz:TSLA", asset: 750_001, szDecimals: 3, maxLeverage: 10 };

describe("quoteOrders", () => {
  it("bids and asks around the mid, rounded away from it, good until cancelled", () => {
    // 2 bps of $373.34 is 7.47¢: $373.2653 rounds down to $373.26, $373.4147 up to $373.42.
    const { bid, ask } = quoteOrders(373.34, testnet, DEFAULT_QUOTE_RULES);
    expect(bid).toEqual({ a: 750_001, b: true, p: "373.26", s: "5", r: false, t: { limit: { tif: "Gtc" } } });
    expect(ask).toEqual({ a: 750_001, b: false, p: "373.42", s: "5", r: false, t: { limit: { tif: "Gtc" } } });
  });

  it("never lets the two sides meet, however narrow the spread", () => {
    const { bid, ask } = quoteOrders(373.3, testnet, { ...DEFAULT_QUOTE_RULES, spreadBps: 0.01 });
    expect([bid.p, ask.p]).toEqual(["373.29", "373.31"]);
  });

  it("fills the hedger's orders both ways: its sell reaches the bid, its buy-back the ask", () => {
    const mid = 371.76;
    const { bid, ask } = quoteOrders(mid, testnet, DEFAULT_QUOTE_RULES);
    const rules = { step: 0.001, ...DEFAULT_BAND, maxNotional: 1500 };
    const sell = hedgeOrder(rebalance(1.16, 0, mid, rules), mid, testnet)!;
    const buy = hedgeOrder(rebalance(0, 1.16, mid, rules), mid, testnet)!;
    expect(Number(sell.p)).toBeLessThanOrEqual(Number(bid.p));
    expect(Number(buy.p)).toBeGreaterThanOrEqual(Number(ask.p));
  });

  it("refuses a spread the hedger's orders could never reach, or none at all", () => {
    expect(() => quoteOrders(373.34, testnet, { ...DEFAULT_QUOTE_RULES, spreadBps: 20 })).toThrow(/never fill/);
    expect(() => quoteOrders(373.34, testnet, { ...DEFAULT_QUOTE_RULES, spreadBps: 0 })).toThrow(/cross/);
  });

  it("rounds the size to the market's step, and refuses one below it", () => {
    expect(quoteOrders(373.34, testnet, { ...DEFAULT_QUOTE_RULES, size: 4.0217 }).bid.s).toBe("4.022");
    expect(() => quoteOrders(373.34, testnet, { ...DEFAULT_QUOTE_RULES, size: 0.0004 })).toThrow(/size step/);
    expect(() => quoteOrders(0, testnet, DEFAULT_QUOTE_RULES)).toThrow(/no mid/);
  });
});

describe("refreshQuotes", () => {
  const { bid, ask } = quoteOrders(373.34, testnet, DEFAULT_QUOTE_RULES);
  const wanted: OrderWire[] = [bid, ask];
  const order = (oid: number, buy: boolean, px: number, size = 5): RestingOrder => ({ oid, buy, px, size });

  it("places both quotes on an empty book", () => {
    expect(refreshQuotes([], wanted, 1)).toEqual({ keep: [], cancel: [], place: [bid, ask] });
  });

  it("keeps unfilled quotes the mid hasn't moved away from", () => {
    // $373.23 is 0.8 bps from the new bid.
    const got = refreshQuotes([order(1, true, 373.23), order(2, false, 373.42)], wanted, 1);
    expect(got).toEqual({ keep: [order(1, true, 373.23), order(2, false, 373.42)], cancel: [], place: [] });
  });

  it("replaces a quote the mid has moved away from, and one partly filled", () => {
    // $373.21 is 1.3 bps from the new bid; the ask has 3.84 of its 5 left.
    const got = refreshQuotes([order(1, true, 373.21), order(2, false, 373.42, 3.84)], wanted, 1);
    expect(got).toEqual({ keep: [], cancel: [order(1, true, 373.21), order(2, false, 373.42, 3.84)], place: [bid, ask] });
  });

  it("puts back a side that filled away, keeping the other", () => {
    expect(refreshQuotes([order(2, false, 373.42)], wanted, 1)).toEqual({ keep: [order(2, false, 373.42)], cancel: [], place: [bid] });
  });

  it("cancels every order that isn't one of the quotes: a duplicate, or one on the wrong side", () => {
    const got = refreshQuotes([order(1, true, 373.26), order(3, true, 373.26), order(4, true, 373.42)], wanted, 1);
    expect(got).toEqual({ keep: [order(1, true, 373.26)], cancel: [order(3, true, 373.26), order(4, true, 373.42)], place: [ask] });
  });
});
