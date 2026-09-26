/**
 * Replays protection on every recorded opening. At each close, protection is
 * priced only from the openings before it (no look-ahead) and paid by the
 * actual opening print. Out-of-sample nights are those with at least
 * MIN_HISTORY earlier openings.
 */
import { MIN_HISTORY, openingModel, type Opening } from "./model";
import { payout, priceProtection, type Protection } from "./putSpread";

export type Structure = {
  /** Protection starts this far below the close (0.01 = 1%). */
  deductible: number;
  /** Protection stops this far below the close. */
  depth: number;
};

export type BacktestNight = { from: string; to: string; close: number; open: number; premium: number; paid: number };

export type BacktestResult = {
  nights: BacktestNight[];
  premium: number;
  paid: number;
  /** Paid out per dollar of premium. Below 1: the vault kept money; above 1: it lost. */
  paidPerDollar: number;
  paidNights: number;
};

export function backtest(
  openings: readonly Opening[],
  structure: Structure,
  opts: { shares: number; annualVol: number; margin: number },
): BacktestResult {
  const nights: BacktestNight[] = [];
  for (let i = MIN_HISTORY; i < openings.length; i++) {
    const o = openings[i]!;
    // Priced at the close with no session left: the model sees only earlier openings.
    const model = openingModel(openings.slice(0, i), { annualVol: opts.annualVol, years: 0 });
    const p: Protection = {
      shares: opts.shares,
      upper: o.close * (1 - structure.deductible),
      lower: o.close * (1 - structure.depth),
    };
    const price = priceProtection(model, o.close, p, opts.margin);
    nights.push({ from: o.from, to: o.to, close: o.close, open: o.open, premium: price.premium, paid: payout(p, o.open) });
  }
  const premium = nights.reduce((a, n) => a + n.premium, 0);
  const paid = nights.reduce((a, n) => a + n.paid, 0);
  return { nights, premium, paid, paidPerDollar: premium > 0 ? paid / premium : NaN, paidNights: nights.filter((n) => n.paid > 0).length };
}
