/** Recomputes every position's payout from its terms and its series' price, independently of the vaults' own math. */
import { payout } from "@root/pricing/putSpread";
import type { AuditRow } from "@/server/vaultTypes";

export type AuditResult = {
  address: string;
  symbol: string;
  openTs: number;
  /** What the terms owe at the settlement price (the premium back if voided). */
  expected: number;
  paid: number | null;
  verdict: "ok" | "mismatch" | "unpaid" | "forfeited";
};

// Collateral has 6 decimals and the contracts round down: allow a few units.
const TOLERANCE = 0.00001;

export function audit(rows: AuditRow[]): AuditResult[] {
  return rows
    .filter((r) => r.state !== "open")
    .map((r) => {
      const expected = r.state === "voided" ? r.premium : payout(r, r.settlementPrice!);
      const verdict = r.forfeited ? "forfeited" : r.paid === null ? "unpaid" : Math.abs(r.paid - expected) <= TOLERANCE ? "ok" : "mismatch";
      return { address: r.address, symbol: r.symbol, openTs: r.openTs, expected, paid: r.paid, verdict };
    });
}
