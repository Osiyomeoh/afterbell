import { boardPrice, type BoardPrice } from "@root/quoter/board";
import type { Stock } from "@root/quoter/stocks";

import { evmDeployment } from "./evmDeployment";
import { marketSnapshot, onSolanaVault, pricedStocks } from "./market";

/** Every stock the app prices, with standard cover on one share: which vault sells it now, or why it couldn't be priced. */
export type BoardRow = { symbol: string; name: string; solana: boolean; robinhood: boolean; settles: ("solana" | "robinhood")[] } & (
  | { price: BoardPrice }
  | { error: string }
);

const TTL_MS = 60_000;
/** Reads at once: each stock reads its settlement source (Chainlink on Robinhood Chain for most) and Hyperliquid. */
const PARALLEL = 6;
let cache: { at: number; rows: Promise<BoardRow[]> } | null = null;

export function board(): Promise<BoardRow[]> {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const rows = load();
    cache = { at: Date.now(), rows };
    rows.catch(() => (cache = null));
  }
  return cache.rows;
}

async function load(): Promise<BoardRow[]> {
  const stocks = pricedStocks();
  const evm = evmDeployment();
  const rows: BoardRow[] = new Array(stocks.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < stocks.length; i = next++) rows[i] = await row(stocks[i]!, !!evm?.feeds[stocks[i]!.symbol]);
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, stocks.length) }, worker));
  return rows;
}

async function row(stock: Stock, robinhood: boolean): Promise<BoardRow> {
  const base = {
    symbol: stock.symbol,
    name: stock.name,
    solana: onSolanaVault(stock),
    robinhood,
    settles: [...(stock.pyth ? (["solana"] as const) : []), ...(stock.chainlink ? (["robinhood"] as const) : [])],
  };
  try {
    const snap = await marketSnapshot(stock);
    return { ...base, price: boardPrice(Math.floor(Date.now() / 1000), snap.market) };
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
}
