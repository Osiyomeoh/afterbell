import { coverPlan, type CoverPlan } from "@/lib/kaminoCover";

import { bookReport, type BookReport } from "./gapBook";
import { kaminoLoans } from "./kaminoLoans";
import { pricedStock } from "./market";

export type LoanCover = { obligation: string; marketName: string; plan: CoverPlan; quote: BookReport | null };

/** For each of a wallet's Kamino loans, the auto-cover that would repay what a liquidating opening pushes over the limit, and tonight's price for it. */
export async function kaminoCover(wallet: string): Promise<{ wallet: string; covers: LoanCover[]; readAt: number }> {
  const { loans, readAt } = await kaminoLoans(wallet);
  const covers = await Promise.all(
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
  return { wallet, covers, readAt };
}
