import { describe, expect, it } from "vitest";

import { standingOrder } from "./everyNight";

describe("protect every night", () => {
  it("renews tonight's protection at its levels, capped at half again tonight's price, for the nights chosen", () => {
    // Position #0 on Robinhood Chain: 10 TSLA, 2% to 10% below, $17.37 for Tuesday's open.
    const { order, allowance } = standingOrder({ shares: 10, start: 0.02, depth: 0.1, premium: 17.368932, openTs: 1_790_688_600, nights: 14 });
    expect(order).toEqual({ maxShares: 10_000_000n, startBps: 200, depthBps: 1_000, maxPremium: 26_053_398n, until: 1_790_688_600n + 14n * 86_400n });
    expect(allowance).toBe(26_053_398n * 14n);
  });

  it("stops protection at least a point below where it starts, as the ticket does", () => {
    expect(standingOrder({ shares: 1, start: 0.05, depth: 0.05, premium: 1, openTs: 0, nights: 7 }).order.depthBps).toBe(600);
  });
});
