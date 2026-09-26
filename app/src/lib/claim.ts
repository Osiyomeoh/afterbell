import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";

import { claimInstruction, getProgram } from "@root/solana/client/v1";

/** Claims a finished position into the buyer's own TestUSD account (created if missing). Anyone may; here the buyer does. */
export async function claimPosition(
  connection: Connection,
  wallet: AnchorWallet,
  sendTransaction: (tx: Transaction, connection: Connection) => Promise<string>,
  args: { vault: string; collateralMint: string; series: string; position: string },
): Promise<string> {
  const mint = new PublicKey(args.collateralMint);
  const buyerToken = getAssociatedTokenAddressSync(mint, wallet.publicKey);
  const program = getProgram(connection, wallet);
  const claim = await claimInstruction(program, {
    vault: new PublicKey(args.vault),
    series: new PublicKey(args.series),
    position: new PublicKey(args.position),
    buyer: wallet.publicKey,
    collateralMint: mint,
    buyerToken,
  });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight }).add(
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, buyerToken, wallet.publicKey, mint),
    claim,
  );
  const signature = await sendTransaction(tx, connection);
  const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (result.value.err) throw new Error(`the claim failed on-chain: ${JSON.stringify(result.value.err)}`);
  return signature;
}
