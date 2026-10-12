import { coverPlan, type CoverPlan } from "@/lib/kaminoCover";
import type { KaminoLoan } from "@/lib/kaminoLoan";

import { solanaStockRooms } from "./chain";
import { bookReport, type BookReport } from "./gapBook";
import { kaminoLoans } from "./kaminoLoans";
import { pricedStock } from "./market";

export type LoanCover = {
  obligation: string;
  marketName: string;
  plan: CoverPlan;
  quote: BookReport | null;
};
/** What the pool can still cover tonight on each stock it sells, in dollars; null if it couldn't be read. */
export type StockRooms = Record<string, number> | null;
type Covers = {
  wallet: string;
  covers: LoanCover[];
  rooms: StockRooms;
  readAt: number;
};

/** For each of a wallet's Kamino loans, the auto-cover that would repay what a liquidating opening pushes over the limit, and tonight's price for it. */
export async function kaminoCover(wallet: string): Promise<Covers> {
  const { loans, readAt } = await kaminoLoans(wallet);
  const [covers, rooms] = await Promise.all([coversFor(loans), roomsOrNull()]);
  return { wallet, covers, rooms, readAt };
}

/**
 * A made-up loan, marked as such, for trying auto-cover without one: $3,000 of TSLA and $2,000 of QQQ
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
    { symbol: "QQQ", usd: 2000 },
  ],
};

export async function sampleCover(): Promise<Covers> {
  const [covers, rooms] = await Promise.all([
    coversFor([SAMPLE_LOAN]),
    roomsOrNull(),
  ]);
  return {
    wallet: "sample",
    covers,
    rooms,
    readAt: Math.floor(Date.now() / 1000),
  };
}

/** The pool's room per stock; a failed read leaves the covers without it rather than failing them. */
const roomsOrNull = (): Promise<StockRooms> =>
  solanaStockRooms().catch(() => null);

async function coversFor(
  loans: (KaminoLoan & { marketName: string })[],
): Promise<LoanCover[]> {
  return Promise.all(
    loans.map(async (loan): Promise<LoanCover> => {
      const plan = coverPlan(loan, { covered: (s) => !!pricedStock(s) });
      if (plan.action !== "cover")
        return {
          obligation: loan.obligation,
          marketName: loan.marketName,
          plan,
          quote: null,
        };
      const { startBps, depthBps } = plan.lines[0]!;
      const quote = await bookReport(
        plan.lines.map((l) => ({ symbol: l.symbol, value: l.notionalUsd })),
        startBps / 100,
        (startBps + depthBps) / 100,
      );
      return {
        obligation: loan.obligation,
        marketName: loan.marketName,
        plan,
        quote,
      };
    }),
  );
}
