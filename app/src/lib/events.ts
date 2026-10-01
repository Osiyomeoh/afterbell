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
  ...(["SPY", "QQQ"] as const).map((symbol) => ({
    symbol,
    // Friday 2 October 2026, 09:30 EDT. The BLS schedule puts September's Employment Situation at 08:30 ET that day.
    openTs: Date.parse("2026-10-02T13:30:00Z") / 1000,
    title: "the September jobs report",
    detail: "The Bureau of Labor Statistics publishes it at 08:30 ET on Friday 2 October, an hour before the open, so Friday's opening price carries it.",
  })),
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

/** Where an event's open stands for protection, from when its sales open until it settles. */
export type EventPhase =
  | { phase: "before-sales"; salesOpen: number }
  /** Sales time has come, but the vault is still settling the open before (the quote service quotes the next open only once it has). */
  | { phase: "waiting" }
  | { phase: "on-sale"; salesClose: number }
  | { phase: "sales-closed" }
  | { phase: "bell-rung" }
  | { phase: "settled"; price: number };

/**
 * The phase at `now`. `nextOpen` is the open the quote service is selling
 * protection for; `stopBeforeOpenSecs` how long before an open its sales stop.
 */
export function eventPhase(
  e: MarketEvent,
  now: number,
  m: { nextOpen: number; holidays: ReadonlySet<string>; stopBeforeOpenSecs: number },
  settledPrice: number | null,
): EventPhase {
  if (settledPrice !== null) return { phase: "settled", price: settledPrice };
  if (now >= e.openTs) return { phase: "bell-rung" };
  const salesClose = e.openTs - m.stopBeforeOpenSecs;
  if (now >= salesClose) return { phase: "sales-closed" };
  const salesOpen = openBefore(e.openTs, m.holidays);
  if (now < salesOpen) return { phase: "before-sales", salesOpen };
  return m.nextOpen === e.openTs ? { phase: "on-sale", salesClose } : { phase: "waiting" };
}
