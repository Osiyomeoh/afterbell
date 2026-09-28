/**
 * A typed client for Afterbell's public HTTP API: prices, signed quotes,
 * positions, vaults, the track record, gap reports, the hedge and status.
 * It holds no keys: a quote is signed by the service for the buyer named in
 * it, and only that buyer's wallet can submit it (see ./solana and ./robinhood).
 */
import type { Market } from "../quoter/quoter";

import type {
  BoardRow,
  DripResult,
  EvmQuoteResponse,
  GapReportResponse,
  HedgeInfo,
  LedgerRow,
  MarketInfo,
  PositionInfo,
  Protection,
  QuoteRequest,
  SolanaQuoteResponse,
  StatusReport,
  VaultInfo,
} from "./types";

/** A request the API refused or couldn't answer, with its status and the API's own message. */
export class AfterbellError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AfterbellError";
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export class AfterbellClient {
  /** `baseUrl`: where the app is served, e.g. https://afterbell-nine.vercel.app. */
  constructor(
    readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = globalThis.fetch,
  ) {}

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchFn(new URL(path, this.baseUrl), { ...init, headers: { "content-type": "application/json", ...init?.headers } });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new AfterbellError(body.error ?? `${path} returned ${res.status}`, res.status);
    return body;
  }

  private post = <T>(path: string, body: unknown) => this.call<T>(path, { method: "POST", body: JSON.stringify(body) });

  market = (symbol = "TSLA") => this.call<MarketInfo>(`/api/market?symbol=${encodeURIComponent(symbol)}`);
  board = () => this.call<{ rows: BoardRow[] }>("/api/board").then((r) => r.rows);

  /** A signed quote for `buyer`, valid for about a minute. Solana answers with an ed25519 quote, Robinhood Chain with an EIP-712 one. */
  quote(q: QuoteRequest & { chain: "solana" }): Promise<SolanaQuoteResponse>;
  quote(q: QuoteRequest & { chain: "robinhood" }): Promise<EvmQuoteResponse>;
  quote(q: QuoteRequest): Promise<SolanaQuoteResponse | EvmQuoteResponse> {
    return this.post("/api/quote", q);
  }

  /**
   * The strikes for protection starting `start` below the stock's price and
   * stopping `depth` below it (0.02 and 0.10 for 2% to 10%), as the app sets
   * them. Fails while trading in the stock is paused.
   */
  async protectionBelow(symbol: string, shares: number, start: number, depth: number): Promise<Protection> {
    if (!(start > 0 && start < 1 && depth > 0 && depth < 1)) throw new RangeError("start and depth are fractions of the price, between 0 and 1");
    const m = await this.market(symbol);
    if (!m.reference) throw new AfterbellError(`${symbol} can't be priced now${m.paused ? `: ${m.paused}` : ""}`, 409);
    const p = m.reference.price;
    return { shares, upper: round2(p * (1 - start)), lower: round2(p * (1 - Math.max(depth, start + 0.01))) };
  }

  positions = (owner: string) => this.call<{ positions: PositionInfo[] }>(`/api/positions?owner=${encodeURIComponent(owner)}`).then((r) => r.positions);
  vault = (chain: "solana" | "robinhood" = "solana") => this.call<VaultInfo>(chain === "robinhood" ? "/api/vault?chain=robinhood" : "/api/vault");
  record = () => this.call<{ series: LedgerRow[] }>("/api/record").then((r) => r.series);
  /** A Solana wallet's TSLAx and TSLAon on mainnet, in shares. */
  holdings = (owner: string) => this.call<{ holdings: { symbol: string; shares: number }[] }>(`/api/holdings?owner=${encodeURIComponent(owner)}`).then((r) => r.holdings);

  /** A book ("TSLA:100,NVDA:$25000") or a Solana wallet's TSLA, with protection from `start` to `stop` percent below. */
  gapReport(q: { book?: string; owner?: string; start: number; stop: number }): Promise<GapReportResponse> {
    const params = new URLSearchParams({ start: String(q.start), stop: String(q.stop) });
    if (q.book) params.set("book", q.book);
    if (q.owner) params.set("owner", q.owner);
    return this.call(`/api/gap-report?${params}`);
  }

  hedge = () => this.call<HedgeInfo>("/api/hedge");
  /** Resolves even when something is down (the API answers 503 then): read `checks`. */
  status = async (): Promise<StatusReport> => {
    const res = await this.fetchFn(new URL("/api/status", this.baseUrl));
    return (await res.json()) as StatusReport;
  };
  /** Devnet only: 1,000 TestUSD and a little SOL for a wallet that's short of them. */
  faucet = (owner: string) => this.post<DripResult>("/api/faucet", { owner });
}

/** The quoter's Market from the API's JSON, to price locally exactly as the service does. */
export function toMarket(m: MarketInfo): Market {
  return { symbol: m.symbol, close: m.close, live: m.live ?? undefined, history: m.history, annualVol: m.annualVol, holidays: new Set(m.holidays), earlyCloses: new Map(m.earlyCloses) };
}
