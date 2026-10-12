/**
 * Prices protection: a put spread on the opening print. It pays
 * `shares × clamp(upper − open, 0, upper − lower)`: nothing above `upper` (the
 * holder's deductible), the whole loss between `upper` and `lower`, and never
 * more than `shares × (upper − lower)`. With `lower = 0` it is a plain put.
 *
 * Under an OpeningModel (a mixture of normals in log price) each component's
 * put has the Black-Scholes closed form with zero rates, so prices are exact,
 * not simulated.
 */
import type { Component, OpeningModel } from "./model";

/** Standard normal CDF (Zelen & Severo 26.2.17, absolute error < 7.5e-8). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const tail = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - tail : tail;
}

/** E[(strike − spot·e^X)⁺] for X ~ N(mean, sd²). */
function componentPut(c: Component, spot: number, strike: number): number {
  if (strike <= 0) return 0;
  if (c.sd === 0) return Math.max(strike - spot * Math.exp(c.mean), 0);
  const d = (Math.log(strike / spot) - c.mean) / c.sd;
  return strike * normCdf(d) - spot * Math.exp(c.mean + (c.sd * c.sd) / 2) * normCdf(d - c.sd);
}

/** Expected payout per share of a put struck at `strike`. */
export function expectedPut(model: OpeningModel, spot: number, strike: number): number {
  const sum = model.components.reduce((a, c) => a + componentPut(c, spot, strike), 0);
  return Math.max(sum / model.components.length, 0);
}

/** Probability the opening print is below `strike`. */
export function probabilityBelow(model: OpeningModel, spot: number, strike: number): number {
  if (strike <= 0) return 0;
  const x = Math.log(strike / spot);
  const sum = model.components.reduce((a, c) => a + (c.sd === 0 ? (c.mean < x ? 1 : 0) : normCdf((x - c.mean) / c.sd)), 0);
  return sum / model.components.length;
}

/**
 * How much a put's expected payout per share rises for each $1 the price
 * falls: E[e^X; spot·e^X < strike], its delta without the minus sign. The
 * short, in shares, that hedges it.
 */
export function putDelta(model: OpeningModel, spot: number, strike: number): number {
  if (strike <= 0) return 0;
  const x = Math.log(strike / spot);
  const sum = model.components.reduce((a, c) => {
    if (c.sd === 0) return a + (c.mean < x ? Math.exp(c.mean) : 0);
    return a + Math.exp(c.mean + (c.sd * c.sd) / 2) * normCdf((x - c.mean) / c.sd - c.sd);
  }, 0);
  return sum / model.components.length;
}

export type Protection = {
  shares: number;
  /** Protection starts below this price (the holder's deductible sits above it). */
  upper: number;
  /** Protection stops below this price; 0 for a plain put. */
  lower: number;
};

export function validate(p: Protection): void {
  if (!(p.shares > 0)) throw new Error("shares must be positive");
  if (!(p.upper > p.lower)) throw new Error("upper must be above lower");
  if (!(p.lower >= 0)) throw new Error("lower must not be negative");
}

/** What the protection pays at an opening print. */
export function payout(p: Protection, open: number): number {
  return p.shares * Math.min(Math.max(p.upper - open, 0), p.upper - p.lower);
}

export const maxPayout = (p: Protection) => p.shares * (p.upper - p.lower);

/** The short, in shares, that hedges protection at `spot`: how much its expected payout rises per $1 fall. */
export function hedgeShares(model: OpeningModel, spot: number, p: Protection): number {
  validate(p);
  return p.shares * Math.max(putDelta(model, spot, p.upper) - putDelta(model, spot, p.lower), 0);
}

export type Price = {
  /** Expected payout under the model: the fair premium. */
  expectedPayout: number;
  /** What the buyer pays: the fair premium plus the vault's margin. */
  premium: number;
  maxPayout: number;
  /** Probability the protection pays anything. */
  probabilityOfPayout: number;
};

/**
 * Prices protection at the model's odds plus `margin` (0.1 = 10% over fair),
 * and never below `minRate` of the most it can pay (0.005 = 0.5%).
 */
export function priceProtection(model: OpeningModel, spot: number, p: Protection, margin: number, minRate = 0): Price {
  validate(p);
  if (margin < 0) throw new Error("margin must not be negative");
  if (!(minRate >= 0 && minRate < 1)) throw new Error("minRate must be at least 0 and below 1");
  const perShare = expectedPut(model, spot, p.upper) - expectedPut(model, spot, p.lower);
  const expectedPayout = p.shares * Math.min(Math.max(perShare, 0), p.upper - p.lower);
  return {
    expectedPayout,
    premium: Math.max(expectedPayout * (1 + margin), minRate * maxPayout(p)),
    maxPayout: maxPayout(p),
    probabilityOfPayout: probabilityBelow(model, spot, p.upper),
  };
}
