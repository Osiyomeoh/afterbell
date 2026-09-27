import { pad, recoverTypedDataAddress, serializeSignature, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
  actionHash,
  agentTypedData,
  cancelAction,
  exchangeRequest,
  floatToWire,
  hedgeOrder,
  orderAction,
  perpMarket,
  perpPrice,
  signAction,
  updateLeverageAction,
  type Network,
  type OrderWire,
  type PerpMeta,
  type Signature,
} from "./hyperliquid";
import type { Packable } from "./msgpack";
import { DEFAULT_BAND, rebalance } from "./target";

/**
 * Vectors from Hyperliquid's Python SDK (tests/signing_test.py at 2fdb18f951):
 * each action and the signature the SDK expects for it. They were made with the
 * SDK's public test wallet; only its address is kept here, and each test checks
 * that the expected signature over the hash computed here recovers to it. A byte
 * wrong in the encoding or the hash recovers someone else.
 */
const SDK_TEST_SIGNER: Address = "0x14791697260E4c9A71f18484C9f997B308e59325";

type Vector = { action: Packable; nonce: number; vaultAddress?: Address; mainnet: Signature; testnet: Signature };

const order100: OrderWire = { a: 1, b: true, p: "100", s: "100", r: false, t: { limit: { tif: "Gtc" } } };

const VECTORS: Record<string, Vector> = {
  "a dummy action": {
    action: { type: "dummy", num: 100_000_000_000 },
    nonce: 0,
    mainnet: { r: "0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298", s: "0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8", v: 27 },
    testnet: { r: "0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510", s: "0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613", v: 28 },
  },
  "an order": {
    action: orderAction([order100]),
    nonce: 0,
    mainnet: { r: "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e", s: "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e", v: 28 },
    testnet: { r: "0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54", s: "0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5", v: 27 },
  },
  "an order with a client id": {
    action: orderAction([{ ...order100, c: "0x00000000000000000000000000000001" }]),
    nonce: 0,
    mainnet: { r: "0x41ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3", s: "0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da", v: 27 },
    testnet: { r: "0xeba0664bed2676fc4e5a743bf89e5c7501aa6d870bdb9446e122c9466c5cd16d", s: "0x7f3e74825c9114bc59086f1eebea2928c190fdfbfde144827cb02b85bbe90988", v: 28 },
  },
  "an action for a vault": {
    action: { type: "dummy", num: 100_000_000_000 },
    nonce: 0,
    vaultAddress: "0x1719884eb866cb12b2287399b15f7db5e7d775ea",
    mainnet: { r: "0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239", s: "0x4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2c", v: 28 },
    testnet: { r: "0xe281d2fb5c6e25ca01601f878e4d69c965bb598b88fac58e475dd1f5e56c362b", s: "0x7ddad27e9a238d045c035bc606349d075d5c5cd00a6cd1da23ab5c39d4ef0f60", v: 27 },
  },
  "a scheduled cancel": {
    action: { type: "scheduleCancel" },
    nonce: 0,
    mainnet: { r: "0x6cdfb286702f5917e76cd9b3b8bf678fcc49aec194c02a73e6d4f16891195df9", s: "0x6557ac307fa05d25b8d61f21fb8a938e703b3d9bf575f6717ba21ec61261b2a0", v: 27 },
    testnet: { r: "0xc75bb195c3f6a4e06b7d395acc20bbb224f6d23ccff7c6a26d327304e6efaeed", s: "0x342f8ede109a29f2c0723bd5efb9e9100e3bbb493f8fb5164ee3d385908233df", v: 28 },
  },
  "a scheduled cancel with a time": {
    action: { type: "scheduleCancel", time: 123_456_789 },
    nonce: 0,
    mainnet: { r: "0x609cb20c737945d070716dcc696ba030e9976fcf5edad87afa7d877493109d55", s: "0x16c685d63b5c7a04512d73f183b3d7a00da5406ff1f8aad33f8ae2163bab758b", v: 28 },
    testnet: { r: "0x4e4f2dbd4107c69783e251b7e1057d9f2b9d11cee213441ccfa2be63516dc5bc", s: "0x706c656b23428c8ba356d68db207e11139ede1670481a9e01ae2dfcdb0e1a678", v: 27 },
  },
};

const signerOf = (hash: Hex, network: Network, sig: Signature) =>
  recoverTypedDataAddress({
    ...agentTypedData(hash, network),
    signature: serializeSignature({ r: pad(sig.r, { size: 32 }), s: pad(sig.s, { size: 32 }), yParity: sig.v - 27 }),
  });

