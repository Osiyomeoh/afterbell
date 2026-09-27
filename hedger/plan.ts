/**
 * What the hedger would do now, pure: one stock's exposure across the vaults,
 * the short held, the target and the order that reaches it. The script reads
 * the inputs from the chains and Hyperliquid; tests hand them in.
 */
import type { OpeningModel } from "../pricing/model";
import { hedgeOrder, type Market, type OrderWire } from "./hyperliquid";
import type { HedgeAccount } from "./info";
import { DEFAULT_BAND, exposure, rebalance, type Exposure, type OpenPosition, type Rebalance } from "./target";

export type HedgeInputs = {
  now: number;
  symbol: string;
  positions: readonly OpenPosition[];
  /** Mainnet's mid: the hedge is sized at it and its limit set from it, whichever network it trades on. */
  mid: number;
  modelFor: (openTs: number) => OpeningModel;
  /** The market on the network the hedge trades on. */
  market: Market;
  /** Null when no hedge account is given: the short held is then taken as none. */
  account: HedgeAccount | null;
  maxNotional: number;
};

export type HedgePlan = {
  exposure: Exposure;
  /** The short held now, in shares. */
  current: number;
  rebalance: Rebalance;
  /** The order that makes the rebalance, or null when it holds. */
  order: OrderWire | null;
};

export function planHedge(i: HedgeInputs): HedgePlan {
  const e = exposure(i.now, i.symbol, i.positions, i.mid, i.modelFor);
  const current = i.account?.position?.short ?? 0;
  const r = rebalance(e.hedge, current, i.mid, { step: 10 ** -i.market.szDecimals, ...DEFAULT_BAND, maxNotional: i.maxNotional });
  return { exposure: e, current, rebalance: r, order: hedgeOrder(r, i.mid, i.market) };
}
