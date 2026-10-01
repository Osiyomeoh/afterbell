/**
 * Turning a Solana quote into the transaction its buyer signs. Runs in a
 * browser as well as in Node: no Buffer.
 */
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";

import type { SolanaQuote } from "../pricing/solanaQuote";
import { buyInstructions, getProgram } from "../solana/client/vault";

import type { SolanaQuoteResponse } from "./types";

type QuotePart = Pick<SolanaQuoteResponse["solana"], "vault" | "collateralMint" | "quote" | "ed25519Data">;

const hexBytes = (hex: string) => {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error(`not hex: ${hex}`);
  return Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
};
const base64Bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** The signed quote in the program's types. */
export function toSolanaQuote(q: SolanaQuoteResponse["solana"]["quote"]): SolanaQuote {
  return {
    feedId: hexBytes(q.feedId),
    openTs: BigInt(q.openTs),
    shares: BigInt(q.shares),
    upper: BigInt(q.upper),
    lower: BigInt(q.lower),
    premium: BigInt(q.premium),
    expiry: BigInt(q.expiry),
    nonce: hexBytes(q.nonce),
  };
}

/** A purchase to sign and send, with the blockhash it was built on, to confirm against. */
export type SolanaPurchase = { transaction: Transaction; blockhash: string; lastValidBlockHeight: number };

/**
 * The purchase for `buyer` to sign and send: the Ed25519 program checking
 * the quoter's signature, then `buy`, which takes the premium in TestUSD and
 * mints the position's NFT to the buyer.
 */
export async function solanaPurchase(connection: Connection, buyer: PublicKey, q: QuotePart): Promise<SolanaPurchase> {
  const unsigned = { publicKey: buyer, signTransaction: () => Promise.reject(new Error("unsigned")), signAllTransactions: () => Promise.reject(new Error("unsigned")) };
  const mint = new PublicKey(q.collateralMint);
  const ixs = await buyInstructions(getProgram(connection, unsigned), {
    buyer,
    vault: new PublicKey(q.vault),
    collateralMint: mint,
    buyerToken: getAssociatedTokenAddressSync(mint, buyer),
    quote: toSolanaQuote(q.quote),
    ed25519Data: base64Bytes(q.ed25519Data),
  });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  return { transaction: new Transaction({ feePayer: buyer, blockhash, lastValidBlockHeight }).add(...ixs), blockhash, lastValidBlockHeight };
}
