import { describe, expect, it } from "vitest";

import { currentEvent, openBefore } from "./events";

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
});
