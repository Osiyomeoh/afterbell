/**
 * Hyperliquid's /exchange: sends a signed action and reads what came back.
 * An API wallet's key signs (hyperliquid.ts) and the exchange acts for the
 * account that approved it. Requests go through `post`, so tests hand it
 * recorded answers.
 */
import type { Address, LocalAccount } from "viem";

import { API_URL, cancelAction, exchangeRequest, orderAction, signAction, updateLeverageAction, type Network, type OrderWire } from "./hyperliquid";
import type { Packable } from "./msgpack";

export type ExchangePost = (network: Network, body: unknown) => Promise<unknown>;

export const postExchange: ExchangePost = async (network, body) => {
  const res = await fetch(`${API_URL[network]}/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Hyperliquid ${network} /exchange returned ${res.status}: ${await res.text()}`);
  return res.json();
};

/** What /exchange answers once an action is accepted: its type, and each order's or cancel's outcome for those. */
export type ExchangeResponse = { type: string; data?: { statuses: unknown[] } };

type Answer = { status: "ok"; response: ExchangeResponse } | { status: "err"; response: string };

export type Exchange = {
  network: Network;
  /** The API wallet that signs. */
  signer: Address;
  send(action: Packable & { type: string }): Promise<ExchangeResponse>;
};

/**
 * Signs each action with `signer` and posts it. Nonces are the time in
 * milliseconds and must never repeat for a signer, so two actions in the same
 * millisecond take the next one. A refused action throws with the exchange's
 * reason (an API wallet the account hasn't approved is refused this way).
 */
export function createExchange(network: Network, signer: LocalAccount, post: ExchangePost = postExchange, clock: () => number = Date.now): Exchange {
  let last = 0;
  return {
    network,
    signer: signer.address,
    async send(action) {
      const nonce = Math.max(clock(), last + 1);
      last = nonce;
      const signature = await signAction(signer, action, nonce, network);
      const answer = (await post(network, exchangeRequest(action, nonce, signature))) as Answer | null;
      if (answer?.status !== "ok") {
        const why = typeof answer?.response === "string" ? answer.response : JSON.stringify(answer);
        throw new Error(`Hyperliquid ${network} refused the ${action.type}: ${why}`);
      }
      return answer.response;
    },
  };
}

/**
 * One order's outcome: resting on the book, filled (an immediate-or-cancel
 * order may fill only in part, and the rest is cancelled), or refused, as an
 * immediate-or-cancel order is when nothing on the book is inside its limit.
 */
export type OrderResult = { kind: "resting"; oid: number } | { kind: "filled"; oid: number; size: number; avgPx: number } | { kind: "error"; message: string };

type OrderStatus = { resting: { oid: number } } | { filled: { oid: number; totalSz: string; avgPx: string } } | { error: string };

function statuses(response: ExchangeResponse, type: string): unknown[] {
  if (response.type !== type || !response.data) throw new Error(`expected the exchange to answer a ${type}, got ${JSON.stringify(response)}`);
  return response.data.statuses;
}

export function orderResults(response: ExchangeResponse): OrderResult[] {
  return (statuses(response, "order") as OrderStatus[]).map((s) => {
    if ("resting" in s) return { kind: "resting", oid: s.resting.oid };
    if ("filled" in s) return { kind: "filled", oid: s.filled.oid, size: Number(s.filled.totalSz), avgPx: Number(s.filled.avgPx) };
    if ("error" in s) return { kind: "error", message: s.error };
    throw new Error(`unknown order status ${JSON.stringify(s)}`);
  });
}

/** Each cancel's outcome: null when it cancelled, else why not (an order that filled meanwhile can't be). */
export function cancelResults(response: ExchangeResponse): (string | null)[] {
  return (statuses(response, "cancel") as ("success" | { error: string })[]).map((s) => (s === "success" ? null : s.error));
}

export const placeOrders = async (ex: Exchange, orders: OrderWire[]) => orderResults(await ex.send(orderAction(orders)));

export const cancelOrders = async (ex: Exchange, cancels: { a: number; o: number }[]) => cancelResults(await ex.send(cancelAction(cancels)));

export async function setLeverage(ex: Exchange, asset: number, leverage: number, isCross: boolean): Promise<void> {
  const response = await ex.send(updateLeverageAction(asset, leverage, isCross));
  if (response.type !== "default") throw new Error(`expected the exchange to accept the leverage, got ${JSON.stringify(response)}`);
}
