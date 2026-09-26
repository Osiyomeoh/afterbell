/**
 * Keeping the history of openings current: each trading day's close paired
 * with the next day's open, read the way the settlement source settles. From
 * Pyth, the first print at or after 16:00 ET (or the early close) and 09:30 ET,
 * as in research/data/pyth-tsla-gaps.json; from Chainlink, the round in force
 * at those times, as in research/data/chainlink-gaps.json. Ported from
 * Weekend Markets' gaps script.
 */
import type { Opening } from "../pricing/model";
import { sessionsFrom, type EarlyCloses } from "./calendar";

export type Print = { price: number; publishTime: number };
/**
 * The price at a time as the settlement source gives it (Pyth: the first print
 * at or after it; Chainlink: the round in force at it), or null if there was
 * none (no session).
 */
export type PrintAt = (ts: number) => Promise<Print | null>;

/** A Chainlink round: its price and when it was published (unix seconds). */
export type PriceRound = { answer: number; updatedAt: number };

/**
 * Chainlink's price at a time: the last round published at or before it, as
 * the EVM vault settles, or null when that round is older than `maxAgeSecs`
 * (the vault's maxRoundAge) or there is none. `rounds` oldest first.
 */
export function roundPrintAt(rounds: readonly PriceRound[], maxAgeSecs: number): PrintAt {
  return async (ts) => {
    let lo = 0;
    let hi = rounds.length - 1;
    let found: PriceRound | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rounds[mid]!.updatedAt <= ts) {
        found = rounds[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (!found || ts - found.updatedAt > maxAgeSecs || !(found.answer > 0)) return null;
    return { price: found.answer, publishTime: found.updatedAt };
  };
}

/**
 * Openings after the last one in `history`, through the latest open at or
 * before `now`. A day with no prints (a holiday the schedule no longer lists)
 * is skipped, so its neighbours pair up across it.
 */
export async function newOpenings(history: readonly Opening[], printAt: PrintAt, now: number, holidays: ReadonlySet<string> = new Set(), earlyCloses: EarlyCloses = new Map()): Promise<Opening[]> {
  const last = history[history.length - 1];
  if (!last) throw new Error("the history is empty; build it with the full refresh");
  const days = sessionsFrom(last.to, now, holidays, earlyCloses);
  const sessions = (
    await Promise.all(
      days.map(async (day) => ({
        ...day,
        open: await printAt(day.openTs),
        close: day.closeTs <= now ? await printAt(day.closeTs) : null,
      })),
    )
  ).filter((s) => s.open || s.close);

  const out: Opening[] = [];
  for (let i = 1; i < sessions.length; i++) {
    const prev = sessions[i - 1]!;
    const s = sessions[i]!;
    if (!prev.close || !s.open) continue;
    out.push({
      from: prev.date,
      to: s.date,
      close: prev.close.price,
      open: s.open.price,
      // Anything longer than a weeknight: a weekend or a holiday. From the bells,
      // not the prints: a Chainlink round in force at 09:30 can be hours old.
      weekend: (s.openTs - prev.closeTs) / 3600 > 24,
    });
  }
  return out;
}

/**
 * Annual volatility from the closes in a history of openings (close to next
 * close, a weekend counting as one day), for a stock whose history is too new
 * for a published figure.
 */
export function annualVolFrom(history: readonly Opening[]): number {
  const moves: number[] = [];
  for (let i = 1; i < history.length; i++) moves.push(Math.log(history[i]!.close / history[i - 1]!.close));
  if (moves.length < 2) throw new Error("need at least three closes");
  const avg = moves.reduce((a, m) => a + m, 0) / moves.length;
  const variance = moves.reduce((a, m) => a + (m - avg) ** 2, 0) / (moves.length - 1);
  return Math.sqrt(variance * 252);
}
