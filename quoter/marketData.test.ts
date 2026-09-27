import { describe, expect, it } from "vitest";

import { candlePoints } from "./marketData";

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
