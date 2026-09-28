import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";

import { solanaPurchase, toSolanaQuote } from "@root/sdk/solana";
import { getProgram, positionAddress } from "@root/solana/client/vault";

import type { QuoteResponse } from "./api";

export class NotEnoughTestUsd extends Error {}

/**
 * Buys the quoted protection: the Ed25519 check of the quoter's signature,
 * then `buy`, in one transaction the wallet signs. The position arrives in
 * the wallet as an NFT. Returns the signature, the position's address and
 * its number (the NFT's name).
 */
export async function buyProtection(
  connection: Connection,
  wallet: AnchorWallet,
  sendTransaction: (tx: Transaction, connection: Connection) => Promise<string>,
  q: QuoteResponse["solana"],
): Promise<{ signature: string; position: string; number: number }> {
  const quote = toSolanaQuote(q.quote);
  const mint = new PublicKey(q.collateralMint);
  const buyerToken = getAssociatedTokenAddressSync(mint, wallet.publicKey);
  const balance = await getAccount(connection, buyerToken).then((a) => a.amount, () => 0n);
  if (balance < quote.premium) throw new NotEnoughTestUsd("You need TestUSD to pay the premium.");

  const { transaction, blockhash, lastValidBlockHeight } = await solanaPurchase(connection, wallet.publicKey, q);
  const signature = await sendTransaction(transaction, connection);
  const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (result.value.err) throw new Error(`the purchase failed on-chain: ${JSON.stringify(result.value.err)}`);
  const position = positionAddress(new PublicKey(q.vault), quote.nonce);
  const { number } = await getProgram(connection, wallet).account.position.fetch(position, "confirmed");
  return { signature, position: position.toBase58(), number: number.toNumber() };
}
