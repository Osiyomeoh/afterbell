import { describe, expect, it } from "vitest";

import { nyTimestamp, upcomingCloses } from "./calendar";

describe("upcomingCloses", () => {
  // Wed 25 Nov 2026, 17:00 ET: today's close has passed.
  const now = nyTimestamp({ y: 2026, m: 11, d: 25 }, 17, 0);

  it("skips weekends and holidays and keeps early closes", () => {
    const closes = upcomingCloses(now, 3, new Set(["2026-11-26"]), new Map([["2026-11-27", { hour: 13, minute: 0 }]]));
    expect(closes.map((c) => c.date)).toEqual(["2026-11-27", "2026-11-30", "2026-12-01"]);
    expect(closes[0]!.closeTs).toBe(nyTimestamp({ y: 2026, m: 11, d: 27 }, 13, 0));
  });

  it("includes today's close while the session is on", () => {
    const noon = nyTimestamp({ y: 2026, m: 11, d: 25 }, 12, 0);
    expect(upcomingCloses(noon, 1)[0]!.date).toBe("2026-11-25");
  });
});
