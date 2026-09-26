import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";

import type { SolanaQuote } from "@root/pricing/solanaQuote";
import { buyInstructions, getProgram, positionAddress } from "@root/solana/client/v1";

import type { QuoteResponse } from "./api";

const hexBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));

/** The signed quote in the program's types. */
export function toSolanaQuote(q: QuoteResponse["solana"]["quote"]): SolanaQuote {
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

export class NotEnoughTestUsd extends Error {}

/**
 * Buys the quoted protection: the Ed25519 check of the quoter's signature,
 * then `buy`, in one transaction the wallet signs. Returns the signature and
 * the new position's address.
 */
export async function buyProtection(
  connection: Connection,
  wallet: AnchorWallet,
  sendTransaction: (tx: Transaction, connection: Connection) => Promise<string>,
  q: QuoteResponse["solana"],
): Promise<{ signature: string; position: string }> {
  const quote = toSolanaQuote(q.quote);
  const mint = new PublicKey(q.collateralMint);
  const buyerToken = getAssociatedTokenAddressSync(mint, wallet.publicKey);
  const balance = await getAccount(connection, buyerToken).then((a) => a.amount, () => 0n);
  if (balance < quote.premium) throw new NotEnoughTestUsd("You need TestUSD to pay the premium.");

  const program = getProgram(connection, wallet);
  const ixs = await buyInstructions(program, {
    buyer: wallet.publicKey,
    vault: new PublicKey(q.vault),
    collateralMint: mint,
    buyerToken,
    quote,
    ed25519Data: Uint8Array.from(atob(q.ed25519Data), (c) => c.charCodeAt(0)),
  });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  const signature = await sendTransaction(tx, connection);
  const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (result.value.err) throw new Error(`the purchase failed on-chain: ${JSON.stringify(result.value.err)}`);
  return { signature, position: positionAddress(new PublicKey(q.vault), quote.nonce).toBase58() };
}
