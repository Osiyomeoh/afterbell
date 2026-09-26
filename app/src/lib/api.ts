import type { Opening } from "@root/pricing/model";
import type { Market, PricedProtection, QuoterConfig } from "@root/quoter/quoter";

export type MarketResponse = {
  symbol: string;
  now: number;
  close: number;
  closeTs: number;
  closeSource: "pyth" | "hyperliquid";
  live: number | null;
  liveSource: "pyth" | "hyperliquid";
  inSession: boolean;
  reference: { price: number; basis: string } | null;
  paused: string | null;
  nextOpen: number;
  holidays: string[];
  earlyCloses: [string, { hour: number; minute: number }][];
  history: Opening[];
  annualVol: number;
  config: QuoterConfig;
  solana: { cluster: string; programId: string; vault: string; vaultToken: string; collateralMint: string; quoter: string; feeds: { TSLA: { feedId: string } } };
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

export const fetchMarket = () => fetch("/api/market", { cache: "no-store" }).then((r) => json<MarketResponse>(r));

export const requestQuote = (args: { buyer: string; shares: number; upper: number; lower: number }) =>
  fetch("/api/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chain: "solana", ...args }) }).then((r) =>
    json<QuoteResponse>(r),
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
};

export type VaultResponse = {
  vault: string;
  collateralMint: string;
  collateral: number;
  locked: number;
  openPositions: number;
  series: { address: string; openTs: number; state: SeriesState; price: number | null; publishTime: number | null; positions: number; premiums: number; maxPayouts: number }[];
};

export const fetchVault = () => fetch("/api/vault", { cache: "no-store" }).then((r) => json<VaultResponse>(r));
export const fetchPositions = (owner: string) =>
  fetch(`/api/positions?owner=${owner}`, { cache: "no-store" }).then((r) => json<{ positions: PositionRow[] }>(r));

export type DripResponse = { signature: string | null; testUsd: number; sol: number; alreadyFunded: boolean };

export const requestTestFunds = (owner: string) =>
  fetch("/api/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner }) }).then((r) => json<DripResponse>(r));

export const fetchHoldings = (owner: string) =>
  fetch(`/api/holdings?owner=${owner}`, { cache: "no-store" }).then((r) => json<{ holdings: { symbol: string; shares: number }[] }>(r));
