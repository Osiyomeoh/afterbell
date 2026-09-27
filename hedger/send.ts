/**
 * Sends what a plan decided. The hedger's order goes out alone, after
 * setting the position's margin when the order opens it; the quoter's stale
 * quotes are cancelled before new ones go up, so an old quote never rests
 * beside its replacement and the margin it held is free again.
 */
import { cancelOrders, placeOrders, setLeverage, type Exchange, type OrderResult } from "./exchange";
import type { HedgeAccount } from "./info";
import type { HedgePlan } from "./plan";
import type { QuoteRefresh } from "./quotes";

export type SentHedge = {
  /** The leverage set on the position before opening it, or null when it was left as it was. */
  leverage: number | null;
  /** The order's outcome, or null when the plan held. */
  result: OrderResult | null;
};

/**
 * The hedge opens a position isolated at `leverage`, so a loss can't reach
 * past its own margin. Hyperliquid fixes an asset's margin mode once a
 * position is open, so it's set only when the account holds none.
 */
export async function sendHedge(ex: Exchange, plan: HedgePlan, account: HedgeAccount, leverage: number): Promise<SentHedge> {
  const order = plan.order;
  if (!order) return { leverage: null, result: null };
  const opens = !order.b && account.position === null;
  if (opens) await setLeverage(ex, order.a, leverage, false);
  const [result] = await placeOrders(ex, [order]);
  return { leverage: opens ? leverage : null, result: result ?? null };
}

export type SentQuotes = {
  /** Per cancelled order, in order: null when it cancelled, else why not. */
  cancelled: (string | null)[];
  placed: OrderResult[];
};

export async function sendQuotes(ex: Exchange, refresh: QuoteRefresh, asset: number): Promise<SentQuotes> {
  const cancelled = refresh.cancel.length > 0 ? await cancelOrders(ex, refresh.cancel.map((o) => ({ a: asset, o: o.oid }))) : [];
  const placed = refresh.place.length > 0 ? await placeOrders(ex, refresh.place) : [];
  return { cancelled, placed };
}
