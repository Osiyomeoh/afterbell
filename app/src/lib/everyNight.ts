import type { RenewerOrder } from "@root/evm/client/renewer";

/** Tonight's price moves from night to night, so the nightly cap leaves this much room above it. */
export const CAP_OVER_TONIGHT = 1.5;
/** How long a standing order can run, in nights, as offered at checkout. */
export const NIGHT_OPTIONS = [7, 14, 30] as const;

/**
 * The standing order that renews tonight's purchase every night: the same
 * shares and levels, a nightly cap above tonight's premium, until `nights`
 * after tonight's open, and the allowance that covers every night at the cap.
 */
export function standingOrder(p: { shares: number; start: number; depth: number; premium: number; openTs: number; nights: number }): {
  order: Omit<RenewerOrder, "lastOpenTs">;
  allowance: bigint;
} {
  const maxPremium = BigInt(Math.ceil(p.premium * CAP_OVER_TONIGHT * 1e6));
  return {
    order: {
      maxShares: BigInt(Math.round(p.shares * 1e6)),
      startBps: Math.round(p.start * 10_000),
      depthBps: Math.round(Math.max(p.depth, p.start + 0.01) * 10_000),
      maxPremium,
      until: BigInt(p.openTs + p.nights * 86_400),
    },
    allowance: maxPremium * BigInt(p.nights),
  };
}
