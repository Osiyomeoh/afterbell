/**
 * Kamino auto-cover's nightly size for a standing order: the holder's loans' cover lines for the
 * order's stock, turned into shares at tonight's reference price. The holder opts in by naming the
 * keeper as the order's sizer; only that holder's own wallet is read.
 */
import { referencePrice, type AfterbellClient } from "../../sdk/client";
import type { KaminoCoverResponse } from "../../sdk/types";
import type { SolanaOrder } from "./renew";

export function kaminoSizer(api: AfterbellClient) {
  const covers = new Map<string, Promise<KaminoCoverResponse>>();
  return async (order: SolanaOrder, symbol: string) => {
    if (!covers.has(order.holder)) covers.set(order.holder, api.kaminoCover(order.holder));
    const lines = (await covers.get(order.holder)!).covers.flatMap((c) => (c.plan.action === "cover" ? c.plan.lines : [])).filter((l) => l.symbol === symbol);
    if (lines.length === 0) return null;
    // Several loans on one stock: one order, starting at the shallowest gap, on their notional together.
    const startBps = Math.min(...lines.map((l) => l.startBps));
    const depthBps = startBps + Math.max(...lines.map((l) => l.depthBps));
    const notional = lines.reduce((t, l) => t + l.notionalUsd, 0);
    const price = referencePrice(await api.market(symbol));
    return { maxShares: BigInt(Math.floor((notional / price) * 1e6)), startBps, depthBps };
  };
}
