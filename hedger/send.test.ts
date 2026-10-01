import { describe, expect, it } from "vitest";

import type { Exchange, ExchangeResponse } from "./exchange";
import type { OrderWire } from "./hyperliquid";
import type { HedgeAccount } from "./info";
import type { HedgePlan } from "./plan";
import type { QuoteRefresh } from "./quotes";
import { sendHedge, sendQuotes } from "./send";

/** An exchange that accepts everything, answers as Hyperliquid does, and keeps each action sent. */
function fakeExchange(fill: (o: OrderWire) => unknown = () => ({ filled: { totalSz: "0.831", avgPx: "373.26", oid: 9 } })) {
  const sent: { type: string }[] = [];
  const ex: Exchange = {
    network: "testnet",
    signer: "0x000000000000000000000000000000000000bEEF",
    async send(action) {
      sent.push(action);
      const a = action as unknown as { type: string; orders?: OrderWire[]; cancels?: unknown[] };
      if (a.type === "order") return { type: "order", data: { statuses: a.orders!.map(fill) } } as ExchangeResponse;
      if (a.type === "cancel") return { type: "cancel", data: { statuses: a.cancels!.map(() => "success") } };
      return { type: "default" };
    },
  };
  return { ex, sent };
}

const sell: OrderWire = { a: 750_001, b: false, p: "372.59", s: "0.831", r: false, t: { limit: { tif: "Ioc" } } };
const buyBack: OrderWire = { ...sell, b: true, p: "374.08", r: true };
const planWith = (order: OrderWire | null) => ({ order }) as HedgePlan;
const account = (short: number | null): HedgeAccount => ({
  address: "0x000000000000000000000000000000000000dEaD",
  accountValue: 500,
  unified: false,
  withdrawable: 500,
  position: short === null ? null : { short, entryPx: 373, unrealizedPnl: 0, liquidationPx: 480, marginUsed: 100, leverage: { type: "isolated", value: 3 } },
});

describe("sendHedge", () => {
  it("opens a short isolated at the leverage asked, then sells", async () => {
    const { ex, sent } = fakeExchange();
    expect(await sendHedge(ex, planWith(sell), account(null), 3)).toEqual({ leverage: 3, result: { kind: "filled", oid: 9, size: 0.831, avgPx: 373.26 } });
    expect(sent).toEqual([{ type: "updateLeverage", asset: 750_001, isCross: false, leverage: 3 }, { type: "order", orders: [sell], grouping: "na" }]);
  });

  it("adds to a short, or buys it back, without touching its margin", async () => {
    for (const [order, held] of [[sell, account(0.5)], [buyBack, account(0.831)]] as const) {
      const { ex, sent } = fakeExchange();
      expect((await sendHedge(ex, planWith(order), held, 3)).leverage).toBeNull();
      expect(sent.map((a) => a.type)).toEqual(["order"]);
    }
  });

  it("reports an order that found nothing to fill against", async () => {
    const { ex } = fakeExchange(() => ({ error: "Order could not immediately match against any resting orders. asset=750001" }));
    expect((await sendHedge(ex, planWith(sell), account(0.5), 3)).result).toEqual({ kind: "error", message: "Order could not immediately match against any resting orders. asset=750001" });
  });

  it("sends nothing when the plan holds", async () => {
    const { ex, sent } = fakeExchange();
    expect(await sendHedge(ex, planWith(null), account(null), 3)).toEqual({ leverage: null, result: null });
    expect(sent).toEqual([]);
  });
});

describe("sendQuotes", () => {
  const bid: OrderWire = { a: 750_001, b: true, p: "373.26", s: "5", r: false, t: { limit: { tif: "Gtc" } } };
  const ask: OrderWire = { ...bid, b: false, p: "373.42" };
  const stale = { oid: 101, buy: true, px: 373.1, size: 5 };
  const resting = () => ({ resting: { oid: 202 } });

  it("cancels the stale quotes before placing the new ones", async () => {
    const { ex, sent } = fakeExchange(resting);
    const refresh: QuoteRefresh = { keep: [], cancel: [stale], place: [bid, ask] };
    expect(await sendQuotes(ex, refresh, 750_001)).toEqual({ cancelled: [null], placed: [{ kind: "resting", oid: 202 }, { kind: "resting", oid: 202 }] });
    expect(sent).toEqual([{ type: "cancel", cancels: [{ a: 750_001, o: 101 }] }, { type: "order", orders: [bid, ask], grouping: "na" }]);
  });

  it("sends only what's needed, and nothing when both quotes rest", async () => {
    const { ex, sent } = fakeExchange(resting);
    await sendQuotes(ex, { keep: [stale], cancel: [], place: [ask] }, 750_001);
    expect(sent.map((a) => a.type)).toEqual(["order"]);
    const hold = fakeExchange();
    expect(await sendQuotes(hold.ex, { keep: [stale, stale], cancel: [], place: [] }, 750_001)).toEqual({ cancelled: [], placed: [] });
    expect(hold.sent).toEqual([]);
  });
});
