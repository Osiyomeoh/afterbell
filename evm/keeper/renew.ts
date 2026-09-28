/**
 * The keeper's renewal step: after an open is settled and the pool has
 * rolled, buy the next open's protection for every standing order, at the
 * quote service's price, within each order's limits.
 */
import type { Account, Address, Chain, PublicClient, Transport, WalletClient } from "viem";

import { AfterbellClient } from "../../sdk/client";
import { toEvmQuote } from "../../sdk/robinhood";
import { activeOrders, renewOrder, type HolderOrder, type RenewerOrder } from "../client/renewer";
import type { EvmDeployment } from "../client/vault";

export type RenewalDecision = { action: "renew" } | { action: "skip"; reason: string };

/** Whether an order should buy protection for `openTs` at `premium` (collateral units). The renewer checks the same again. */
export function renewalDecision(o: RenewerOrder, openTs: bigint, premium: bigint): RenewalDecision {
  if (o.maxShares === 0n) return { action: "skip", reason: "cancelled" };
  if (openTs > o.until) return { action: "skip", reason: "the order has ended" };
  if (openTs <= o.lastOpenTs) return { action: "skip", reason: "already renewed for this open" };
  if (premium > o.maxPremium) return { action: "skip", reason: `the price, ${premium} units, is above the order's cap of ${o.maxPremium}` };
  return { action: "renew" };
}

export type RenewalPlan = { order: HolderOrder; symbol: string; openTs?: number; premium?: number; decision: RenewalDecision };

type Wallet = WalletClient<Transport, Chain, Account>;

/**
 * For each standing order: tonight's quote for its protection, signed for the
 * renewer, and whether to buy it. With `wallet`, buys each one that should be.
 */
export async function renewOrders(opts: {
  client: PublicClient;
  deployment: EvmDeployment;
  api: AfterbellClient;
  wallet?: Wallet;
  log?: (line: string) => void;
}): Promise<RenewalPlan[]> {
  const { client, deployment: d, api, wallet } = opts;
  const renewer = d.renewer;
  if (!renewer) return [];
  const now = BigInt(Math.floor(Date.now() / 1000));
  const symbolOf = (feed: Address) => Object.entries(d.feeds).find(([, a]) => a?.toLowerCase() === feed.toLowerCase())?.[0];
  const plans: RenewalPlan[] = [];
  for (const order of await activeOrders(client, renewer, now)) {
    const symbol = symbolOf(order.feed);
    if (!symbol) {
      plans.push({ order, symbol: order.feed, decision: { action: "skip", reason: "a feed this deployment doesn't list" } });
      continue;
    }
    try {
      const protection = await api.protectionBelow(symbol, Number(order.maxShares) / 1e6, order.startBps / 10_000, order.depthBps / 10_000);
      const q = await api.quote({ chain: "robinhood", symbol, buyer: renewer, ...protection });
      const quote = toEvmQuote(q.evm.quote);
      const decision = renewalDecision(order, quote.openTs, quote.premium);
      plans.push({ order, symbol, openTs: Number(quote.openTs), premium: q.priced.premium, decision });
      if (wallet && decision.action === "renew") {
        const hash = await renewOrder(wallet, client, renewer, order.holder, quote, q.evm.signature);
        opts.log?.(`renewed ${symbol} for ${order.holder}: $${q.priced.premium.toFixed(2)} (${hash})`);
      }
    } catch (e) {
      plans.push({ order, symbol, decision: { action: "skip", reason: (e as Error).message } });
    }
  }
  return plans;
}
