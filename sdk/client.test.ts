import { describe, expect, it } from "vitest";

import { AfterbellClient, AfterbellError } from "./client";

/** A fetch that answers from a table, keyed by method and path, recording each request. */
function fakeFetch(answers: Record<string, { status?: number; body: unknown }>) {
  const asked: { method: string; url: URL; body: unknown }[] = [];
  const fetchFn = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    asked.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const answer = answers[`${method} ${url.pathname}`];
    if (!answer) return new Response(JSON.stringify({ error: "no such route" }), { status: 404 });
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as typeof fetch;
  return { fetchFn, asked };
}

const BASE = "https://afterbell.example";
const market = (reference: { price: number; basis: string } | null, paused: string | null = null) => ({ body: { symbol: "TSLA", reference, paused } });

describe("AfterbellClient", () => {
  it("asks for a quote on the chain named, with the strikes as given", async () => {
    const { fetchFn, asked } = fakeFetch({ "POST /api/quote": { body: { priced: {}, evm: {} } } });
    await new AfterbellClient(BASE, fetchFn).quote({ chain: "robinhood", symbol: "TSLA", buyer: "0xabc", shares: 1, upper: 354.2, lower: 325.29 });
    expect(asked).toEqual([{ method: "POST", url: new URL("/api/quote", BASE), body: { chain: "robinhood", symbol: "TSLA", buyer: "0xabc", shares: 1, upper: 354.2, lower: 325.29 } }]);
  });

  it("sets strikes below the reference price as the app does, and refuses while trading is paused", async () => {
    // TSLA's reference at 14:08 UTC on 28 Sep; the live Robinhood Chain quote then used 354.20 and 325.29.
    const live = new AfterbellClient(BASE, fakeFetch({ "GET /api/market": market({ price: 361.42991, basis: "live" }) }).fetchFn);
    expect(await live.protectionBelow("TSLA", 1, 0.02, 0.1)).toEqual({ shares: 1, upper: 354.2, lower: 325.29 });
    // Protection stops at least a point below where it starts.
    expect(await live.protectionBelow("TSLA", 1, 0.05, 0.05)).toEqual({ shares: 1, upper: 343.36, lower: 339.74 });
    await expect(live.protectionBelow("TSLA", 1, 2, 10)).rejects.toThrow(RangeError);

    const paused = new AfterbellClient(BASE, fakeFetch({ "GET /api/market": market(null, "a stock split") }).fetchFn);
    await expect(paused.protectionBelow("TSLA", 1, 0.02, 0.1)).rejects.toThrow("TSLA can't be priced now: a stock split");
  });

  it("raises the API's own message and status when it refuses", async () => {
    const { fetchFn } = fakeFetch({ "POST /api/quote": { status: 409, body: { error: "protection until this open isn't on sale" } } });
    const err = await new AfterbellClient(BASE, fetchFn).quote({ chain: "solana", symbol: "TSLA", buyer: "x", shares: 1, upper: 2, lower: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(AfterbellError);
    expect(err).toMatchObject({ message: "protection until this open isn't on sale", status: 409 });
  });

  it("reads status even when the service says something is down", async () => {
    const report = { now: 1, checks: [{ name: "Test-money faucet", state: "down", detail: "No faucet key is set." }] };
    const client = new AfterbellClient(BASE, fakeFetch({ "GET /api/status": { status: 503, body: report } }).fetchFn);
    expect(await client.status()).toEqual(report);
  });

  it("sends a gap report's book and levels as query parameters", async () => {
    const { fetchFn, asked } = fakeFetch({ "GET /api/gap-report": { body: {} } });
    await new AfterbellClient(BASE, fetchFn).gapReport({ book: "TSLA:100,NVDA:$25000", start: 2, stop: 10 });
    expect(Object.fromEntries(asked[0]!.url.searchParams)).toEqual({ book: "TSLA:100,NVDA:$25000", start: "2", stop: "10" });
  });
});
