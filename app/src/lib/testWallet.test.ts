import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { loadOrCreateKeypair, TestWalletAdapter, TestWalletName } from "./testWallet";

/** A Storage stand-in: what the browser's localStorage holds for this site. */
function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
}

describe("the test wallet", () => {
  it("keeps one wallet per browser: created once, then the same one every time", () => {
    const store = memoryStore();
    const first = loadOrCreateKeypair(store);
    expect(loadOrCreateKeypair(store).publicKey.equals(first.publicKey)).toBe(true);
    // An unreadable entry starts a new wallet rather than fail.
    const broken = memoryStore({ "afterbell:test-wallet": "not json" });
    expect(loadOrCreateKeypair(broken).publicKey).toBeInstanceOf(PublicKey);
  });

  it("connects to the stored wallet, signs as it, and refuses to sign once disconnected", async () => {
    const store = memoryStore();
    const adapter = new TestWalletAdapter(() => store);
    expect(adapter.name).toBe(TestWalletName);
    const connected: PublicKey[] = [];
    adapter.on("connect", (pk) => connected.push(pk));
    await adapter.connect();
    const me = adapter.publicKey!;
    expect(connected.map(String)).toEqual([me.toBase58()]);

    const tx = new Transaction({ feePayer: me, blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", lastValidBlockHeight: 1 }).add(
      SystemProgram.transfer({ fromPubkey: me, toPubkey: Keypair.generate().publicKey, lamports: 1 }),
    );
    const signed = await adapter.signTransaction(tx);
    // Every signature the transaction needs (the fee payer's, the wallet's) is present and valid.
    expect(signed.verifySignatures()).toBe(true);

    await adapter.disconnect();
    expect(adapter.publicKey).toBeNull();
    await expect(adapter.signTransaction(tx)).rejects.toThrow();
    // Connecting again brings back the same wallet.
    await adapter.connect();
    expect(adapter.publicKey?.equals(me)).toBe(true);
  });
});
