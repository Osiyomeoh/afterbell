import { Connection, Ed25519Program, Keypair } from "@solana/web3.js";
import type { PublicClient } from "viem";
import { describe, expect, it } from "vitest";

import { PROGRAM_ID, TSLA_FEED_ID } from "../solana/client/vault";

import { robinhoodPurchase, toEvmQuote } from "./robinhood";
import type { EvmQuoteResponse } from "./types";
import { solanaPurchase, toSolanaQuote } from "./solana";

const quote = {
  feedId: TSLA_FEED_ID.slice(2),
  openTs: "1790688600",
  shares: "1000000",
  upper: "35420000000",
  lower: "32529000000",
  premium: "3275213",
  expiry: "1790604600",
  nonce: "ab".repeat(32),
};

describe("turning a quote into a purchase", () => {
  it("decodes a Solana quote's hex and numbers without Buffer, and refuses what isn't hex", () => {
    const q = toSolanaQuote(quote);
    expect(q.feedId[0]).toBe(0x16);
    expect(q.nonce).toEqual(new Uint8Array(32).fill(0xab));
    expect([q.openTs, q.upper, q.premium]).toEqual([1_790_688_600n, 35_420_000_000n, 3_275_213n]);
    expect(() => toSolanaQuote({ ...quote, nonce: "zz" })).toThrow("not hex");
  });

  it("builds the Solana purchase: the Ed25519 check of the quote, then the vault's buy, paid by the buyer", async () => {
    const buyer = Keypair.generate().publicKey;
    const connection = { getLatestBlockhash: async () => ({ blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", lastValidBlockHeight: 42 }) } as unknown as Connection;
    const ed25519 = Uint8Array.from({ length: 16 }, (_, i) => i);
    const p = await solanaPurchase(connection, buyer, {
      vault: "E5JGqm7LdPMTtA661B3XZiT7kbBcgm9E9BtJmasLGvoX",
      collateralMint: "FDsn8wf4XTYf26vfLp1TNVnaJn2NGFV8tfzten1YajVi",
      quote,
      ed25519Data: btoa(String.fromCharCode(...ed25519)),
    });
    expect(p.lastValidBlockHeight).toBe(42);
    expect(p.transaction.feePayer?.equals(buyer)).toBe(true);
    const [check, buy] = p.transaction.instructions;
    expect(check?.programId.equals(Ed25519Program.programId)).toBe(true);
    expect(Uint8Array.from(check!.data)).toEqual(ed25519);
    expect(buy?.programId.equals(PROGRAM_ID)).toBe(true);
    expect(buy?.keys.some((k) => k.pubkey.equals(buyer) && k.isSigner)).toBe(true);
  });

  it("decodes a Robinhood Chain quote into the contract's types", () => {
    const q = toEvmQuote({ ...quote, buyer: "0x63e37160334FBEa25F1C5DF6f3A69aF1906eFcd1", feed: "0x4A1166a659A55625345e9515b32adECea5547C38", nonce: "12345" });
    expect(q).toMatchObject({ buyer: "0x63e37160334FBEa25F1C5DF6f3A69aF1906eFcd1", openTs: 1_790_688_600n, lower: 32_529_000_000n, nonce: 12_345n });
  });

  it("won't buy a Robinhood Chain quote from a wallet other than the one it was signed for", () => {
    const wallet = { account: { address: "0x0000000000000000000000000000000000000001" } } as unknown as Parameters<typeof robinhoodPurchase>[0];
    const r = { evm: { quote: { ...quote, buyer: "0x63e37160334FBEa25F1C5DF6f3A69aF1906eFcd1" } } } as unknown as EvmQuoteResponse;
    expect(() => robinhoodPurchase(wallet, {} as PublicClient, r)).toThrow("the quote was signed for another buyer");
  });
});
