/** One reserve of a Kamino lending market, as Kamino's public API reports it. */
export type KaminoReserve = { liquidityToken: string; totalSupplyUsd: number; totalBorrowUsd: number };
export type KaminoMarket = { name: string; address: string; reserves: KaminoReserve[] };

/** Kamino's markets that take tokenized stocks as collateral (from https://api.kamino.finance/v2/kamino-market, 28 Sep 2026). */
export const KAMINO_STOCK_MARKETS = [
  { name: "xStocks Market", address: "5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua" },
  { name: "Sentora xStocks Market", address: "8BNUWRSibVasaAmhYpBCFpGgMisGKfVAf9ho3Cmf6vjr" },
  { name: "STRCx Market", address: "B7a2Dmdnfg8zfZX2814d6Xo6ctxs22jnTuCcjTq5KcPD" },
] as const;

/** An xStock's token name is its stock's ticker with an "x" (SPYx, TSLAx); anything else in these markets is lent, not a stock. */
export const stockOf = (token: string) => (/^[A-Z]{1,6}x$/.test(token) ? token.slice(0, -1) : null);

export type KaminoBook = {
  /** Tokenized-stock collateral by stock, summed over the markets, in dollars. */
  collateral: { symbol: string; usd: number }[];
  collateralUsd: number;
  /** What's borrowed against it: every non-stock reserve's borrows. */
  borrowedUsd: number;
};

/** The stocks Kamino holds as collateral, and what's borrowed against them, from its markets' reserves. */
export function kaminoBook(markets: readonly KaminoMarket[]): KaminoBook {
  const bySymbol = new Map<string, number>();
  let borrowedUsd = 0;
  for (const m of markets) {
    for (const r of m.reserves) {
      const symbol = stockOf(r.liquidityToken);
      if (symbol) bySymbol.set(symbol, (bySymbol.get(symbol) ?? 0) + r.totalSupplyUsd);
      else borrowedUsd += r.totalBorrowUsd;
    }
  }
  const collateral = [...bySymbol].map(([symbol, usd]) => ({ symbol, usd })).filter((c) => c.usd >= 1).sort((a, b) => b.usd - a.usd);
  return { collateral, collateralUsd: collateral.reduce((t, c) => t + c.usd, 0), borrowedUsd };
}
