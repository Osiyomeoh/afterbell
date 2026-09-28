import { describe, expect, it } from "vitest";

import { currentEvent, EVENTS, eventPhase, openBefore } from "./events";

const at = (iso: string) => Date.parse(iso) / 1000;
const FRI = at("2026-10-02T13:30:00Z");

describe("market events", () => {
  it("puts protection until an open on sale at the open before it, skipping holidays", () => {
    expect(openBefore(FRI)).toBe(at("2026-10-01T13:30:00Z"));
    expect(openBefore(FRI, new Set(["2026-10-01"]))).toBe(at("2026-09-30T13:30:00Z"));
    // Monday's comes from Friday's.
    expect(openBefore(at("2026-10-05T13:30:00Z"))).toBe(FRI);
  });

  it("shows an event until three days after its open", () => {
    expect(currentEvent("TSLA", at("2026-09-28T17:00:00Z"))?.openTs).toBe(FRI);
    expect(currentEvent("TSLA", at("2026-10-04T12:00:00Z"))?.openTs).toBe(FRI);
    expect(currentEvent("TSLA", at("2026-10-05T14:00:00Z"))).toBeUndefined();
    expect(currentEvent("NVDA", at("2026-09-28T17:00:00Z"))).toBeUndefined();
  });

  it("says where the event's open stands at every point from its sales to its settlement", () => {
    const e = EVENTS.find((x) => x.openTs === FRI)!;
    const THU = at("2026-10-01T13:30:00Z");
    const m = (nextOpen: number) => ({ nextOpen, holidays: new Set<string>(), stopBeforeOpenSecs: 120 });
    // Monday: Tuesday's open is on sale; Friday's comes at Thursday's open.
    expect(eventPhase(e, at("2026-09-28T17:00:00Z"), m(at("2026-09-29T13:30:00Z")), null)).toEqual({ phase: "before-sales", salesOpen: THU });
    // Thursday 13:29: the quote service already quotes Friday, but Thursday's open hasn't rung.
    expect(eventPhase(e, THU - 60, m(FRI), null).phase).toBe("before-sales");
    // Thursday 13:31: on sale once the vault has rolled; until then, waiting.
    expect(eventPhase(e, THU + 60, m(FRI), null)).toEqual({ phase: "on-sale", salesClose: FRI - 120 });
    expect(eventPhase(e, THU + 60, m(THU), null)).toEqual({ phase: "waiting" });
    // Friday: sales stop two minutes before the bell; then it rings; then it settles.
    expect(eventPhase(e, FRI - 60, m(FRI), null)).toEqual({ phase: "sales-closed" });
    expect(eventPhase(e, FRI + 60, m(at("2026-10-05T13:30:00Z")), null)).toEqual({ phase: "bell-rung" });
    expect(eventPhase(e, FRI + 3600, m(at("2026-10-05T13:30:00Z")), 351.2)).toEqual({ phase: "settled", price: 351.2 });
  });
});
