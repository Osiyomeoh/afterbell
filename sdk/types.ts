/**
 * The JSON Afterbell's public API answers with, typed. Shapes the repo
 * already defines (a priced protection, a gap report, the hedge) come from
 * where they're computed, so the two can't drift apart.
 */
import type { Address } from "viem";

import type { EvmDeployment } from "../evm/client/vault";
import type { HedgeActivity } from "../hedger/info";
import type { HedgeSummary } from "../hedger/state";
import type { Opening } from "../pricing/model";
import type { BoardPrice } from "../quoter/board";
import type { GapReport } from "../quoter/gapReport";
import type { PricedProtection, QuoterConfig } from "../quoter/quoter";

export type Chain = "solana" | "robinhood";
export type PriceSource = "pyth" | "chainlink" | "hyperliquid";
export type SeriesState = "open" | "settled" | "voided";

/** A stock, the next open protection settles on, and what each chain sells: `GET /api/market?symbol=`. */
export type MarketInfo = {
  symbol: string;
  name: string;
  /** Every stock priced; `solana`/`robinhood`: that vault sells it now; `settles`: the chains whose oracle can settle it. */
  stocks: { symbol: string; name: string; solana: boolean; robinhood: boolean; settles: Chain[] }[];
  now: number;
  close: number;
  closeTs: number;
  closeSource: PriceSource;
  live: number | null;
  liveSource: PriceSource;
  inSession: boolean;
  /** The price protection is quoted from; null while trading is paused. */
  reference: { price: number; basis: string } | null;
  paused: string | null;
  nextOpen: number;
  holidays: string[];
  earlyCloses: [string, { hour: number; minute: number }][];
  history: Opening[];
  annualVol: number;
  config: QuoterConfig;
  /** Solana vault v2, null until deployed. */
  solana: { vault: string; collateralMint: string; programId: string; quoter: string; shareMint: string; selling: boolean } | null;
  /** The Robinhood Chain vault, null until deployed. */
  robinhood: (EvmDeployment & { selling: boolean }) | null;
};

/** Standard protection (2% to 10% below) priced for one share of every stock: `GET /api/board`. */
export type BoardRow = { symbol: string; name: string; solana: boolean; robinhood: boolean; settles: Chain[] } & ({ price: BoardPrice } | { error: string });

/** What a quote asks for: shares, and the strikes in dollars, protection paying from `upper` down to `lower`. */
export type Protection = { shares: number; upper: number; lower: number };
export type QuoteRequest = { chain: Chain; symbol: string; buyer: string } & Protection;

/** A Solana quote: the price, and the quoter's ed25519 signature for the buyer to submit with `buy`. */
export type SolanaQuoteResponse = {
  priced: PricedProtection;
  solana: {
    programId: string;
    vault: string;
    collateralMint: string;
    quoter: string;
    quote: Record<"feedId" | "openTs" | "shares" | "upper" | "lower" | "premium" | "expiry" | "nonce", string>;
    ed25519Data: string;
  };
};

/** A Robinhood Chain quote: the price, and the quoter's EIP-712 signature for the buyer to submit with `buyWithPermit`. */
export type EvmQuoteResponse = {
  priced: PricedProtection;
  evm: {
    chainId: number;
    vault: Address;
    testUsd: Address;
    positions: Address;
    quoter: Address;
    quote: Record<"buyer" | "feed" | "openTs" | "shares" | "upper" | "lower" | "premium" | "expiry" | "nonce", string>;
    signature: `0x${string}`;
  };
};

/** One position a wallet's NFT pays: `GET /api/positions?owner=`. */
export type PositionInfo = {
  /** A Solana position's address, or a Robinhood Chain position's number. */
  address: string;
  series: string;
  symbol: string;
  buyer: string;
  openTs: number;
  state: SeriesState;
  shares: number;
  upper: number;
  lower: number;
  premium: number;
  maxPayout: number;
  /** What it pays once its series settles (or refunds, if voided); null while open. */
  claimable: number | null;
  settlementPrice: number | null;
  art?: string;
  /** Solana: the NFT's mint, and the account holding it. */
  mint?: string;
  nftAccount?: string;
};

/** A vault's collateral, its pool and every series: `GET /api/vault[?chain=robinhood]`. */
export type VaultInfo = {
  vault: string;
  chainId?: number;
  pool?: { round: number; nav: number; sharePrice: number; room: number; perStock: number };
  collateralMint: string;
  collateral: number;
  locked: number;
  openPositions: number;
  series: { address: string; symbol: string; openTs: number; state: SeriesState; price: number | null; positions: number; premiums: number; maxPayouts: number }[];
};

/** Every series either vault has sold, and how it settled: `GET /api/record`. */
export type LedgerRow = {
  chain: Chain;
  series: string;
  symbol: string;
  openTs: number;
  state: SeriesState;
  price: number | null;
  priceTime: number | null;
  settleTx: string | null;
  sales: number;
  premiums: number;
  maxPayouts: number;
  paid: number;
  claims: number;
};

/** A book's gap history and tonight's protection for it: `GET /api/gap-report`. */
export type GapReportResponse = GapReport & { names: Record<string, string>; wallet?: string };

/** The hedge on Hyperliquid and its trades: `GET /api/hedge`. */
export type HedgeInfo = HedgeSummary & { activity: HedgeActivity | null };

/** Whether each part of the service is running: `GET /api/status`. */
export type StatusReport = { now: number; checks: { name: string; state: "ok" | "warn" | "down"; detail: string; href?: string }[] };

/** What the devnet faucet sent: `POST /api/faucet`. */
export type DripResult = { signature: string | null; testUsd: number; sol: number; alreadyFunded: boolean };
