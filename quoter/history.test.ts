import { describe, expect, it } from "vitest";

import type { Opening } from "../pricing/model";
import { sessionsFrom } from "./calendar";
import { newOpenings, type Print } from "./history";

const utc = (iso: string) => Date.parse(iso) / 1000;
const LAST: Opening = { from: "2026-09-24", to: "2026-09-25", close: 377.87, open: 384.62, weekend: false };

/** Prints on the minute of each bell; `missing` dates have none (no session). */
function prints(missing: string[] = []) {
  return async (ts: number): Promise<Print | null> => {
    const date = new Date(ts * 1000).toISOString().slice(0, 10);
    if (missing.includes(date)) return null;
    return { price: 380 + (ts % 1000) / 100, publishTime: ts };
  };
}

describe("trading days", () => {
  it("skips weekends and holidays, and stops at the last open before now", () => {
    const days = sessionsFrom("2026-09-25", utc("2026-09-30T14:00:00Z"), new Set(["2026-09-29"]));
    expect(days.map((d) => d.date)).toEqual(["2026-09-25", "2026-09-28", "2026-09-30"]);
    expect(days[0]).toMatchObject({ openTs: utc("2026-09-25T13:30:00Z"), closeTs: utc("2026-09-25T20:00:00Z") });
  });

  it("uses the early close and New York's switch back to EST", () => {
    const days = sessionsFrom("2026-11-25", utc("2026-11-30T15:00:00Z"), new Set(["2026-11-26"]), new Map([["2026-11-27", { hour: 13, minute: 0 }]]));
    expect(days.map((d) => d.date)).toEqual(["2026-11-25", "2026-11-27", "2026-11-30"]);
    expect(days[1]).toMatchObject({ openTs: utc("2026-11-27T14:30:00Z"), closeTs: utc("2026-11-27T18:00:00Z") });
  });
});

describe("new openings", () => {
  it("pairs each close with the next open and flags weekends", async () => {
    const out = await newOpenings([LAST], prints(), utc("2026-09-30T14:00:00Z"));
    expect(out.map((o) => `${o.from}>${o.to}${o.weekend ? " weekend" : ""}`)).toEqual(["2026-09-25>2026-09-28 weekend", "2026-09-28>2026-09-29", "2026-09-29>2026-09-30"]);
    expect(out[0]!.close).toBe(380 + (utc("2026-09-25T20:00:00Z") % 1000) / 100);
  });

  it("pairs across a day with no prints, as a holiday", async () => {
    const out = await newOpenings([LAST], prints(["2026-09-29"]), utc("2026-09-30T14:00:00Z"));
    expect(out.map((o) => `${o.from}>${o.to}${o.weekend ? " weekend" : ""}`)).toEqual(["2026-09-25>2026-09-28 weekend", "2026-09-28>2026-09-30 weekend"]);
  });

  it("adds nothing before the next open, and never a close that hasn't happened", async () => {
    expect(await newOpenings([LAST], prints(), utc("2026-09-26T12:00:00Z"))).toEqual([]);
    // Monday 11:00 ET: Monday's open is in, its close isn't.
    const monday = await newOpenings([LAST], prints(), utc("2026-09-28T15:00:00Z"));
    expect(monday.map((o) => o.to)).toEqual(["2026-09-28"]);
  });
});
