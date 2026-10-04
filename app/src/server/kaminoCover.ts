import { coverPlan, type CoverPlan } from "@/lib/kaminoCover";
import type { KaminoLoan } from "@/lib/kaminoLoan";

import { bookReport, type BookReport } from "./gapBook";
import { kaminoLoans } from "./kaminoLoans";
import { pricedStock } from "./market";

export type LoanCover = { obligation: string; marketName: string; plan: CoverPlan; quote: BookReport | null };

/** For each of a wallet's Kamino loans, the auto-cover that would repay what a liquidating opening pushes over the limit, and tonight's price for it. */
export async function kaminoCover(wallet: string): Promise<{ wallet: string; covers: LoanCover[]; readAt: number }> {
  const { loans, readAt } = await kaminoLoans(wallet);
  return { wallet, covers: await coversFor(loans), readAt };
}

/**
 * A made-up loan, marked as such, for trying auto-cover without one: $3,000 of TSLA and $2,000 of NVDA
 * at a 70% liquidation threshold, $3,150 borrowed, so it's liquidatable if both open 10% down.
 */
export const SAMPLE_LOAN: KaminoLoan & { marketName: string } = {
  obligation: "sample",
  market: "sample",
  marketName: "Sample loan (not on Kamino)",
  debtUsd: 3150,
  liquidationLimitUsd: 3500,
  depositUsd: 5000,
  stocks: [
    { symbol: "TSLA", usd: 3000 },
    { symbol: "NVDA", usd: 2000 },
  ],
};

export async function sampleCover(): Promise<{ wallet: string; covers: LoanCover[]; readAt: number }> {
  return { wallet: "sample", covers: await coversFor([SAMPLE_LOAN]), readAt: Math.floor(Date.now() / 1000) };
}

async function coversFor(loans: (KaminoLoan & { marketName: string })[]): Promise<LoanCover[]> {
  return Promise.all(
    loans.map(async (loan): Promise<LoanCover> => {
      const plan = coverPlan(loan, { covered: (s) => !!pricedStock(s) });
      if (plan.action !== "cover") return { obligation: loan.obligation, marketName: loan.marketName, plan, quote: null };
      const { startBps, depthBps } = plan.lines[0]!;
      const quote = await bookReport(
        plan.lines.map((l) => ({ symbol: l.symbol, value: l.notionalUsd })),
        startBps / 100,
        (startBps + depthBps) / 100,
      );
      return { obligation: loan.obligation, marketName: loan.marketName, plan, quote };
    }),
  );
}
