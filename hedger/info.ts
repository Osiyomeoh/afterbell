/**
 * Hyperliquid's public /info endpoint, read without a key: the dex list and a
 * dex's markets (for the asset id and size step), an account's position and
 * resting orders in one market, and that market's best bid and ask. Requests
 * go through `post`, so tests hand it recorded answers.
 */
import type { Address } from "viem";

import { API_URL, perpMarket, type Market, type Network, type PerpDex, type PerpMeta } from "./hyperliquid";
import type { RestingOrder } from "./quotes";

export type Post = (network: Network, body: Record<string, unknown>) => Promise<unknown>;

export const postInfo: Post = async (network, body) => {
  const res = await fetch(`${API_URL[network]}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Hyperliquid ${network} /info ${String(body.type)} returned ${res.status}`);
  return res.json();
};

/** The dex a coin trades on: "xyz" for "xyz:TSLA", "" for Hyperliquid's own perps. */
export const dexOf = (coin: string) => (coin.includes(":") ? coin.slice(0, coin.indexOf(":")) : "");

/** A market's asset id and size step on `network`, from that network's own dex list. */
export async function fetchMarket(post: Post, network: Network, coin: string): Promise<Market> {
  const dex = dexOf(coin);
  const [dexes, meta] = await Promise.all([post(network, { type: "perpDexs" }), post(network, { type: "meta", dex })]);
  return perpMarket(dexes as PerpDex[], dex, meta as PerpMeta, coin);
}

/** The part of /info {type: "clearinghouseState"} used here: one entry per open position, strings as sent. */
export type ClearinghouseState = {
  marginSummary: { accountValue: string };
  withdrawable: string;
  assetPositions: {
    position: {
      coin: string;
      /** Signed size: negative is a short. */
      szi: string;
      entryPx: string | null;
      unrealizedPnl: string;
      liquidationPx: string | null;
      marginUsed: string;
      leverage: { type: "isolated" | "cross"; value: number };
    };
  }[];
};

export type HedgePosition = {
  /** The short held, in shares: negative would be a long. */
  short: number;
  entryPx: number | null;
  unrealizedPnl: number;
  liquidationPx: number | null;
  marginUsed: number;
  leverage: { type: "isolated" | "cross"; value: number };
};

export type HedgeAccount = {
  address: Address;
  /**
   * What backs its orders: what it holds on the coin's dex (each builder dex
   * margins separately), or for a unified account its USDC, which backs every dex.
   */
  accountValue: number;
  withdrawable: number;
  /** A unified (or portfolio-margin) account: one USDC balance, kept in its spot state, backs every dex. */
  unified: boolean;
  /** Its position in the coin, or null when it has none. */
  position: HedgePosition | null;
};

const num = (s: string | null) => (s === null ? null : Number(s));

export function hedgeAccount(address: Address, state: ClearinghouseState, coin: string): HedgeAccount {
  const p = state.assetPositions.find((a) => a.position.coin === coin)?.position;
  return {
    address,
    accountValue: Number(state.marginSummary.accountValue),
    withdrawable: Number(state.withdrawable),
    unified: false,
    position: p
      ? {
          short: -Number(p.szi),
          entryPx: num(p.entryPx),
          unrealizedPnl: Number(p.unrealizedPnl),
          liquidationPx: num(p.liquidationPx),
          marginUsed: Number(p.marginUsed),
          leverage: { type: p.leverage.type, value: p.leverage.value },
        }
      : null,
  };
}

/** The hedge account's position in `coin` on `network`, from the public endpoint: an address, no key. */
/** Account modes that keep one balance per collateral asset in the spot state, backing every dex. */
const POOLED = new Set(["unifiedAccount", "portfolioMargin"]);

type SpotState = { balances: { coin: string; total: string; hold: string }[] };

/**
 * The account's position in the coin and what backs its orders. A unified
 * account's balance is in its spot state, and Hyperliquid says its per-dex
 * states aren't meaningful for balances, so its USDC is read from there.
 */
export async function fetchHedgeAccount(post: Post, network: Network, address: Address, coin: string): Promise<HedgeAccount> {
  const [state, mode] = await Promise.all([
    post(network, { type: "clearinghouseState", user: address, dex: dexOf(coin) }) as Promise<ClearinghouseState>,
    post(network, { type: "userAbstraction", user: address }).catch(() => null),
  ]);
  const account = hedgeAccount(address, state, coin);
  if (typeof mode !== "string" || !POOLED.has(mode)) return account;
  const spot = (await post(network, { type: "spotClearinghouseState", user: address })) as SpotState;
  const usdc = spot.balances.find((b) => b.coin === "USDC");
  const total = Number(usdc?.total ?? 0);
  return { ...account, accountValue: total, withdrawable: total - Number(usdc?.hold ?? 0), unified: true };
}

