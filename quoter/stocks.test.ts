import type { HermesClient } from "@pythnetwork/hermes-client";
import { describe, expect, it } from "vitest";

import chainlink from "../research/data/chainlink-gaps.json" with { type: "json" };
import qqq from "../research/data/pyth-qqq-gaps.json" with { type: "json" };
import tsla from "../research/data/pyth-tsla-gaps.json" with { type: "json" };
import listed from "../research/data/robinhood-stocks.json" with { type: "json" };
import type { Opening } from "../pricing/model";
import { pythPrintAt } from "./marketData";
import { DEFAULT_QUOTER_CONFIG, priceQuote, type Market } from "./quoter";
import { QQQ, STOCKS, stockByChainlinkFeed, stockByFeedId, stockBySymbol, TSLA } from "./stocks";

const chainlinkGaps = (chainlink as { stocks: Record<string, { gaps: (Opening & { gap: number })[] }> }).stocks;

const utc = (iso: string) => Date.parse(iso) / 1000;
const FRIDAY_EVENING = utc("2026-09-26T00:00:00Z");

describe("the stock registry", () => {
  it("finds a stock by symbol, in any case, by Pyth feed id, with or without 0x, and by Chainlink feed", () => {
    expect(stockBySymbol("qqq")).toBe(QQQ);
    expect(stockBySymbol("ZZZZ")).toBeUndefined();
    expect(stockByFeedId(TSLA.feedId.slice(2).toUpperCase())).toBe(TSLA);
    expect(stockByFeedId("0x" + "00".repeat(32))).toBeUndefined();
    expect(stockByChainlinkFeed(TSLA.chainlink!.toLowerCase())).toBe(TSLA);
  });

  it("shows each stock's display name as the list writes it", () => {
    expect(["AMD", "CLSK", "SPY", "TSM"].map((s) => stockBySymbol(s)!.name)).toEqual(["AMD", "CleanSpark", "S&P 500 (SPY)", "TSMC"]);
  });

  it("has one entry per symbol and per feed", () => {
    expect(new Set(STOCKS.map((s) => s.symbol)).size).toBe(STOCKS.length);
    expect(new Set(STOCKS.map((s) => s.feedId.toLowerCase())).size).toBe(STOCKS.length);
    expect(new Set(STOCKS.map((s) => s.chainlink?.toLowerCase())).size).toBe(STOCKS.length);
  });

  it("settles on Solana only the stocks the Pyth key reads, and on Robinhood Chain every stock Chainlink lists", () => {
    expect(STOCKS.filter((s) => s.pyth).map((s) => s.symbol)).toEqual(["TSLA", "QQQ"]);
    expect(STOCKS.map((s) => s.symbol).sort()).toEqual(listed.stocks.map((s) => s.symbol).sort());
    expect(STOCKS.every((s) => s.chainlink)).toBe(true);
  });

  it("has a perp for all but the three Hyperliquid doesn't list, read through the index for the four funds", () => {
    expect(STOCKS.filter((s) => !s.hyperliquid).map((s) => s.symbol).sort()).toEqual(["CLSK", "IONQ", "RGTI"]);
    expect(STOCKS.filter((s) => s.hyperliquidTracks === "index").map((s) => `${s.symbol}:${s.hyperliquid}`).sort()).toEqual(["QQQ:xyz:XYZ100", "SLV:xyz:SILVER", "SPY:xyz:SP500", "USO:xyz:CL"]);
  });

  it("measured a plausible volatility for every stock", () => {
    for (const s of STOCKS) expect(s.annualVol, s.symbol).toBeGreaterThan(0.05), expect(s.annualVol, s.symbol).toBeLessThan(3);
  });
});

describe("openings read from Chainlink", () => {
  it("has a history for every stock only Robinhood Chain settles", () => {
    for (const s of STOCKS.filter((x) => !x.pyth)) expect(chainlinkGaps[s.symbol]?.gaps.length, s.symbol).toBeGreaterThanOrEqual(40);
  });

  for (const [symbol, { gaps }] of Object.entries(chainlinkGaps)) {
    it(`${symbol}: in order, one per session, Labor Day bridged, no launch-day prices off scale`, () => {
      for (let i = 1; i < gaps.length; i++) expect(gaps[i]!.from).toBe(gaps[i - 1]!.to);
      expect(gaps.find((g) => g.from === "2026-09-04")).toMatchObject({ to: "2026-09-08", weekend: true });
      // A move of more than 60% overnight would be a price on the wrong scale, not a market.
      for (const g of gaps) expect(Math.abs(Math.log(g.open / g.close)), `${symbol} ${g.from}`).toBeLessThan(0.5);
    });
  }

  it("TSLA's agree with Pyth's on every opening both recorded, to within Chainlink's 0.5% deviation", () => {
    const byDates = new Map(chainlinkGaps.TSLA!.gaps.map((g) => [`${g.from}>${g.to}`, g]));
    const pyth = tsla.gaps as (Opening & { gap: number })[];
    const diffs = pyth.map((p) => {
      const c = byDates.get(`${p.from}>${p.to}`);
      expect(c, `${p.from}>${p.to}`).toBeDefined();
      expect(c!.weekend).toBe(p.weekend);
      return Math.abs(c!.gap - p.gap);
    });
    diffs.sort((a, b) => a - b);
    expect(diffs[diffs.length >> 1]).toBeLessThan(0.005);
    expect(diffs[diffs.length - 1]).toBeLessThan(0.015);
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
