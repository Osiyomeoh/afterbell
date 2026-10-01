import { stockOf } from "./kamino";

/** Kamino's scaled fractions ("…Sf") are fixed-point numbers with 60 fractional bits. */
const SF = 2 ** 60;

/** The parts of an obligation Kamino's API returns (`/kamino-market/{market}/users/{wallet}/obligations`) that a loan's risk needs. */
export type KaminoObligation = {
  obligationAddress: string;
  state: { lendingMarket: string; deposits: { depositReserve: string; marketValueSf: string }[] };
  /** At current prices, in dollars, as decimal strings. */
  refreshedStats: { userTotalBorrowBorrowFactorAdjusted: string; borrowLiquidationLimit: string; userTotalDeposit: string };
};

export type KaminoLoan = {
  obligation: string;
  market: string;
  /** What's borrowed, weighted by each asset's borrow factor, as Kamino compares it with the limit. */
  debtUsd: number;
  /** Debt above this makes the loan liquidatable: each deposit's value times its liquidation threshold. */
  liquidationLimitUsd: number;
  depositUsd: number;
  /** Tokenized stocks deposited as collateral, by stock, at current prices. */
  stocks: { symbol: string; usd: number }[];
};

/** Below this, in dollars, a loan is dust: an emptied obligation with cents left. */
const MIN_USD = 1;

/**
 * A loan from Kamino's obligation, or null when it borrows nothing (or dust) or holds no tokenized stock.
 * `tokenOfReserve` names each reserve's token (SPYx, USDC). Each deposit's value is its share of the
 * refreshed total: the per-deposit values are as of the obligation's last refresh, the total is current.
 */
export function toLoan(o: KaminoObligation, tokenOfReserve: ReadonlyMap<string, string>): KaminoLoan | null {
  const debtUsd = Number(o.refreshedStats.userTotalBorrowBorrowFactorAdjusted);
  const depositUsd = Number(o.refreshedStats.userTotalDeposit);
  if (!(debtUsd >= MIN_USD && depositUsd >= MIN_USD)) return null;
  const deposits = o.state.deposits.map((d) => ({ token: tokenOfReserve.get(d.depositReserve), value: Number(d.marketValueSf) / SF })).filter((d) => d.value > 0);
  const total = deposits.reduce((t, d) => t + d.value, 0);
  const bySymbol = new Map<string, number>();
  for (const d of deposits) {
    const symbol = d.token && stockOf(d.token);
    if (symbol) bySymbol.set(symbol, (bySymbol.get(symbol) ?? 0) + (d.value / total) * depositUsd);
  }
  if (bySymbol.size === 0) return null;
  return {
    obligation: o.obligationAddress,
    market: o.state.lendingMarket,
    debtUsd,
    liquidationLimitUsd: Number(o.refreshedStats.borrowLiquidationLimit),
    depositUsd,
    stocks: [...bySymbol].map(([symbol, usd]) => ({ symbol, usd })).sort((a, b) => b.usd - a.usd),
  };
}

/**
 * How far a loan's stocks can open below their price before it can be liquidated, as a fraction:
 * `together` if they all fall by the same share, and each stock falling `alone`. 0 when it can be
 * liquidated already; null when the stocks can't bring it there on their own. It uses the loan's
 * average liquidation threshold, exact when its collateral shares one threshold.
 */
export function loanRisk(loan: KaminoLoan): { together: number | null; alone: { symbol: string; gap: number | null }[] } {
  const room = loan.liquidationLimitUsd - loan.debtUsd;
  const threshold = loan.liquidationLimitUsd / loan.depositUsd;
  const gap = (usd: number) => (room <= 0 ? 0 : room / (usd * threshold) < 1 ? room / (usd * threshold) : null);
  return {
    together: gap(loan.stocks.reduce((t, s) => t + s.usd, 0)),
    alone: loan.stocks.map((s) => ({ symbol: s.symbol, gap: gap(s.usd) })),
  };
}

/** The deepest protection the gap report prices, in percent below the price. */
const MAX_STOP = 50;

/**
 * Protection sized to the loan, in percent below the price, as the gap report takes it: from 2% down
 * to the gap that liquidates it, so it pays the most exactly there. The usual 2% to 10% when the
 * stocks can't liquidate it within 50%, or when it can be liquidated already.
 */
export function loanBand(together: number | null): { start: number; stop: number; toLiquidation: boolean } {
  if (together === null || together * 100 > MAX_STOP || together < 0.005) return { start: 2, stop: 10, toLiquidation: false };
  const stop = Math.floor(together * 1000) / 10;
  return { start: stop > 4 ? 2 : Math.floor(stop * 5) / 10, stop, toLiquidation: true };
}
