import { nextOpen } from "@root/quoter/calendar";
import { DEFAULT_QUOTER_CONFIG } from "@root/quoter/quoter";
import { stockBySymbol } from "@root/quoter/stocks";

import { EVENTS, currentEvent, eventPhase, type EventPhase, type MarketEvent } from "@/lib/events";
import { buyers } from "@/lib/team";

import { solanaVaultState } from "./chain";
import { evmVaultState } from "./evmChain";
import type { LedgerRow } from "./ledger";
import { solanaLedger } from "./ledger";
import { marketSnapshot } from "./market";

export type EventView = {
  /** Every event expected on that open, the first being the one the page leads with. */
  events: MarketEvent[];
  openTs: number;
  phase: EventPhase;
  /** Every series sold for that open, on both chains. */
  series: LedgerRow[];
  sold: number;
  premiums: number;
  maxPayouts: number;
  paid: number;
  wallets: number;
  outside: number;
};

/**
 * The campaign's open (the next event on TSLA, or one in the last three days): what's sold for it on
 * both chains, by how many wallets, and once the bell has rung, what it settled at and paid.
 */
export async function eventView(now = Math.floor(Date.now() / 1000)): Promise<EventView | null> {
  const lead = currentEvent("TSLA", now);
  if (!lead) return null;
  const events = [lead, ...EVENTS.filter((e) => e.openTs === lead.openTs && e !== lead)];
  const [solana, solanaState, evm, tsla] = await Promise.all([
    solanaLedger().catch(() => [] as LedgerRow[]),
    solanaVaultState()?.catch(() => null) ?? null,
    evmVaultState()?.catch(() => null) ?? null,
    marketSnapshot(stockBySymbol("TSLA")!),
  ]);
  const series = [...solana, ...(evm?.ledger ?? [])].filter((r) => r.openTs === lead.openTs);
  const sales = [...(solanaState?.sales ?? []), ...(evm?.sales ?? [])];
  const forThisOpen = buyers(sales.filter((s) => s.openTs === lead.openTs));
  // Outside wallets are counted over every sale, so a wallet that bought earlier doesn't count as new here.
  const outside = new Set(buyers(sales).outside);
  const holidays = tsla.market.holidays;
  const settled = series.find((r) => r.symbol === lead.symbol && r.chain === "solana" && r.state === "settled");
  const phase = eventPhase(
    lead,
    now,
    { nextOpen: nextOpen(now, DEFAULT_QUOTER_CONFIG.stopBeforeOpenSecs + DEFAULT_QUOTER_CONFIG.ttlSecs, holidays), holidays, stopBeforeOpenSecs: DEFAULT_QUOTER_CONFIG.stopBeforeOpenSecs },
    settled?.price ?? null,
  );
  return {
    events,
    openTs: lead.openTs,
    phase,
    series,
    sold: series.reduce((t, r) => t + r.sales, 0),
    premiums: series.reduce((t, r) => t + r.premiums, 0),
    maxPayouts: series.reduce((t, r) => t + r.maxPayouts, 0),
    paid: series.reduce((t, r) => t + r.paid, 0),
    wallets: forThisOpen.all.length,
    outside: forThisOpen.all.filter((w) => outside.has(w)).length,
  };
}
