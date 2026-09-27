/**
 * What the hedger reads, and the plan from it, shared by its script and the
 * app's /api/hedge so both size the hedge the same way. Every read is public
 * and needs no key. Any read that fails fails the whole state: a hedge is
 * never sized on half a book.
 */
import type { Connection } from "@solana/web3.js";
import type { Address } from "viem";

import { hyperliquidMid } from "../quoter/marketData";
import { modelFor, type Market as QuoterMarket } from "../quoter/quoter";
import type { Stock } from "../quoter/stocks";
import type { Market, Network } from "./hyperliquid";
import { fetchHedgeAccount, fetchMarket, postInfo, type HedgeAccount, type Post } from "./info";
import { planHedge, type HedgePlan } from "./plan";
import { openPositions, readVault, type VaultVersion } from "./solana";
import type { OpenExposure, OpenPosition } from "./target";

export type VaultSource = { label: string; version: VaultVersion; connection: Connection; deployment: { programId: string; vault: string } };

/** What the model needs besides the price: the recorded openings, and the calendar. */
export type ModelInputs = Pick<QuoterMarket, "history" | "annualVol" | "holidays" | "earlyCloses">;

export type Book = { label: string; vault: string; positions: OpenPosition[] };

export type HedgeState = {
  now: number;
  /** Mainnet's mid: the hedge is sized at it, whichever network it trades on. */
  mid: number;
  market: Market;
  account: HedgeAccount | null;
  books: Book[];
  positions: OpenPosition[];
  plan: HedgePlan;
};

export type HedgeSources = {
  stock: Stock;
  vaults: readonly VaultSource[];
  network: Network;
  /** The hedge account, or null: the short held is then taken as none. */
  address: Address | null;
  maxNotional: number;
  model: (now: number) => Promise<ModelInputs>;
  post?: Post;
  mid?: (coin: string) => Promise<number>;
  now?: number;
};

export async function readHedgeState(s: HedgeSources): Promise<HedgeState> {
  const coin = s.stock.hyperliquid;
  if (!coin) throw new Error(`${s.stock.symbol} has no Hyperliquid perp to hedge in`);
  const now = s.now ?? Math.floor(Date.now() / 1000);
  const post = s.post ?? postInfo;
  const [books, mid, market, account, inputs] = await Promise.all([
    Promise.all(
      s.vaults.map(async (v) => {
        const { series, positions } = await readVault(v.connection, v.version, v.deployment);
        return { label: v.label, vault: v.deployment.vault, positions: openPositions(series, positions).filter((p) => p.openTs > now) };
      }),
    ),
    (s.mid ?? hyperliquidMid)(coin),
    fetchMarket(post, s.network, coin),
    s.address ? fetchHedgeAccount(post, s.network, s.address, coin) : null,
    s.model(now),
  ]);
  const positions = books.flatMap((b) => b.positions);
  const plan = planHedge({ now, symbol: s.stock.symbol, positions, mid, modelFor: (openTs) => modelFor(now, openTs, inputs), market, account, maxNotional: s.maxNotional });
  return { now, mid, market, account, books, positions, plan };
}

/** The state as the app shows it: plain JSON, no orders. */
export type HedgeSummary = {
  symbol: string;
  coin: string;
  network: Network;
  now: number;
  mid: number;
  vaults: { label: string; vault: string; positions: number }[];
  opens: OpenExposure[];
  /** The short the open positions call for, in shares, before rounding and the cap. */
  hedge: number;
  /** The short to hold: rounded to the market's step, and capped. */
  target: number;
  capped: boolean;
  maxNotional: number;
  /** The hedge account and its position, or null while none is set up. */
  account: HedgeAccount | null;
  /** What the hedger would do now. */
  action: string;
  /** Open positions in stocks the hedger doesn't trade, per stock. */
  notHedged: { symbol: string; positions: number }[];
};

export function summarize(st: HedgeState, stock: Stock, network: Network, maxNotional: number): HedgeSummary {
  const notHedged = new Map<string, number>();
  for (const p of st.positions) if (p.symbol !== stock.symbol) notHedged.set(p.symbol, (notHedged.get(p.symbol) ?? 0) + 1);
  return {
    symbol: stock.symbol,
    coin: st.market.coin,
    network,
    now: st.now,
    mid: st.mid,
    vaults: st.books.map((b) => ({ label: b.label, vault: b.vault, positions: b.positions.length })),
    opens: st.plan.exposure.opens,
    hedge: st.plan.exposure.hedge,
    target: st.plan.rebalance.target,
    capped: st.plan.rebalance.capped,
    maxNotional,
    account: st.account,
    action: st.plan.rebalance.note,
    notHedged: [...notHedged].map(([symbol, positions]) => ({ symbol, positions })),
  };
}
