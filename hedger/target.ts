/**
 * The hedger's rule, pure: the short in a stock that offsets what the vaults
 * have sold in it (every open position's delta, from the model the quoter
 * prices with), and the trade that moves the current short there. The chains,
 * Hyperliquid and the clock are the caller's.
 */
import type { OpeningModel } from "../pricing/model";
import { hedgeShares, maxPayout, type Protection } from "../pricing/putSpread";

/** An open position on either chain, in shares and dollars. */
export type OpenPosition = Protection & {
  symbol: string;
  /** Unix seconds of the 09:30 ET open it settles on. */
  openTs: number;
};

export type OpenExposure = {
  openTs: number;
  positions: number;
  shares: number;
  maxPayout: number;
  /** The short that hedges these positions, in shares. */
  hedge: number;
};

export type Exposure = {
  symbol: string;
  /** The price the hedge was sized at. */
  spot: number;
  /** One entry per open with positions still waiting for it, soonest first. */
  opens: OpenExposure[];
  /** The short that hedges them all, in shares. */
  hedge: number;
};

/**
 * One stock's exposure at `now`: its open positions grouped by the open they
 * settle on, and the short that hedges them at `spot`. A position whose open
 * has come no longer counts, settled or not: its price is fixed.
 */
export function exposure(now: number, symbol: string, positions: readonly OpenPosition[], spot: number, modelFor: (openTs: number) => OpeningModel): Exposure {
  if (!(spot > 0)) throw new Error("no price to size the hedge at");
  const byOpen = new Map<number, OpenPosition[]>();
  for (const p of positions) {
    if (p.symbol !== symbol || p.openTs <= now) continue;
    byOpen.set(p.openTs, [...(byOpen.get(p.openTs) ?? []), p]);
  }
  const opens = [...byOpen.entries()]
    .sort(([a], [b]) => a - b)
    .map(([openTs, ps]) => {
      const model = modelFor(openTs);
      return {
        openTs,
        positions: ps.length,
        shares: ps.reduce((a, p) => a + p.shares, 0),
        maxPayout: ps.reduce((a, p) => a + maxPayout(p), 0),
        hedge: ps.reduce((a, p) => a + hedgeShares(model, spot, p), 0),
      };
    });
  return { symbol, spot, opens, hedge: opens.reduce((a, o) => a + o.hedge, 0) };
}

export type HedgeRules = {
  /** The market's size step (Hyperliquid's szDecimals: 0.001 for xyz:TSLA). */
  step: number;
  /**
   * The dead band: a gap to the target smaller than both of these isn't
   * traded, so the hedge doesn't churn on every small move.
   */
  minShares: number;
  minNotional: number;
  /** The most the short may be worth. Above it the hedge is partial. */
  maxNotional: number;
};

export const DEFAULT_BAND = { minShares: 0.01, minNotional: 10 } as const;

export type Rebalance = {
  /** The short to hold, in shares: the hedge rounded to the step, and capped. */
  target: number;
  /** The cap cut the target below the hedge. */
  capped: boolean;
  /** Shares to sell (the short grows) when positive, to buy back when negative; 0 to hold. */
  trade: number;
  /** A buy that only shrinks the short, never turns it long: send it reduce-only. */
  reduceOnly: boolean;
  note: string;
};

/**
 * The trade from `current` (the short held now, in shares; negative would be
 * a long) to the target for `hedge` at `price`. Inside the dead band it
 * holds, except that a target of zero always closes what's left: after the
 * open nothing is left to hedge.
 */
export function rebalance(hedge: number, current: number, price: number, rules: HedgeRules): Rebalance {
  if (!(price > 0)) throw new Error("no price to size the hedge at");
  if (!(hedge >= 0)) throw new Error("the hedge must not be negative");
  const { step } = rules;
  const dp = Math.max(0, Math.round(-Math.log10(step)));
  const size = (steps: number) => Number((steps * step).toFixed(dp));

  const hedgeSteps = Math.round(hedge / step);
  const capSteps = Math.floor(rules.maxNotional / price / step + 1e-9);
  const targetSteps = Math.min(hedgeSteps, capSteps);
  const currentSteps = Math.round(current / step);
  const tradeSteps = targetSteps - currentSteps;
  const target = size(targetSteps);
  const capped = hedgeSteps > capSteps;
  const hold = (note: string): Rebalance => ({ target, capped, trade: 0, reduceOnly: false, note });

  if (tradeSteps === 0) return hold(`hold: short ${size(currentSteps)}, at the target`);
  const gap = Math.abs(tradeSteps) * step;
  if (targetSteps > 0 && gap < Math.max(rules.minShares, rules.minNotional / price)) {
    return hold(`hold: short ${size(currentSteps)}, ${size(Math.abs(tradeSteps))} from the target ${target}, inside the dead band`);
  }
  const trade = size(tradeSteps);
  const reduceOnly = tradeSteps < 0 && currentSteps > 0;
  const note =
    tradeSteps > 0
      ? `sell ${trade} to short ${target}`
      : targetSteps === 0
        ? `buy back ${-trade}: nothing left to hedge`
        : `buy back ${-trade} to short ${target}`;
  return { target, capped, trade, reduceOnly, note: capped ? `${note} (capped at $${rules.maxNotional} of notional; the hedge is ${size(hedgeSteps)})` : note };
}