/** An entry of /info {type: "openOrders"}: side "B" is a bid, "A" an ask; `sz` is what's left unfilled. */
export type OpenOrder = { coin: string; side: "A" | "B"; limitPx: string; sz: string; oid: number; timestamp: number };

/** The account's orders resting in `coin`, asking the coin's dex (each builder dex keeps its own). */
export async function fetchOpenOrders(post: Post, network: Network, address: Address, coin: string): Promise<RestingOrder[]> {
  const orders = (await post(network, { type: "openOrders", user: address, dex: dexOf(coin) })) as OpenOrder[];
  return orders.filter((o) => o.coin === coin).map((o) => ({ oid: o.oid, buy: o.side === "B", px: Number(o.limitPx), size: Number(o.sz) }));
}

export type BookLevel = { px: number; size: number };

/** /info {type: "l2Book"}: bids best first, then asks best first. */
type L2Book = { levels: [{ px: string; sz: string; n: number }[], { px: string; sz: string; n: number }[]] };

/** The best bid and ask in `coin` on `network`, each null when that side is empty. */
export async function fetchTopOfBook(post: Post, network: Network, coin: string): Promise<{ bid: BookLevel | null; ask: BookLevel | null }> {
  const book = (await post(network, { type: "l2Book", coin })) as L2Book;
  const top = (side: { px: string; sz: string }[]) => (side[0] ? { px: Number(side[0].px), size: Number(side[0].sz) } : null);
  return { bid: top(book.levels[0]), ask: top(book.levels[1]) };
}

/** A fill as /info {type: "userFillsByTime"} sends it (the fields used here): side "A" sold, "B" bought; `dir` is Hyperliquid's own word for it, "Open Short" say. */
export type Fill = { coin: string; side: "A" | "B"; px: string; sz: string; fee: string; closedPnl: string; dir: string; time: number; hash: string };

/** A funding payment as /info {type: "userFunding"} sends it: `usdc` above 0 was received, below 0 paid. */
export type FundingPayment = { time: number; hash: string; delta: { type: "funding"; coin: string; usdc: string; szi: string; fundingRate: string } };

export type HedgeFill = { time: number; sell: boolean; size: number; price: number; fee: number; closedPnl: number; dir: string };

/** The account's trading in the coin since `since` (unix seconds): its latest fills, newest first, and totals. */
export type HedgeActivity = {
  since: number;
  fills: HedgeFill[];
  trades: number;
  fees: number;
  closedPnl: number;
  /** Funding received, net: below 0 it paid more than it got. */
  funding: number;
  fundingPayments: number;
};

export function hedgeActivity(since: number, fills: readonly Fill[], funding: readonly FundingPayment[], coin: string, latest = 10): HedgeActivity {
  const mine = fills
    .filter((f) => f.coin === coin && f.time >= since * 1000)
    .sort((a, b) => b.time - a.time)
    .map((f) => ({ time: Math.floor(f.time / 1000), sell: f.side === "A", size: Number(f.sz), price: Number(f.px), fee: Number(f.fee), closedPnl: Number(f.closedPnl), dir: f.dir }));
  const paid = funding.filter((f) => f.delta.type === "funding" && f.delta.coin === coin && f.time >= since * 1000);
  const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);
  return {
    since,
    fills: mine.slice(0, latest),
    trades: mine.length,
    fees: sum(mine.map((f) => f.fee)),
    closedPnl: sum(mine.map((f) => f.closedPnl)),
    funding: sum(paid.map((f) => Number(f.delta.usdc))),
    fundingPayments: paid.length,
  };
}

/**
 * The account's fills and funding in `coin` since `since`, from the public
 * endpoint. Neither request takes a dex: they cover every market the account
 * trades, so each is filtered to the coin. Partial fills of one order are
 * combined, as Hyperliquid's own history shows them.
 */
export async function fetchHedgeActivity(post: Post, network: Network, address: Address, coin: string, since: number): Promise<HedgeActivity> {
  const [fills, funding] = await Promise.all([
    post(network, { type: "userFillsByTime", user: address, startTime: since * 1000, aggregateByTime: true }) as Promise<Fill[]>,
    post(network, { type: "userFunding", user: address, startTime: since * 1000 }) as Promise<FundingPayment[]>,
  ]);
  return hedgeActivity(since, fills, funding, coin);
}
