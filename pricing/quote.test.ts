import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { hashEvmQuote, maxPayoutUnits, QUOTE_TYPES, signEvmQuote, toEvmQuote, type EvmQuote, type VaultDomain } from "./quote";

// The vector evm/test/QuoteVector.t.sol pins on the contract side.
const VECTOR_DOMAIN: VaultDomain = { chainId: 46630, vault: "0xFb94De7E63834a1271b9b7E316d7c13B66F38995" };
const VECTOR: EvmQuote = {
  buyer: "0x1111111111111111111111111111111111111111",
  feed: "0x4A1166a659A55625345e9515b32adECea5547C38",
  openTs: 1_790_343_000n,
  shares: 10_000_000n,
  upper: 36_000_000_000n,
  lower: 34_000_000_000n,
  premium: 20_000_000n,
  expiry: 1_790_300_000n,
  nonce: 42n,
};
const QUOTER_KEY = "0x00000000000000000000000000000000000000000000000000000000000a11ce" as const;

describe("EVM quotes", () => {
  it("hash to the same EIP-712 digest as the contract", () => {
    expect(hashEvmQuote(VECTOR, VECTOR_DOMAIN)).toBe("0x7ea4a414cced87b14b75cfcdd74ae1cf2739d435c02be15497d5a2decb6d3d9a");
  });

  it("are signed by the quoter's key", async () => {
    const signature = await signEvmQuote(VECTOR, VECTOR_DOMAIN, QUOTER_KEY);
    const signer = await recoverTypedDataAddress({
      domain: { name: "Afterbell", version: "1", chainId: VECTOR_DOMAIN.chainId, verifyingContract: VECTOR_DOMAIN.vault },
      types: QUOTE_TYPES,
      primaryType: "Quote",
      message: VECTOR,
      signature,
    });
    expect(signer).toBe(privateKeyToAccount(QUOTER_KEY).address);
  });

  it("convert dollars and shares into the contract's units", () => {
    const q = toEvmQuote({
      buyer: VECTOR.buyer,
      feed: VECTOR.feed,
      openTs: 1_790_343_000,
      protection: { shares: 10, upper: 360, lower: 340 },
      premium: 20,
      expiry: 1_790_300_000,
      nonce: 42n,
    });
    expect(q).toEqual(VECTOR);
    expect(maxPayoutUnits(q)).toBe(200_000_000n);
  });

  it("round shares down and the premium up, never in the buyer's favour", () => {
    const q = toEvmQuote({
      buyer: VECTOR.buyer,
      feed: VECTOR.feed,
      openTs: 2_000_000_000,
      protection: { shares: 1.23456789, upper: 360.123456789, lower: 340 },
      premium: 1.0000001,
      expiry: 1_999_999_000,
      nonce: 1n,
    });
    expect(q.shares).toBe(1_234_567n);
    expect(q.upper).toBe(36_012_345_679n);
    expect(q.premium).toBe(1_000_001n);
  });

  it("don't round a whole unit up on floating-point noise", () => {
    const q = toEvmQuote({ ...VECTOR, openTs: 1_790_343_000, protection: { shares: 10, upper: 360, lower: 340 }, premium: 0.1 + 0.2, expiry: 1_790_300_000 });
    expect(q.premium).toBe(300_000n);
  });

  it("refuse what the contract would refuse", () => {
    const base = { buyer: VECTOR.buyer, feed: VECTOR.feed, openTs: 1_790_343_000, protection: { shares: 10, upper: 360, lower: 340 }, premium: 20, expiry: 1_790_300_000 };
    expect(() => toEvmQuote({ ...base, premium: 200.01 })).toThrow("premium above the maximum payout");
    expect(() => toEvmQuote({ ...base, protection: { shares: 10, upper: 340, lower: 340 } })).toThrow("upper must be above lower");
    expect(() => toEvmQuote({ ...base, protection: { shares: 0.0000001, upper: 360, lower: 340 } })).toThrow("shares must be positive");
    expect(() => toEvmQuote({ ...base, expiry: 1_790_343_000 })).toThrow("expire before the open");
  });

  it("get a fresh 256-bit nonce by default", () => {
    const a = toEvmQuote({ ...VECTOR, openTs: 1_790_343_000, protection: { shares: 10, upper: 360, lower: 340 }, premium: 20, expiry: 1_790_300_000, nonce: undefined });
    const b = toEvmQuote({ ...VECTOR, openTs: 1_790_343_000, protection: { shares: 10, upper: 360, lower: 340 }, premium: 20, expiry: 1_790_300_000, nonce: undefined });
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.nonce < 1n << 256n).toBe(true);
  });
});
