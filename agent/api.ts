/**
 * The agent's view of Afterbell: the app's public HTTP routes, so the MCP
 * tools price and sign exactly as the site does. No keys here.
 */
import type { Opening } from "../pricing/model";
import type { Market, PricedProtection, QuoterConfig } from "../quoter/quoter";

export type MarketInfo = {
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
  solana: { vault: string; collateralMint: string; programId: string; quoter: string };
};

export type SolanaQuoteResponse = {
  priced: PricedProtection;
  solana: {
    programId: string;
    vault: string;
    collateralMint: string;
    quote: Record<"feedId" | "openTs" | "shares" | "upper" | "lower" | "premium" | "expiry" | "nonce", string>;
    ed25519Data: string;
  };
};

export type PositionInfo = {
  address: string;
  series: string;
  buyer: string;
  openTs: number;
  state: "open" | "settled" | "voided";
  shares: number;
  upper: number;
  lower: number;
  premium: number;
  maxPayout: number;
  claimable: number | null;
  settlementPrice: number | null;
};

export type VaultInfo = {
  vault: string;
  collateral: number;
  locked: number;
  openPositions: number;
  series: { address: string; openTs: number; state: string; price: number | null; positions: number; premiums: number; maxPayouts: number }[];
};

export class AfterbellApi {
  constructor(readonly baseUrl: string) {}

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(new URL(path, this.baseUrl), { ...init, headers: { "content-type": "application/json", ...init?.headers } });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `${path} returned ${res.status}`);
    return body;
  }

  market = () => this.call<MarketInfo>("/api/market");
  quote = (buyer: string, p: { shares: number; upper: number; lower: number }) =>
    this.call<SolanaQuoteResponse>("/api/quote", { method: "POST", body: JSON.stringify({ chain: "solana", buyer, ...p }) });
  positions = (owner: string) => this.call<{ positions: PositionInfo[] }>(`/api/positions?owner=${owner}`).then((r) => r.positions);
  vault = () => this.call<VaultInfo>("/api/vault");
  holdings = (owner: string) => this.call<{ holdings: { symbol: string; shares: number }[] }>(`/api/holdings?owner=${owner}`).then((r) => r.holdings);
  faucet = (owner: string) =>
    this.call<{ signature: string | null; testUsd: number; sol: number; alreadyFunded: boolean }>("/api/faucet", { method: "POST", body: JSON.stringify({ owner }) });
}

/** The quoter's Market from the API's JSON, to price locally exactly as the server does. */
export function toMarket(m: MarketInfo): Market {
  return { symbol: m.symbol, close: m.close, live: m.live ?? undefined, history: m.history, annualVol: m.annualVol, holidays: new Set(m.holidays), earlyCloses: new Map(m.earlyCloses) };
}
