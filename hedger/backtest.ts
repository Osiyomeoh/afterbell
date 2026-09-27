/**
 * Replays the hedge on past nights. Protection is sold at each close, priced
 * only from earlier openings, and paid on Pyth's opening print, as
 * pricing/backtest.ts does. It's hedged with a short in xyz:TSLA at
 * Hyperliquid's own prices: set once at the close, or rebalanced through
 * the night by the hedger's own rule (target.ts), then bought back at the
 * open. Pure: the script loads the openings and candles.
 */
import { martingale, MIN_HISTORY, openingModel, type Opening, type OpeningModel } from "../pricing/model";
import { hedgeShares, payout, priceProtection, type Protection } from "../pricing/putSpread";
import { nyTime, priceAt, type Candle } from "../research/lib";
import { DEFAULT_BAND, rebalance } from "./target";

export type PricePoint = { ts: number; px: number };

const HOUR_MS = 3_600_000;

/**
 * Hyperliquid's price at the close, every `stepMs` through the night, and at
 * the open: each the last trade before that moment. A moment with no trade in
 * `maxStaleMs` is left out (the hedge holds through it); a night missing its
 * close or open price is null, since neither end of the hedge could be priced.
 */
export function nightPath(candles: readonly Candle[], closeMs: number, openMs: number, stepMs: number, maxStaleMs: number): PricePoint[] | null {
  const at = (ts: number) => priceAt(candles, ts, maxStaleMs);
  const first = at(closeMs);
  const last = at(openMs);
  if (first === null || last === null) return null;
  const points: PricePoint[] = [{ ts: closeMs, px: first }];
  for (let ts = closeMs + stepMs; ts < openMs; ts += stepMs) {
    const px = at(ts);
    if (px !== null) points.push({ ts, px });
  }
  points.push({ ts: openMs, px: last });
  return points;
}

export type ReplayRules = {
  /** Time between rebalances, in ms; null holds the short set at the close until the open. */
  everyMs: number | null;
  /**
   * How much of the close-to-open move is still to come, given the hours left
   * to the open (1 is all of it). Without it, the whole move is priced at
   * every moment, as the hedger does today.
   */
  width?: (hoursToOpen: number) => number;
  /** The market's size step. */
  step: number;
  /** Paid on every trade's notional (0.00009 = 0.009%). */
  feeRate: number;
};

export type HedgeResult = {
  /** What the short made, fees taken off: bought back at the open, so nothing is left open. */
  pnl: number;
  fees: number;
  trades: number;
};

/**
 * One night's hedge: at each rebalance the target is the protection's delta
 * at that moment's price, traded when it leaves the hedger's dead band; at the
 * open the target is zero and the whole short is bought back.
 */
export function hedgeNight(model: OpeningModel, p: Protection, path: readonly PricePoint[], rules: ReplayRules): HedgeResult {
  if (path.length < 2) throw new Error("a night needs a close and an open");
  let short = 0;
  let cash = 0;
  let fees = 0;
  let trades = 0;
  let last = -Infinity;
  const openTs = path.at(-1)!.ts;
  path.forEach(({ ts, px }, k) => {
    const atOpen = k === path.length - 1;
    const due = k === 0 || (rules.everyMs !== null && ts - last >= rules.everyMs);
    if (!atOpen && !due) return;
    last = ts;
    const now = rules.width ? narrowed(model, rules.width((openTs - ts) / HOUR_MS)) : model;
    const hedge = atOpen ? 0 : hedgeShares(now, px, p);
    const r = rebalance(hedge, short, px, { step: rules.step, ...DEFAULT_BAND, maxNotional: Infinity });
    if (r.trade === 0) return;
    // A sell (positive trade) grows the short and takes in its price; a buy pays it.
    cash += r.trade * px;
    short += r.trade;
    fees += Math.abs(r.trade) * px * rules.feeRate;
    trades++;
  });
  if (Math.abs(short) > 1e-9) throw new Error("the short must be closed at the open");
  return { pnl: cash - fees, fees, trades };
}

export type Strategy = { name: string; everyMs: number | null; narrowing?: boolean } | { name: string; unhedged: true };

export type NightResult = {
  from: string;
  to: string;
  premium: number;
  paid: number;
  /** Per strategy, in order: the vault's result for the night, premium less payout plus the hedge. */
  pnl: number[];
  hedge: (HedgeResult | null)[];
  /** Whether earlier nights gave the narrowing hedge a measure of the move still to come; without one it hedges as the others do. */
  measured: boolean;
};

export type Backtest = {
  nights: NightResult[];
  /** Out-of-sample nights left out because Hyperliquid's candles don't price their close or open. */
  skipped: string[];
};

