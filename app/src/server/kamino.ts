import { KAMINO_STOCK_MARKETS, kaminoBook, type KaminoBook, type KaminoMarket } from "@/lib/kamino";

import { bookReport, type BookReport } from "./gapBook";
import { pricedStock } from "./market";

const API = "https://api.kamino.finance";
const TTL_MS = 10 * 60_000;

export type KaminoView = KaminoBook & {
  markets: { name: string; address: string }[];
  /** Stocks held that the quote service doesn't price, left out of the report. */
  uncovered: { symbol: string; usd: number }[];
  /** Protection from 2% to 10% below each price until the next open, for everything covered. */
  report: BookReport;
  readAt: number;
};

let cache: { at: number; view: Promise<KaminoView> } | null = null;

/** Kamino's tokenized-stock collateral, read from its public API, and the gap report for it. Cached for 10 minutes. */
export function kaminoView(): Promise<KaminoView> {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const view = load();
    cache = { at: Date.now(), view };
    view.catch(() => (cache = null));
  }
  return cache.view;
}

async function load(): Promise<KaminoView> {
  const markets: KaminoMarket[] = await Promise.all(
    KAMINO_STOCK_MARKETS.map(async (m) => {
      const res = await fetch(`${API}/kamino-market/${m.address}/reserves/metrics`, { cache: "no-store" });
      if (!res.ok) throw new Error(`Kamino's API answered ${res.status} for ${m.name}`);
      const reserves = (await res.json()) as { liquidityToken: string; totalSupplyUsd: string | number; totalBorrowUsd: string | number }[];
      return { ...m, reserves: reserves.map((r) => ({ liquidityToken: r.liquidityToken, totalSupplyUsd: Number(r.totalSupplyUsd), totalBorrowUsd: Number(r.totalBorrowUsd) })) };
    }),
  );
  const book = kaminoBook(markets);
  const covered = book.collateral.filter((c) => pricedStock(c.symbol));
  const report = await bookReport(covered.map((c) => ({ symbol: c.symbol, value: c.usd })), 2, 10);
  return {
    ...book,
    markets: KAMINO_STOCK_MARKETS.map(({ name, address }) => ({ name, address })),
    uncovered: book.collateral.filter((c) => !pricedStock(c.symbol)),
    report,
    readAt: Math.floor(Date.now() / 1000),
  };
}