describe("signing, against the Python SDK", () => {
  for (const [name, v] of Object.entries(VECTORS)) {
    it(`hashes ${name} as the SDK does, on mainnet and testnet`, async () => {
      const hash = actionHash(v.action, v.nonce, v.vaultAddress ?? null);
      expect(await signerOf(hash, "mainnet", v.mainnet)).toBe(SDK_TEST_SIGNER);
      expect(await signerOf(hash, "testnet", v.testnet)).toBe(SDK_TEST_SIGNER);
    });
  }

  it("hashes a real order as production did (test_phantom_agent_creation_matches_production)", () => {
    const order: OrderWire = { a: 4, b: true, p: floatToWire(1670.1), s: floatToWire(0.0147), r: false, t: { limit: { tif: "Ioc" } } };
    expect(actionHash(orderAction([order]), 1_677_777_606_040)).toBe("0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908");
  });

  it("changes the hash with an expiry, as the SDK appends it", () => {
    const action = { type: "scheduleCancel" };
    expect(actionHash(action, 0, null, 1)).not.toBe(actionHash(action, 0));
  });

  it("signs so the exchange recovers the signing key, with v as 27 or 28", async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const action = orderAction([order100]);
    for (const network of ["mainnet", "testnet"] as const) {
      const sig = await signAction(signer, action, 1_790_000_000_000, network);
      expect([27, 28]).toContain(sig.v);
      expect(await signerOf(actionHash(action, 1_790_000_000_000), network, sig)).toBe(signer.address);
      // Signed for one network, it recovers someone else on the other: no replay across them.
      expect(await signerOf(actionHash(action, 1_790_000_000_000), network === "mainnet" ? "testnet" : "mainnet", sig)).not.toBe(signer.address);
    }
  });

  it("builds the body POSTed to /exchange", () => {
    const sig: Signature = { r: "0x01", s: "0x02", v: 27 };
    expect(exchangeRequest({ type: "scheduleCancel" }, 5, sig)).toEqual({ action: { type: "scheduleCancel" }, nonce: 5, signature: sig, vaultAddress: null, expiresAfter: null });
  });
});

describe("wire formats", () => {
  it("writes numbers as the SDK's float_to_wire does", () => {
    expect([100, 0.0147, 1670.1, 1e-8, 371.02, 1.16].map(floatToWire)).toEqual(["100", "0.0147", "1670.1", "0.00000001", "371.02", "1.16"]);
    expect(() => floatToWire(1.123456789)).toThrow();
  });

  it("rounds prices to a valid tick, in the direction asked (the docs' examples)", () => {
    expect(perpPrice(1234.56, 0, "down")).toBe(1234.5);
    expect(perpPrice(1234.56, 0, "up")).toBe(1234.6);
    expect(perpPrice(0.0012345, 0, "down")).toBe(0.001234);
    expect(perpPrice(0.012345, 1, "down")).toBe(0.01234);
    expect(perpPrice(123456.7, 0, "down")).toBe(123456);
    expect(perpPrice(371.01648, 3, "up")).toBe(371.02);
    expect(perpPrice(372.50352, 3, "down")).toBe(372.5);
    expect(perpPrice(371.76, 3, "up")).toBe(371.76);
    expect(() => perpPrice(0, 3, "up")).toThrow();
  });

  it("cancels by asset and order id in the SDK's field order", () => {
    const action = cancelAction([{ a: 750_001, o: 101 }, { o: 103, a: 750_001 }]);
    expect(action).toEqual({ type: "cancel", cancels: [{ a: 750_001, o: 101 }, { a: 750_001, o: 103 }] });
    expect(action.cancels.map((c) => Object.keys(c))).toEqual([["a", "o"], ["a", "o"]]);
  });

  it("sets isolated leverage in the SDK's field order", () => {
    expect(Object.keys(updateLeverageAction(110_001, 3, false))).toEqual(["type", "asset", "isCross", "leverage"]);
    expect(() => updateLeverageAction(110_001, 2.5, false)).toThrow();
  });
});

describe("markets", () => {
  const dexes = [null, { name: "xyz" }, { name: "flx" }];
  const xyz: PerpMeta = {
    universe: [
      { name: "xyz:XYZ100", szDecimals: 4, maxLeverage: 20 },
      { name: "xyz:TSLA", szDecimals: 3, maxLeverage: 20 },
      { name: "xyz:OLD", szDecimals: 2, maxLeverage: 10, isDelisted: true },
    ],
  };

  it("numbers a builder dex's assets from 110000, 10000 apart in the dex list", () => {
    expect(perpMarket(dexes, "xyz", xyz, "xyz:TSLA")).toEqual({ coin: "xyz:TSLA", asset: 110_001, szDecimals: 3, maxLeverage: 20 });
    expect(perpMarket(dexes, "flx", { universe: [{ name: "flx:TSLA", szDecimals: 2, maxLeverage: 10 }] }, "flx:TSLA").asset).toBe(120_000);
    expect(perpMarket(dexes, "", { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] }, "BTC").asset).toBe(0);
  });

  it("refuses a dex, market or delisted market it can't trade", () => {
    expect(() => perpMarket(dexes, "abc", xyz, "xyz:TSLA")).toThrow(/no perp dex/);
    expect(() => perpMarket(dexes, "xyz", xyz, "xyz:NVDA")).toThrow(/no market/);
    expect(() => perpMarket(dexes, "xyz", xyz, "xyz:OLD")).toThrow(/delisted/);
  });
});

describe("hedgeOrder", () => {
  const market = { coin: "xyz:TSLA", asset: 110_001, szDecimals: 3, maxLeverage: 20 };
  const rules = { step: 0.001, ...DEFAULT_BAND, maxNotional: 10_000 };

  it("sells to grow the short, no lower than 0.2% under the mid", () => {
    expect(hedgeOrder(rebalance(1.16, 0, 371.76, rules), 371.76, market)).toEqual({ a: 110_001, b: false, p: "371.02", s: "1.16", r: false, t: { limit: { tif: "Ioc" } } });
  });

  it("buys back reduce-only, no higher than 0.2% over the mid", () => {
    expect(hedgeOrder(rebalance(0.5, 1.16, 371.76, rules), 371.76, market)).toEqual({ a: 110_001, b: true, p: "372.5", s: "0.66", r: true, t: { limit: { tif: "Ioc" } } });
  });

  it("sends nothing when the rebalance holds", () => {
    expect(hedgeOrder(rebalance(1.16, 1.16, 371.76, rules), 371.76, market)).toBeNull();
  });
});
