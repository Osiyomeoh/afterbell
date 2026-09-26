import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import { ed25519InstructionData, QUOTE_MESSAGE_LEN, quoterPublicKey, signSolanaQuote, solanaQuoteMessage, type SolanaQuote } from "./solanaQuote";

const key = (b: number) => bs58.encode(new Uint8Array(32).fill(b));
const QUOTE: SolanaQuote = {
  feedId: new Uint8Array(32).fill(7),
  openTs: 1_790_343_000n,
  shares: 10_000_000n,
  upper: 36_000_000_000n,
  lower: 34_000_000_000n,
  premium: 20_000_000n,
  expiry: 1_790_300_000n,
  nonce: new Uint8Array(32).fill(9),
};
// The same bytes solana/programs/afterbell-vault/src/quote.rs pins for the program.
const VECTOR_MESSAGE =
  "616674657262656c6c3a71756f74653a763101010101010101010101010101010101010101010101010101010101010101010202020202020202020202020202020202020202020202020202020202020202030303030303030303030303030303030303030303030303030303030303030307070707070707070707070707070707070707070707070707070707070707075877b66a0000000080969800000000000068c4610800000000d48eea07000000002d31010000000060cfb56a000000000909090909090909090909090909090909090909090909090909090909090909";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("Solana quotes", () => {
  it("encode exactly the bytes the program rebuilds", () => {
    const m = solanaQuoteMessage(key(1), key(2), key(3), QUOTE);
    expect(m).toHaveLength(QUOTE_MESSAGE_LEN);
    expect(hex(m)).toBe(VECTOR_MESSAGE);
  });

  it("are signed with the quoter's ed25519 key", () => {
    const seed = new Uint8Array(32).fill(5);
    const m = solanaQuoteMessage(key(1), key(2), key(3), QUOTE);
    const sig = signSolanaQuote(m, seed);
    expect(ed25519.verify(sig, m, bs58.decode(quoterPublicKey(seed)))).toBe(true);
    expect(ed25519.verify(sig, solanaQuoteMessage(key(1), key(2), key(4), QUOTE), bs58.decode(quoterPublicKey(seed)))).toBe(false);
  });

  it("build the Ed25519 instruction with everything inside it", () => {
    const seed = new Uint8Array(32).fill(5);
    const m = solanaQuoteMessage(key(1), key(2), key(3), QUOTE);
    const pk = ed25519.getPublicKey(seed);
    const data = ed25519InstructionData(pk, signSolanaQuote(m, seed), m);
    const view = new DataView(data.buffer);
    expect(data[0]).toBe(1);
    // signature, key and message offsets, each pointing at this instruction (0xFFFF)
    expect([2, 4, 6, 8, 10, 12, 14].map((at) => view.getUint16(at, true))).toEqual([48, 0xffff, 16, 0xffff, 112, m.length, 0xffff]);
    expect(hex(data.slice(16, 48))).toBe(hex(pk));
    expect(hex(data.slice(112))).toBe(VECTOR_MESSAGE);
  });

  it("reject malformed keys, feed ids and nonces", () => {
    expect(() => solanaQuoteMessage("abc", key(2), key(3), QUOTE)).toThrow("32-byte public key");
    expect(() => solanaQuoteMessage(key(1), key(2), key(3), { ...QUOTE, nonce: new Uint8Array(31) })).toThrow("32 bytes");
  });
});
