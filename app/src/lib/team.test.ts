import { describe, expect, it } from "vitest";

import { buyers, FIRST_CAMPAIGN_OPEN } from "./team";

const BEFORE = FIRST_CAMPAIGN_OPEN - 86_400;
const TEAM = new Set(["ours", "0xabc"]);

describe("outside buyers", () => {
  it("counts a new wallet whose first purchase is for the campaign's open or later", () => {
    const r = buyers(
      [
        { chain: "solana", buyer: "stranger", openTs: FIRST_CAMPAIGN_OPEN },
        { chain: "solana", buyer: "stranger", openTs: FIRST_CAMPAIGN_OPEN + 86_400 },
        { chain: "solana", buyer: "later", openTs: FIRST_CAMPAIGN_OPEN + 86_400 },
      ],
      TEAM,
    );
    expect(r.all).toEqual(["stranger", "later"]);
    expect(r.outside).toEqual(["stranger", "later"]);
  });

  it("never counts the team, nor a wallet that bought before the campaign", () => {
    const r = buyers(
      [
        { chain: "solana", buyer: "ours", openTs: FIRST_CAMPAIGN_OPEN },
        { chain: "solana", buyer: "tester", openTs: BEFORE },
        { chain: "solana", buyer: "tester", openTs: FIRST_CAMPAIGN_OPEN },
        { chain: "robinhood", buyer: "0xABC", openTs: FIRST_CAMPAIGN_OPEN },
      ],
      TEAM,
    );
    expect(r.all).toHaveLength(3);
    expect(r.outside).toEqual([]);
  });
});
