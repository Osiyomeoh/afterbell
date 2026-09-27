/**
 * Hyperliquid's public /info endpoint, read without a key: the dex list and a
 * dex's markets (for the asset id and size step), and an account's position
 * in one market. Requests go through `post`, so tests hand it recorded
 * answers.
 */
import type { Address } from "viem";

import { API_URL, perpMarket, type Market, type Network, type PerpDex, type PerpMeta } from "./hyperliquid";

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
  /** What the account holds on the coin's dex (each builder dex margins separately). */
  accountValue: number;
  withdrawable: number;
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
export async function fetchHedgeAccount(post: Post, network: Network, address: Address, coin: string): Promise<HedgeAccount> {
  const state = (await post(network, { type: "clearinghouseState", user: address, dex: dexOf(coin) })) as ClearinghouseState;
  return hedgeAccount(address, state, coin);
}
