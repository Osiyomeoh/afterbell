import { PublicKey } from "@solana/web3.js";

import type { KaminoLoanInfo, KaminoLoansResponse } from "@root/sdk/types";

import { KAMINO_STOCK_MARKETS } from "@/lib/kamino";
import { loanBand, loanRisk, toLoan, type KaminoObligation } from "@/lib/kaminoLoan";

import { bookReport } from "./gapBook";
import { pricedStock } from "./market";

const API = "https://api.kamino.finance";

/** The API's shape is the SDK's, so the two can't drift apart. */
export type LoanView = KaminoLoanInfo;

/** A wallet that isn't a Solana address: the caller's mistake, not Kamino's. */
export class NotAWallet extends Error {}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Kamino's API answered ${res.status}`);
  return (await res.json()) as T;
}

/**
 * A wallet's loans in Kamino's tokenized-stock markets, from its public API: for each, how far its
 * stocks can open down before it can be liquidated, how often they have, and protection priced down
 * to that point. Throws NotAWallet on a wallet that isn't a Solana address.
 */
export async function kaminoLoans(wallet: string): Promise<KaminoLoansResponse> {
  try {
    new PublicKey(wallet);
  } catch {
    throw new NotAWallet("that isn't a Solana wallet address");
  }
  const perMarket = await Promise.all(
    KAMINO_STOCK_MARKETS.map(async (m) => {
      const [reserves, obligations] = await Promise.all([
        get<{ reserve: string; liquidityToken: string }[]>(`/kamino-market/${m.address}/reserves/metrics`),
        get<KaminoObligation[]>(`/kamino-market/${m.address}/users/${wallet}/obligations`),
      ]);
      const tokenOfReserve = new Map(reserves.map((r) => [r.reserve, r.liquidityToken]));
      return obligations.flatMap((o) => {
        const loan = toLoan(o, tokenOfReserve);
        return loan ? [{ ...loan, marketName: m.name }] : [];
      });
    }),
  );
  const loans = await Promise.all(
    perMarket.flat().map(async (loan): Promise<LoanView> => {
      const risk = loanRisk(loan);
      const band = loanBand(risk.together);
      const moves = [...new Set([risk.together, ...risk.alone.map((a) => a.gap)])].filter((g): g is number => g !== null && g > 0);
      const covered = loan.stocks.filter((s) => pricedStock(s.symbol));
      const report = await bookReport(covered.map((s) => ({ symbol: s.symbol, value: s.usd })), band.start, band.stop, moves);
      const uncovered = loan.stocks.filter((s) => !pricedStock(s.symbol)).map((s) => ({ symbol: s.symbol, reason: "not covered" }));
      return { ...loan, marketName: loan.marketName, risk, band, report: { ...report, skipped: [...report.skipped, ...uncovered] } };
    }),
  );
  return { wallet, loans, readAt: Math.floor(Date.now() / 1000) };
}
