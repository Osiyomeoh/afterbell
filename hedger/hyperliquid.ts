/**
 * Hyperliquid orders, built and signed as its Python SDK does
 * (hyperliquid/utils/signing.py): an action is msgpack-encoded, the nonce and
 * a vault flag are appended, and the keccak hash of that is signed as the
 * EIP-712 message Agent { source, connectionId }. An API wallet's key signs;
 * the exchange knows which account it trades for. Nothing here touches the
 * network.
 */
import { concat, keccak256, numberToHex, parseSignature, toHex, type Address, type Hex, type LocalAccount } from "viem";

import { pack, type Packable } from "./msgpack";
import type { Rebalance } from "./target";

export type Network = "mainnet" | "testnet";

export const API_URL: Record<Network, string> = {
  mainnet: "https://api.hyperliquid.xyz",
  testnet: "https://api.hyperliquid-testnet.xyz",
};

/** A price or size as Hyperliquid's wire takes it: at most 8 decimals, no trailing zeros. */
export function floatToWire(x: number): string {
  const rounded = x.toFixed(8);
  if (Math.abs(Number(rounded) - x) >= 1e-12) throw new Error(`${x} has more than 8 decimals`);
  const s = rounded.replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

/**
 * A perp's price rounded to a valid tick, in the direction given: at most 5
 * significant figures and 6 − szDecimals decimals, and a whole number always
 * allowed. Rounding up for a sell and down for a buy keeps a limit inside the
 * band it was set for.
 */
export function perpPrice(px: number, szDecimals: number, direction: "up" | "down"): number {
  if (!(px > 0)) throw new Error("a price must be positive");
  const decimals = Math.min(Math.max(5 - (Math.floor(Math.log10(px)) + 1), 0), 6 - szDecimals);
  const scale = 10 ** decimals;
  const ticks = direction === "up" ? Math.ceil(px * scale - 1e-9) : Math.floor(px * scale + 1e-9);
  return Number((ticks / scale).toFixed(decimals));
}

export type Tif = "Ioc" | "Gtc" | "Alo";

/** One order as the exchange takes it (the SDK's order_request_to_order_wire). */
export type OrderWire = {
  /** Asset id. */
  a: number;
  /** Buy. */
  b: boolean;
  /** Limit price. */
  p: string;
  /** Size. */
  s: string;
  /** Reduce-only. */
  r: boolean;
  t: { limit: { tif: Tif } };
  /** Client order id: 16 bytes as hex. */
  c?: Hex;
};

export function orderAction(orders: OrderWire[]): { type: "order"; orders: OrderWire[]; grouping: "na" } {
  return { type: "order", orders, grouping: "na" };
}

/** Margin mode and leverage for one asset: the hedge runs isolated, so a loss can't reach past its own margin. */
export function updateLeverageAction(asset: number, leverage: number, isCross: boolean) {
  if (!Number.isInteger(leverage) || leverage < 1) throw new Error("leverage is a whole number, at least 1");
  return { type: "updateLeverage", asset, isCross, leverage } as const;
}

/** The hash an action is signed over (the SDK's action_hash). */
export function actionHash(action: Packable, nonce: number, vaultAddress: Address | null = null, expiresAfter: number | null = null): Hex {
  const parts: Hex[] = [toHex(pack(action)), numberToHex(nonce, { size: 8 })];
  parts.push(vaultAddress === null ? "0x00" : concat(["0x01", vaultAddress]));
  if (expiresAfter !== null) parts.push(concat(["0x00", numberToHex(expiresAfter, { size: 8 })]));
  return keccak256(concat(parts));
}

/** The EIP-712 message signed for an action whose hash is `connectionId`. */
export function agentTypedData(connectionId: Hex, network: Network) {
  return {
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
    types: {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent",
    message: { source: network === "mainnet" ? "a" : "b", connectionId },
  } as const;
}

export type Signature = { r: Hex; s: Hex; v: number };

export type SignOptions = { vaultAddress?: Address | null; expiresAfter?: number | null };

export async function signAction(signer: LocalAccount, action: Packable, nonce: number, network: Network, opts: SignOptions = {}): Promise<Signature> {
  const hash = actionHash(action, nonce, opts.vaultAddress ?? null, opts.expiresAfter ?? null);
  const { r, s, v, yParity } = parseSignature(await signer.signTypedData(agentTypedData(hash, network)));
  return { r, s, v: Number(v ?? BigInt(yParity + 27)) };
}

/** The body POSTed to /exchange for a signed action. */
export function exchangeRequest(action: Packable, nonce: number, signature: Signature, opts: SignOptions = {}) {
  return { action, nonce, signature, vaultAddress: opts.vaultAddress ?? null, expiresAfter: opts.expiresAfter ?? null };
}

/** An entry of /info {type: "perpDexs"}: null first (Hyperliquid's own perps), then each builder-deployed dex. */
export type PerpDex = { name: string } | null;

/** The part of /info {type: "meta", dex} used here. */
export type PerpMeta = { universe: { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean }[] };

export type Market = { coin: string; asset: number; szDecimals: number; maxLeverage: number };

/**
 * A perp's asset id and size step, from the dex list and the dex's meta, as
 * the SDK's Info does: a builder dex's assets start at 110000, 10000 apart
 * in the list's order, plus the asset's place in the dex's universe.
 */
export function perpMarket(perpDexs: readonly PerpDex[], dex: string, meta: PerpMeta, coin: string): Market {
  let offset = 0;
  if (dex !== "") {
    const i = perpDexs.findIndex((d) => d?.name === dex);
    if (i < 1) throw new Error(`no perp dex "${dex}"`);
    offset = 110_000 + (i - 1) * 10_000;
  }
  const index = meta.universe.findIndex((u) => u.name === coin);
  const info = meta.universe[index];
  if (!info) throw new Error(`no market "${coin}" on dex "${dex}"`);
  if (info.isDelisted) throw new Error(`${coin} is delisted`);
  return { coin, asset: offset + index, szDecimals: info.szDecimals, maxLeverage: info.maxLeverage };
}

/** How far from the mid an order may fill: 0.2%, so a thin moment can't fill it far away. */
export const DEFAULT_SLIPPAGE = 0.002;

/**
 * The immediate-or-cancel order that makes a rebalance, limited to `slippage`
 * from the mid; null when it holds. A sell grows the short, a buy shrinks it.
 */
export function hedgeOrder(r: Rebalance, mid: number, market: Market, slippage = DEFAULT_SLIPPAGE): OrderWire | null {
  if (r.trade === 0) return null;
  if (!(mid > 0)) throw new Error("no mid price");
  const buy = r.trade < 0;
  const px = perpPrice(mid * (buy ? 1 + slippage : 1 - slippage), market.szDecimals, buy ? "down" : "up");
  const size = Number(Math.abs(r.trade).toFixed(market.szDecimals));
  if (size === 0) throw new Error(`${Math.abs(r.trade)} is below the market's size step`);
  return { a: market.asset, b: buy, p: floatToWire(px), s: floatToWire(size), r: r.reduceOnly, t: { limit: { tif: "Ioc" } } };
}
