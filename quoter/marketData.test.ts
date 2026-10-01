import { afterEach, describe, expect, it, vi } from "vitest";

import { candlePoints, pythCalendar } from "./marketData";

describe("candlePoints", () => {
  const candles = [
    { t: 1_790_010_000_000, c: "372.5" },
    { t: 1_790_000_000_000, c: "371.0" },
    { t: 1_789_999_700_000, c: "370.0" },
    { t: 1_790_020_000_000, c: "0" },
  ];

  it("reads each candle's close at its open time, from the close on, oldest first", () => {
    expect(candlePoints(candles, 1_790_000_000)).toEqual([
      { t: 1_790_000_000, price: 371 },
      { t: 1_790_010_000, price: 372.5 },
    ]);
  });

  it("scales an index perp to the stock's level", () => {
    expect(candlePoints([{ t: 1_790_000_000_000, c: "25000" }], 0, 0.02)).toEqual([{ t: 1_790_000_000, price: 500 }]);
  });
});

describe("pythCalendar", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads every stock's schedule from one request for all equities", async () => {
    const week = "0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C";
    const feeds = [
      { id: "aa".repeat(32), attributes: { schedule: `America/New_York;${week};1126/C,1127/0930-1300` } },
      { id: "bb".repeat(32), attributes: { schedule: `America/New_York;${week};1225/C` } },
    ];
    const fetch = vi.fn(async () => new Response(JSON.stringify(feeds)));
    vi.stubGlobal("fetch", fetch);
    const now = Date.UTC(2026, 8, 27) / 1000;
    const a = await pythCalendar("AAA", "0x" + "AA".repeat(32), now);
    const b = await pythCalendar("BBB", "bb".repeat(32), now);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toMatch(/asset_type=equity$/);
    expect([...a.holidays]).toContain("2026-11-26");
    expect(a.earlyCloses.get("2026-11-27")).toEqual({ hour: 13, minute: 0 });
    expect([...b.holidays]).toContain("2026-12-25");
    await expect(pythCalendar("CCC", "cc".repeat(32), now)).rejects.toThrow(/no market-hours schedule for CCC/);
  });
});
