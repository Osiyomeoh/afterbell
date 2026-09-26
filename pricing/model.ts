/**
 * The distribution of the next opening print, from the stock's own history of
 * close-to-open moves (ported from Weekend Markets' gapModel, which the
 * backtest there checked on every TSLA opening since July).
 *
 * The history is kernel-smoothed rather than fitted to one normal curve, so a
 * tail move seen once keeps its weight. The result is a mixture of normal
 * components in log-price space, which is what makes put prices exact
 * (putSpread.ts): each component is a Black-Scholes put.
 */

/** One close-to-open move, from Pyth prints (first print at or after 16:00 ET and 09:30 ET). */
export type Opening = { from: string; to: string; close: number; open: number; weekend: boolean };

/** A normal component of the log move from now to the open. */
export type Component = { mean: number; sd: number };

export type OpeningModel = {
  source: "history" | "lognormal";
  /** Equal-weight mixture of the log move ln(open / spot). */
  components: Component[];
  /** Standard deviation of the log move (for display and strike spacing). */
  sd: number;
};

/** With fewer past openings than this, a lognormal at the stock's annual volatility is used instead. */
export const MIN_HISTORY = 10;
/** Smallest kernel bandwidth, so a short, quiet history can't price moves as impossible. */
const MIN_BANDWIDTH = 0.002;

export type ModelInputs = {
  /** The stock's annual volatility, for the fallback and for session time still to run. */
  annualVol: number;
  /** Calendar time from now to the open, in years (used only by the lognormal fallback). */
  years: number;
  /**
   * Regular-session time still to run before the open, in years of sessions.
   * Protection bought during a session is exposed to the rest of it as well
   * as the close-to-open move; zero once the session has closed.
   */
  sessionYears?: number;
};

export function openingModel(history: readonly Opening[], inputs: ModelInputs): OpeningModel {
  const sessionVar = inputs.annualVol ** 2 * Math.max(inputs.sessionYears ?? 0, 0);

  if (history.length < MIN_HISTORY) {
    const sd = Math.sqrt(inputs.annualVol ** 2 * Math.max(inputs.years, 0) + sessionVar);
    return { source: "lognormal", components: martingale([{ mean: 0, sd }]), sd };
  }

  // Log moves, recentred to average zero: the model prices the size and shape
  // of moves (many small rises, rare large drops), not a direction.
  const moves = history.map((o) => Math.log(o.open / o.close));
  const avg = moves.reduce((a, m) => a + m, 0) / moves.length;
  const centered = moves.map((m) => m - avg);
  const gapSd = Math.sqrt(centered.reduce((a, m) => a + m * m, 0) / (centered.length - 1));
  // Silverman's rule of thumb, widened by any session time still to run.
  const bandwidth = Math.sqrt(Math.max(0.9 * gapSd * centered.length ** -0.2, MIN_BANDWIDTH) ** 2 + sessionVar);
  return {
    source: "history",
    components: martingale(centered.map((mean) => ({ mean, sd: bandwidth }))),
    sd: Math.sqrt(gapSd ** 2 + sessionVar),
  };
}

/**
 * Shift every component by the same amount so the expected price at the open
 * equals the price now. The vault hedges with a perpetual, whose payoff is
 * linear in price, so the price (not its log) must carry no drift.
 */
function martingale(components: Component[]): Component[] {
  const growth = components.reduce((a, c) => a + Math.exp(c.mean + (c.sd * c.sd) / 2), 0) / components.length;
  const shift = Math.log(growth);
  return components.map((c) => ({ mean: c.mean - shift, sd: c.sd }));
}
