import { describe, expect, it } from "vitest";

import tsla from "../research/data/pyth-tsla-gaps.json" with { type: "json" };
import type { Opening } from "../pricing/model";
import { boardPrice, STANDARD } from "./board";
import { priceQuote, type Market } from "./quoter";
import { TSLA } from "./stocks";

// Sunday 27 Sep 2026, 12:00 ET: the market is shut, so it's quoted from the lower of the close and the live price.
const NOW = Date.UTC(2026, 8, 27, 16) / 1000;
const market: Market = {
  symbol: "TSLA",
  close: 372.21,
  live: 373.5,
  history: (tsla as { gaps: Opening[] }).gaps,
  annualVol: TSLA.annualVol,
  holidays: new Set(),
  earlyCloses: new Map(),
};

describe("boardPrice", () => {
  it("prices standard cover on one share exactly as the ticket would", () => {
    const b = boardPrice(NOW, market);
    expect(b.reference).toBe(372.21);
    const ticket = priceQuote(NOW, market, { shares: 1, upper: 364.77, lower: 334.99 });
    expect(b.premium).toBe(ticket.premium);
    expect(b.maxPayout).toBeCloseTo(372.21 * (STANDARD.depth - STANDARD.start), 1);
    expect(b.probabilityOfPayout).toBe(ticket.probabilityOfPayout);
    expect(b.openTs).toBe(ticket.openTs);
    expect(b.live).toBe(373.5);
  });
});
