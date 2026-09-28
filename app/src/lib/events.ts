import { nextOpen } from "@root/quoter/calendar";

/**
 * Scheduled news expected to land on a particular opening, so the app can
 * say which protection covers it. Each entry is written by hand from a
 * public source and says "expected": companies can move a date.
 */
export type MarketEvent = {
  symbol: string;
  /** Unix seconds of the 09:30 ET open the news is expected to reach first. */
  openTs: number;
  title: string;
  /** One or two sentences: when it's expected, and why that open carries it. */
  detail: string;
};

export const EVENTS: MarketEvent[] = [
  {
    symbol: "TSLA",
    // Friday 2 October 2026, 09:30 EDT.
    openTs: Date.parse("2026-10-02T13:30:00Z") / 1000,
    title: "Tesla's third-quarter deliveries",
    detail:
      "Tesla's second-quarter report came out at about 09:05 ET on 2 July, before the open; if this one does the same, Friday's opening price carries the number.",
  },
];

/** The next event on `symbol` whose open hasn't come yet. */
export const nextEvent = (symbol: string, now: number): MarketEvent | undefined =>
  EVENTS.filter((e) => e.symbol === symbol && e.openTs > now).sort((a, b) => a.openTs - b.openTs)[0];

/** The event protection settling at `openTs` covers, if any. */
export const eventAt = (symbol: string, openTs: number): MarketEvent | undefined => EVENTS.find((e) => e.symbol === symbol && e.openTs === openTs);

/** How long after its open an event still shows, with how it came out. */
export const SHOW_AFTER_SECS = 3 * 86_400;

/** The event on `symbol` to show now: the next one, or one whose open was in the last three days. */
export const currentEvent = (symbol: string, now: number): MarketEvent | undefined =>
  EVENTS.filter((e) => e.symbol === symbol && e.openTs > now - SHOW_AFTER_SECS).sort((a, b) => a.openTs - b.openTs)[0];

/** The open before `openTs`: when protection until `openTs` goes on sale. */
export function openBefore(openTs: number, holidays: ReadonlySet<string> = new Set()): number {
  let before = 0;
  for (let back = 1; back <= 7; back++) {
    const o = nextOpen(openTs - back * 86_400 - 1, 0, holidays);
    if (o < openTs && o > before) before = o;
  }
  return before;
}
