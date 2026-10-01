import { PublicKey } from "@solana/web3.js";

import { parseBook, type BookLine } from "@root/quoter/gapReport";

import { bookReport } from "@/server/gapBook";
import { tslaHoldings } from "@/server/holdings";

export const dynamic = "force-dynamic";

const MAX_STOCKS = 20;

/**
 * A gap report for a book: `?book=TSLA:100,NVDA:$25000` (shares, or dollars
 * with $), and/or `?owner=<Solana wallet>` to add the TSLAx and TSLAon it holds
 * on mainnet. `start` and `stop` set the protection, in percent below the
 * price (default 2 and 10). Read-only: it prices, it doesn't sell.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const start = Number(q.get("start") ?? 2);
  const stop = Number(q.get("stop") ?? 10);
  if (!(start >= 0 && stop > start && stop <= 50)) return Response.json({ error: "start and stop are percent below the price, with 0 <= start < stop <= 50" }, { status: 400 });

  let book: BookLine[] = [];
  try {
    if (q.get("book")) book = parseBook(q.get("book")!);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }

  let wallet: { owner: string; holdings: { symbol: string; shares: number }[] } | null = null;
  const owner = q.get("owner");
  if (owner) {
    let key: PublicKey;
    try {
      key = new PublicKey(owner);
    } catch {
      return Response.json({ error: "owner must be a Solana address" }, { status: 400 });
    }
    try {
      wallet = { owner, holdings: await tslaHoldings(key) };
    } catch (e) {
      return Response.json({ error: `couldn't read the wallet: ${(e as Error).message}` }, { status: 503 });
    }
    book = [...book, ...wallet.holdings.map((h) => ({ symbol: "TSLA", shares: h.shares }))];
  }
  if (book.length === 0) return Response.json({ error: owner ? `${owner} holds no TSLAx or TSLAon on mainnet` : "give book, owner, or both" }, { status: 400 });

  const symbols = [...new Set(book.map((l) => l.symbol.toUpperCase()))];
  if (symbols.length > MAX_STOCKS) return Response.json({ error: `at most ${MAX_STOCKS} stocks` }, { status: 400 });

  try {
    return Response.json({ ...(await bookReport(book, start, stop)), wallet });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
