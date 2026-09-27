import type { EvmDeployment } from "@root/evm/client/vault";
import type { HedgeActivity } from "@root/hedger/info";
import type { OpenSeries } from "@root/hedger/solana";
import type { HedgeSummary } from "@root/hedger/state";
import type { Opening } from "@root/pricing/model";
import type { GapReport } from "@root/quoter/gapReport";
import type { Market, PricedProtection, QuoterConfig } from "@root/quoter/quoter";

export type PriceSource = "pyth" | "chainlink" | "hyperliquid";

/** A stock the app prices: whether each vault sells it now, and which chains' oracles can settle it. */
export type StockListing = { symbol: string; name: string; solana: boolean; robinhood: boolean; settles: Chain[] };

export type MarketResponse = {
  symbol: string;
  name: string;
  stocks: StockListing[];
  now: number;
  close: number;
  closeTs: number;
  closeSource: PriceSource;
  live: number | null;
  liveSource: PriceSource;
  inSession: boolean;
  reference: { price: number; basis: string } | null;
  paused: string | null;
  nextOpen: number;
  holidays: string[];
  earlyCloses: [string, { hour: number; minute: number }][];
  history: Opening[];
  annualVol: number;
  config: QuoterConfig;
  hyperliquid: { coin: string | null; tracks: "stock" | "index"; ratio: number | null };
  /** The Solana vault v2, once deployed; `selling`: it sells this stock. */
  solana: { cluster: string; programId: string; vault: string; vaultToken: string; collateralMint: string; quoter: string; shareMint: string; selling: boolean } | null;
  /** The Robinhood Chain vault, once deployed; `selling` once the server can sign its quotes for this stock. */
  robinhood: (EvmDeployment & { selling: boolean }) | null;
};

export type QuoteResponse = {
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

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
  return body;
}

/** A stock's price since the last close, from its Hyperliquid perp (no points for a stock without one). */
export type OvernightResponse = { symbol: string; closeTs: number; close: number; coin: string | null; points: { t: number; price: number }[] };

export const fetchOvernight = (symbol: string) =>
  fetch(`/api/overnight?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" }).then((r) => json<OvernightResponse>(r));

export const fetchMarket = (symbol = "TSLA") => fetch(`/api/market?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" }).then((r) => json<MarketResponse>(r));

export const requestQuote = (args: { symbol: string; buyer: string; shares: number; upper: number; lower: number }) =>
  fetch("/api/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chain: "solana", ...args }) }).then((r) =>
    json<QuoteResponse>(r),
  );

export type EvmQuoteResponse = {
  priced: PricedProtection;
  evm: {
    chainId: number;
    vault: string;
    testUsd: string;
    positions: string;
    quoter: string;
    quote: Record<"buyer" | "feed" | "openTs" | "shares" | "upper" | "lower" | "premium" | "expiry" | "nonce", string>;
    signature: string;
  };
};

export const requestEvmQuote = (args: { symbol: string; buyer: string; shares: number; upper: number; lower: number }) =>
  fetch("/api/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chain: "robinhood", ...args }) }).then((r) =>
    json<EvmQuoteResponse>(r),
  );

/** The quoter's Market, rebuilt from the API's JSON, so the browser prices exactly as the server does. */
export function toMarket(m: MarketResponse): Market {
  return {
    symbol: m.symbol,
    close: m.close,
    live: m.live ?? undefined,
    history: m.history,
    annualVol: m.annualVol,
    holidays: new Set(m.holidays),
    earlyCloses: new Map(m.earlyCloses),
  };
}

export type SeriesState = "open" | "settled" | "voided";

export type PositionRow = {
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
  claimable: number | null;
  settlementPrice: number | null;
  /** The position's NFT image. */
  art?: string;
  /** Solana: the NFT's mint, and the holder's account holding it. */
  mint?: string;
  nftAccount?: string;
};

export type PoolState = {
  round: number;
  roundOpenTs: number | null;
  nav: number;
  roundNav: number;
  shares: number;
  sharePrice: number;
  pendingDeposits: number;
  pendingRedeemShares: number;
  reserved: number;
  tipsOwed: number;
  room: number;
  perStock: number;
  maxUtilizationBps: number;
  maxFeedBps: number;
  keeperTipBps: number;
};

export type UnderwriterStake = {
  shares: number;
  value: number;
  testUsd: number;
  pendingDeposit: number;
  pendingRedeemShares: number;
  claimableDeposit: number;
  claimableShares: number;
  claimableRedeemShares: number;
  claimableAssets: number;
};

export const fetchUnderwriter = (owner: string) => fetch(`/api/underwriter?owner=${owner}`, { cache: "no-store" }).then((r) => json<UnderwriterStake>(r));

export type VaultResponse = {
  chainId?: number;
  pool?: PoolState;
  vault: string;
  collateralMint: string;
  collateral: number;
  locked: number;
  openPositions: number;
  series: { address: string; symbol: string; openTs: number; state: SeriesState; price: number | null; publishTime: number | null; positions: number; premiums: number; maxPayouts: number }[];
  /** Solana only, while the app keeps the first vault's record: each series it still has open, or why it couldn't be read. */
  firstVault?: { vault: string; open: OpenSeries[] } | { vault: string; error: string };
};

export type Chain = "solana" | "robinhood";

export const fetchVault = (chain: Chain = "solana") =>
  fetch(chain === "robinhood" ? "/api/vault?chain=robinhood" : "/api/vault", { cache: "no-store" }).then((r) => json<VaultResponse>(r));
export const fetchPositions = (owner: string) =>
  fetch(`/api/positions?owner=${owner}`, { cache: "no-store" }).then((r) => json<{ positions: PositionRow[] }>(r));

export type DripResponse = { signature: string | null; testUsd: number; sol: number; alreadyFunded: boolean };

export const requestTestFunds = (owner: string) =>
  fetch("/api/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner }) }).then((r) => json<DripResponse>(r));

export const fetchHoldings = (owner: string) =>
  fetch(`/api/holdings?owner=${owner}`, { cache: "no-store" }).then((r) => json<{ holdings: { symbol: string; shares: number }[] }>(r));

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

export const fetchRecord = () => fetch("/api/record", { cache: "no-store" }).then((r) => json<{ series: LedgerRow[] }>(r));

/** The hedge on Hyperliquid: what the vaults' open protection calls for, and the hedge account's position (null until it exists). */
export type HedgeResponse = HedgeSummary & { activity: HedgeActivity | null };

export const fetchHedge = () => fetch("/api/hedge", { cache: "no-store" }).then((r) => json<HedgeResponse>(r));

/** A gap report for a book (see /api/gap-report): each stock's openings, its worst night on this position, and protection tonight. */
export type GapReportResponse = GapReport & {
  names: Record<string, string>;
  /** The Solana wallet whose TSLAx and TSLAon were added, when one was given. */
  wallet: { owner: string; holdings: { symbol: string; shares: number }[] } | null;
};

export const fetchGapReport = (q: { book?: string; owner?: string; start: number; stop: number }) => {
  const params = new URLSearchParams({ start: String(q.start), stop: String(q.stop) });
  if (q.book) params.set("book", q.book);
  if (q.owner) params.set("owner", q.owner);
  return fetch(`/api/gap-report?${params}`, { cache: "no-store" }).then((r) => json<GapReportResponse>(r));
};
