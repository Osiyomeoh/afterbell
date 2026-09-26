/**
 * Keeping the history of openings current: each trading day's close paired
 * with the next day's open, from Pyth prints (the first at or after 16:00 ET,
 * or the early close, and the first at or after 09:30 ET), as in
 * research/data/pyth-tsla-gaps.json. Ported from Weekend Markets' gaps script.
 */
import type { Opening } from "../pricing/model";
import { sessionsFrom, type EarlyCloses } from "./calendar";

export type Print = { price: number; publishTime: number };
/** The first print at or after a time, or null if none came soon after it (no session). */
export type PrintAt = (ts: number) => Promise<Print | null>;

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
        date: day.date,
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
      // Anything longer than a weeknight: a weekend or a holiday.
      weekend: (s.open.publishTime - prev.close.publishTime) / 3600 > 24,
    });
  }
  return out;
}
