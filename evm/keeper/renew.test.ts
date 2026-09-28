import { describe, expect, it } from "vitest";

import { renewalDecision } from "./renew";

const order = { maxShares: 10_000_000n, startBps: 200, depthBps: 1_000, maxPremium: 30_000_000n, until: 2_000n, lastOpenTs: 1_000n };

describe("renewing a standing order", () => {
  it("renews for a new open within the price cap", () => {
    expect(renewalDecision(order, 1_500n, 20_000_000n)).toEqual({ action: "renew" });
    expect(renewalDecision(order, 2_000n, 30_000_000n)).toEqual({ action: "renew" });
  });

  it("skips an open already bought, one past the order's end, a price above its cap, or a cancelled order", () => {
    expect(renewalDecision(order, 1_000n, 1n)).toEqual({ action: "skip", reason: "already renewed for this open" });
    expect(renewalDecision(order, 2_001n, 1n)).toEqual({ action: "skip", reason: "the order has ended" });
    expect(renewalDecision(order, 1_500n, 30_000_001n).action).toBe("skip");
    expect(renewalDecision({ ...order, maxShares: 0n }, 1_500n, 1n)).toEqual({ action: "skip", reason: "cancelled" });
    // Checkout buys tonight, then sets the order: the first renewal is the next open, not tonight again.
    expect(renewalDecision(order, 1_500n, 1n, true)).toEqual({ action: "skip", reason: "the holder already has protection for this open" });
  });
});