export type BacktestOptions = {
  shares: number;
  /** Protection from this far below the close ... */
  deductible: number;
  /** ... down to this far. */
  depth: number;
  annualVol: number;
  margin: number;
  step: number;
  feeRate: number;
  pathStepMs: number;
  maxStaleMs: number;
};

export function backtestHedges(openings: readonly Opening[], candles: readonly Candle[], strategies: readonly Strategy[], o: BacktestOptions): Backtest {
  const nights: NightResult[] = [];
  const skipped: string[] = [];
  for (let i = MIN_HISTORY; i < openings.length; i++) {
    const night = openings[i]!;
    const path = nightPath(candles, nyTime(night.from, 16), nyTime(night.to, 9, 30), o.pathStepMs, o.maxStaleMs);
    if (!path) {
      skipped.push(`${night.from} → ${night.to}`);
      continue;
    }
    const model = openingModel(openings.slice(0, i), { annualVol: o.annualVol, years: 0 });
    const p: Protection = { shares: o.shares, upper: night.close * (1 - o.deductible), lower: night.close * (1 - o.depth) };
    const premium = priceProtection(model, night.close, p, o.margin).premium;
    const paid = payout(p, night.open);
    // Measured on earlier nights only, as the model is.
    const remaining = strategies.some((s) => "narrowing" in s && s.narrowing) ? remainingMove(openings.slice(0, i), candles, o.maxStaleMs) : [];
    const width = remaining.length > 0 ? widthAt(remaining) : undefined;
    const hedge = strategies.map((s) =>
      "unhedged" in s ? null : hedgeNight(model, p, path, { everyMs: s.everyMs, step: o.step, feeRate: o.feeRate, width: s.narrowing ? width : undefined }),
    );
    nights.push({ from: night.from, to: night.to, premium, paid, pnl: hedge.map((h) => premium - paid + (h?.pnl ?? 0)), hedge, measured: width !== undefined });
  }
  return { nights, skipped };
}

/** The model of the move still to come: every component's log move scaled by `k`, then re-centred so the price carries no drift. */
export function narrowed(model: OpeningModel, k: number): OpeningModel {
  if (!(k > 0)) throw new Error("the width still to come must be above 0");
  return { source: model.source, components: martingale(model.components.map((c) => ({ mean: c.mean * k, sd: c.sd * k }))), sd: model.sd * k };
}

/** Hours before the open at which the move still to come is measured: weeknights reach 17.5, weekends 65.5. */
export const REMAINING_HOURS = [0.25, 0.5, 1, 2, 3, 4, 6, 8, 10, 12, 14, 16, 17.5, 24, 36, 48, 65.5];
/** Nights a measurement needs before it's used. */
export const MIN_REMAINING_NIGHTS = 8;

export type Remaining = { hours: number; nights: number; ratio: number }[];

/**
 * How much of the close-to-open move is still to come each number of hours
 * before the open: over the nights long enough to have that moment and a
 * Hyperliquid price at it, the root mean square of ln(open / Hyperliquid's
 * price then), over that of ln(open / close) on the same nights. 1 means the
 * price then says no more about the open than the close did; near 0, the move
 * has already happened. Hours with fewer than `minNights` nights are left out.
 */
export function remainingMove(nights: readonly Opening[], candles: readonly Candle[], maxStaleMs: number, minNights = MIN_REMAINING_NIGHTS, hours = REMAINING_HOURS): Remaining {
  return hours.flatMap((h) => {
    let then = 0;
    let close = 0;
    let n = 0;
    for (const night of nights) {
      const openMs = nyTime(night.to, 9, 30);
      const ts = openMs - h * HOUR_MS;
      if (ts < nyTime(night.from, 16)) continue;
      const px = priceAt(candles, ts, maxStaleMs);
      if (px === null) continue;
      then += Math.log(night.open / px) ** 2;
      close += Math.log(night.open / night.close) ** 2;
      n++;
    }
    return n >= minNights && close > 0 ? [{ hours: h, nights: n, ratio: Math.sqrt(then / close) }] : [];
  });
}

/**
 * The share of the move still to come at any number of hours before the open:
 * straight lines between the measured hours, the nearest measurement beyond
 * them, and never under `floor`, so the model never claims the open is known.
 */
export function widthAt(r: Remaining, floor = 0.05): (hoursToOpen: number) => number {
  if (r.length === 0) throw new Error("nothing measured");
  return (h) => {
    const after = r.findIndex((x) => x.hours >= h);
    const k = after === -1 ? r.at(-1)!.ratio : after === 0 ? r[0]!.ratio : lerp(r[after - 1]!, r[after]!, h);
    return Math.max(k, floor);
  };
}

const lerp = (a: { hours: number; ratio: number }, b: { hours: number; ratio: number }, h: number) => a.ratio + ((b.ratio - a.ratio) * (h - a.hours)) / (b.hours - a.hours);
