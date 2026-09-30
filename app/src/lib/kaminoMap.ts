/**
 * The liquidation map: how much of Kamino's lending against tokenized stocks becomes liquidatable if the
 * stocks open down. Pure; the loans come from a snapshot (research/kamino-loans.ts).
 */

/** One loan: its debt (weighted by borrow factor, as Kamino compares it) and each deposit. */
export type MapLoan = {
  market: string;
  debt: number;
  /** `symbol` is the tokenized stock's ticker, or null for anything else (USDC, cbBTC). */
  deposits: { symbol: string | null; value: number; liquidationLtv: number }[];
};

export type MapRow = { gap: number; loans: number; debt: number; collateral: number };

/** The limit a loan's debt must stay under, with each stock down by `gapOf(symbol)` (a fraction). */
export function limitAfter(loan: MapLoan, gapOf: (symbol: string) => number): number {
  return loan.deposits.reduce((t, d) => t + d.value * d.liquidationLtv * (d.symbol ? 1 - gapOf(d.symbol) : 1), 0);
}

/** The loans that can be liquidated if every stock opens `gapOf(symbol)` down, and what they hold. */
export function liquidatable(loans: readonly MapLoan[], gapOf: (symbol: string) => number): Omit<MapRow, "gap"> {
  const hit = loans.filter((l) => l.debt > limitAfter(l, gapOf));
  return {
    loans: hit.length,
    debt: hit.reduce((t, l) => t + l.debt, 0),
    collateral: hit.reduce((t, l) => t + l.deposits.reduce((s, d) => s + d.value, 0), 0),
  };
}

/** The map: for each gap, with every stock opening that far down at once. Gap 0 is what's liquidatable already. */
export function liquidationCurve(loans: readonly MapLoan[], gaps: readonly number[]): MapRow[] {
  return gaps.map((gap) => ({ gap, ...liquidatable(loans, () => gap) }));
}
