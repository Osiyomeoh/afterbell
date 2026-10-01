import { describe, expect, it } from "vitest";

import { quoteBook } from "./book";
import { AfterbellClient } from "./client";

const BASE = "https://afterbell.example";
describe("quoteBook", () => {
  it("quotes every line for one buyer, sizing a dollar line at its price, and reports a line it can't sell", async () => {
    const prices: Record<string, number> = { TSLA: 361.43, NVDA: 231.21 };
    const asked: unknown[] = [];
    const fetchFn = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/market") {
        const sym = url.searchParams.get("symbol")!;
        if (!prices[sym]) return new Response(JSON.stringify({ error: `unknown stock: ${sym}` }), { status: 404 });
        return new Response(JSON.stringify({ symbol: sym, reference: { price: prices[sym], basis: "live" }, paused: null }));
      }
      const body = JSON.parse(String(init!.body));
      asked.push(body);
      return new Response(JSON.stringify({ priced: { premium: body.shares * 0.3, maxPayout: body.shares * (body.upper - body.lower) }, evm: {} }));
    }) as typeof fetch;

    const b = await quoteBook(new AfterbellClient(BASE, fetchFn), { chain: "robinhood", book: "TSLA:100,NVDA:$25000,XYZ:5", buyer: "0xabc", start: 0.02, depth: 0.1 });
    expect(b.lines.map((l) => [l.symbol, l.shares, "error" in l ? l.error : "quoted"])).toEqual([
      ["TSLA", 100, "quoted"],
      ["NVDA", 108.126811, "quoted"], // $25,000 at $231.21, to six decimals, rounded down
      ["XYZ", 5, "unknown stock: XYZ"],
    ]);
    expect(asked[0]).toEqual({ chain: "robinhood", symbol: "TSLA", buyer: "0xabc", shares: 100, upper: 354.2, lower: 325.29 });
    expect(b.premium).toBeCloseTo((100 + 108.126811) * 0.3, 6);
    await expect(quoteBook(new AfterbellClient(BASE, fetchFn), { chain: "robinhood", book: "TSLA:1", buyer: "0xabc", start: 2, depth: 10 })).rejects.toThrow(RangeError);
  });
});
