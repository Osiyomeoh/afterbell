import { coverPayout, coverPlan, shortfall } from "./kaminoCover";
import type { KaminoLoan } from "./kaminoLoan";

/** One recorded opening: the close before it, the open, and the gap as a fraction (negative is down). */
export type Opening = { from: string; to: string; gap: number; weekend: boolean };

export type ProofRow = {
  to: string;
  weekend: boolean;
  gap: number;
  /** What the opening pushes the debt over the liquidation limit, in dollars. */
  shortfall: number;
  /** What loan-sized auto-cover pays. */
  banded: number;
  /** What all-or-nothing weekend cover pays. */
  binary: number;
};

export type Proof = {
  openings: number;
  /** The openings where either matters: the loan goes under, or the weekend cover pays. */
  rows: ProofRow[];
  liquidations: number;
  bandedCovered: number;
  binaryCovered: number;
};

/**
 * The same loan through every recorded opening, under two covers: Afterbell's, sized on the loan
 * (it starts at the opening that liquidates it and repays the shortfall), and an all-or-nothing
 * policy that pays a flat `binaryUsd` when a weekend opening falls `trigger` or more. An opening
 * counts as covered when the payout reaches the shortfall.
 */
export function headToHead(loan: KaminoLoan, openings: Opening[], { trigger, binaryUsd }: { trigger: number; binaryUsd: number }): Proof {
  const plan = coverPlan(loan);
  const lines = plan.action === "cover" ? plan.lines : [];
  const rows = openings.flatMap((o): ProofRow[] => {
    const drop = Math.max(0, -o.gap);
    const row = {
      to: o.to,
      weekend: o.weekend,
      gap: o.gap,
      shortfall: shortfall(loan, drop),
      banded: coverPayout(lines, drop),
      binary: o.weekend && drop >= trigger ? binaryUsd : 0,
    };
    return row.shortfall > 0 || row.binary > 0 ? [row] : [];
  });
  const under = rows.filter((r) => r.shortfall > 0);
  return {
    openings: openings.length,
    rows,
    liquidations: under.length,
    bandedCovered: under.filter((r) => r.banded >= r.shortfall - 0.005).length,
    binaryCovered: under.filter((r) => r.binary >= r.shortfall - 0.005).length,
  };
}
