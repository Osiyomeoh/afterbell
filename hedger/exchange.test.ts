import { pad, recoverTypedDataAddress, serializeSignature, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { cancelOrders, cancelResults, createExchange, orderResults, placeOrders, setLeverage, type ExchangePost } from "./exchange";
import { actionHash, agentTypedData, orderAction, type Network, type OrderWire, type Signature } from "./hyperliquid";
import type { Packable } from "./msgpack";

const agent = privateKeyToAccount(generatePrivateKey());
const NOW = 1_790_000_000_000;
const sell: OrderWire = { a: 750_001, b: false, p: "372.59", s: "0.831", r: false, t: { limit: { tif: "Ioc" } } };

type Posted = { network: Network; body: { action: Packable; nonce: number; signature: Signature; vaultAddress: null; expiresAfter: null } };

/** Answers each post with the next recorded answer, and keeps what was posted. */
function fakeExchange(...answers: unknown[]) {
  const posted: Posted[] = [];
  const post: ExchangePost = async (network, body) => {
    posted.push({ network, body: body as Posted["body"] });
    return answers.shift();
  };
  return { post, posted };
}

const signerOf = (p: Posted) =>
  recoverTypedDataAddress({
    ...agentTypedData(actionHash(p.body.action, p.body.nonce), p.network),
    signature: serializeSignature({ r: pad(p.body.signature.r as Hex, { size: 32 }), s: pad(p.body.signature.s as Hex, { size: 32 }), yParity: p.body.signature.v - 27 }),
  });

// Answers as Hyperliquid's docs show them.
const ok = (type: string, statuses?: unknown[]) => ({ status: "ok", response: statuses ? { type, data: { statuses } } : { type } });

describe("createExchange", () => {
  it("signs with the API wallet, so the exchange recovers it, and posts the SDK's body", async () => {
    const { post, posted } = fakeExchange(ok("order", [{ resting: { oid: 77_738_308 } }]));
    const ex = createExchange("testnet", agent, post, () => NOW);
    expect(await placeOrders(ex, [sell])).toEqual([{ kind: "resting", oid: 77_738_308 }]);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.network).toBe("testnet");
    expect(posted[0]!.body).toMatchObject({ action: orderAction([sell]), nonce: NOW, vaultAddress: null, expiresAfter: null });
    expect(await signerOf(posted[0]!)).toBe(agent.address);
  });

  it("never repeats a nonce, even within a millisecond", async () => {
    const { post, posted } = fakeExchange(ok("default"), ok("default"), ok("default"));
    const ex = createExchange("testnet", agent, post, () => NOW);
    for (let i = 0; i < 3; i++) await setLeverage(ex, 750_001, 3, false);
    expect(posted.map((p) => p.body.nonce)).toEqual([NOW, NOW + 1, NOW + 2]);
  });

  it("throws the exchange's reason when it refuses an action", async () => {
    const refused = { status: "err", response: `User or API Wallet ${agent.address.toLowerCase()} does not exist.` };
    const ex = createExchange("testnet", agent, fakeExchange(refused).post, () => NOW);
    await expect(placeOrders(ex, [sell])).rejects.toThrow(/refused the order: User or API Wallet .* does not exist/);
  });
});

describe("reading answers", () => {
  it("reads a fill, a partial fill and an immediate-or-cancel order that found nothing", () => {
    const answer = ok("order", [
      { filled: { totalSz: "0.831", avgPx: "373.26", oid: 1 } },
      { filled: { totalSz: "0.5", avgPx: "373.27", oid: 2 } },
      { error: "Order could not immediately match against any resting orders. asset=750001" },
    ]).response;
    expect(orderResults(answer)).toEqual([
      { kind: "filled", oid: 1, size: 0.831, avgPx: 373.26 },
      { kind: "filled", oid: 2, size: 0.5, avgPx: 373.27 },
      { kind: "error", message: "Order could not immediately match against any resting orders. asset=750001" },
    ]);
  });

  it("reads each cancel: done, or why not", async () => {
    const { post, posted } = fakeExchange(ok("cancel", ["success", { error: "Order was never placed, already canceled, or filled. asset=750001" }]));
    const ex = createExchange("testnet", agent, post, () => NOW);
    expect(await cancelOrders(ex, [{ a: 750_001, o: 101 }, { a: 750_001, o: 103 }])).toEqual([null, "Order was never placed, already canceled, or filled. asset=750001"]);
    expect(posted[0]!.body.action).toEqual({ type: "cancel", cancels: [{ a: 750_001, o: 101 }, { a: 750_001, o: 103 }] });
  });

  it("refuses an answer for another kind of action, or a status it doesn't know", async () => {
    expect(() => orderResults({ type: "cancel", data: { statuses: ["success"] } })).toThrow(/expected the exchange to answer a order/);
    expect(() => cancelResults({ type: "default" })).toThrow(/expected/);
    // The Rust SDK's statuses include bare strings; one shouldn't come back for a limit order, and an object we don't know is refused too.
    for (const status of ["waitingForFill", "success", { waitingForFill: {} }, null])
      expect(() => orderResults({ type: "order", data: { statuses: [status] } })).toThrow(/unknown order status/);
    for (const status of ["waitingForFill", { resting: { oid: 1 } }])
      expect(() => cancelResults({ type: "cancel", data: { statuses: [status] } })).toThrow(/unknown cancel status/);
    const ex = createExchange("testnet", agent, fakeExchange(ok("order", [])).post, () => NOW);
    await expect(setLeverage(ex, 750_001, 3, false)).rejects.toThrow(/accept the leverage/);
  });
});
