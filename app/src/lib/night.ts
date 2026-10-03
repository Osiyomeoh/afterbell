import type { Night } from "@/server/verify";
import { usd } from "./format";

/** One night's record in a line: what the vaults paid at the open, or what they covered. */
export function nightHeadline(n: Night): string {
  return n.paid > 0 ? `Paid ${usd(n.paid)} at the ${n.day} open` : `${n.positions} ${n.positions === 1 ? "position" : "positions"} covered to the ${n.day} open`;
}

export function nightSummary(n: Night): string {
  return `${n.symbols.join(", ")} · ${usd(n.premiums)} in premiums · ${usd(n.paid)} paid out`;
}

export function nightShareText(n: Night): string {
  return `${nightHeadline(n)}: ${nightSummary(n)}. Every payout recomputed from the chain.`;
}
