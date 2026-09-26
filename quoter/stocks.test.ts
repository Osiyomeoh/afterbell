import type { HermesClient } from "@pythnetwork/hermes-client";
import { describe, expect, it } from "vitest";

import qqq from "../research/data/pyth-qqq-gaps.json" with { type: "json" };
import tsla from "../research/data/pyth-tsla-gaps.json" with { type: "json" };
import type { Opening } from "../pricing/model";
import { pythPrintAt } from "./marketData";
import { DEFAULT_QUOTER_CONFIG, priceQuote, type Market } from "./quoter";
import { QQQ, STOCKS, stockByFeedId, stockBySymbol, TSLA } from "./stocks";

const utc = (iso: string) => Date.parse(iso) / 1000;
const FRIDAY_EVENING = utc("2026-09-26T00:00:00Z");

describe("the stock registry", () => {
  it("finds a stock by symbol, in any case, and by feed id, with or without 0x", () => {
    expect(stockBySymbol("qqq")).toBe(QQQ);
    expect(stockBySymbol("NVDA")).toBeUndefined();
    expect(stockByFeedId(TSLA.feedId.slice(2).toUpperCase())).toBe(TSLA);
    expect(stockByFeedId("0x" + "00".repeat(32))).toBeUndefined();
  });

  it("has one entry per symbol and per feed", () => {
    expect(new Set(STOCKS.map((s) => s.symbol)).size).toBe(STOCKS.length);
    expect(new Set(STOCKS.map((s) => s.feedId.toLowerCase())).size).toBe(STOCKS.length);
  });
});

describe("recorded openings", () => {
  for (const [symbol, file] of [
    ["TSLA", tsla],
    ["QQQ", qqq],
  ] as const) {
    it(`${symbol}: in order, one per session, with Labor Day bridged as a long weekend`, () => {
      const gaps = file.gaps as Opening[];
      expect(gaps.length).toBeGreaterThanOrEqual(10);
      for (let i = 1; i < gaps.length; i++) expect(gaps[i]!.from).toBe(gaps[i - 1]!.to);
      expect(gaps.find((g) => g.from === "2026-09-04")).toMatchObject({ to: "2026-09-08", weekend: true });
      expect(gaps.every((g) => g.close > 0 && g.open > 0)).toBe(true);
    });
  }

  it("QQQ's openings move far less than TSLA's, so the same protection costs less", () => {
    const market = (symbol: string, history: Opening[], price: number, annualVol: number): Market => ({ symbol, close: price, live: price, history, annualVol, holidays: new Set() });
    // 1 share protected from 2% to 10% below each close.
    const t = priceQuote(FRIDAY_EVENING, market("TSLA", tsla.gaps as Opening[], 372, 0.6), { shares: 1, upper: 364.56, lower: 334.8 }, DEFAULT_QUOTER_CONFIG);
    const q = priceQuote(FRIDAY_EVENING, market("QQQ", qqq.gaps as Opening[], 744, 0.25), { shares: 1, upper: 729.12, lower: 669.6 }, DEFAULT_QUOTER_CONFIG);
    expect(q.premium / 744).toBeLessThan(t.premium / 372);
  });
});

describe("pythPrintAt", () => {
  const hermes = (fail: Error) => ({ getPriceUpdatesAtTimestamp: () => Promise.reject(fail) }) as unknown as HermesClient;

  it("reads Hermes's 404 as no print (a day the exchange was shut), not an error", async () => {
    const e = new Error("HTTP error! status: 404, body: Could not find price updates for any of the given price feeds at the given timestamp");
    await expect(pythPrintAt(hermes(e), QQQ.feedId, utc("2026-09-07T13:30:00Z"))).resolves.toBeNull();
  });

  it("still fails on anything else, such as a key without access", async () => {
    await expect(pythPrintAt(hermes(new Error("HTTP error! status: 403, body: forbidden")), QQQ.feedId, 0)).rejects.toThrow("403");
  });
});
