import { gapReport, type BookLine, type GapReport } from "@root/quoter/gapReport";
import { DEFAULT_QUOTER_CONFIG, type Market } from "@root/quoter/quoter";
import { stockBySymbol } from "@root/quoter/stocks";

import { marketSnapshot, pricedStock } from "./market";

export type BookReport = GapReport & { names: Record<string, string> };

/**
 * A gap report for `book`, with protection from `start` to `stop` percent
 * below each price: each stock's market read as the quoter reads it, and one
 * that can't be read right now reported in `skipped` rather than failing the rest.
 */
export async function bookReport(book: BookLine[], start: number, stop: number): Promise<BookReport> {
  const symbols = [...new Set(book.map((l) => l.symbol.toUpperCase()))];
  const unreadable: { symbol: string; reason: string }[] = [];
  const markets = new Map<string, Market | null>(
    await Promise.all(
      symbols.map(async (symbol): Promise<[string, Market | null]> => {
        const stock = pricedStock(symbol);
        if (!stock) return [symbol, null];
        try {
          return [symbol, (await marketSnapshot(stock)).market];
        } catch (e) {
          unreadable.push({ symbol, reason: `couldn't read its price: ${(e as Error).message}` });
          return [symbol, null];
        }
      }),
    ),
  );
  const readable = book.filter((l) => !unreadable.some((u) => u.symbol === l.symbol.toUpperCase()));
  const report = gapReport(Math.floor(Date.now() / 1000), readable, markets, { deductible: start / 100, depth: stop / 100 }, DEFAULT_QUOTER_CONFIG);
  const names = Object.fromEntries(report.lines.map((l) => [l.symbol, stockBySymbol(l.symbol)?.name ?? l.symbol]));
  return { ...report, skipped: [...report.skipped, ...unreadable], names };
}
