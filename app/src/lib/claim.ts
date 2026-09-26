import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";

import { getProgram, processInstruction } from "@root/solana/client/vault";

/**
 * Pays out a finished position whose NFT this wallet holds, into its own
 * TestUSD account (created if missing): `process` for this one position, with
 * the wallet as the keeper, so it takes the keeper's tip as well. Anyone may
 * pay a position out; the payout always goes to the NFT's holder.
 */
export async function claimPosition(
  connection: Connection,
  wallet: AnchorWallet,
  sendTransaction: (tx: Transaction, connection: Connection) => Promise<string>,
  args: { vault: string; collateralMint: string; series: string; position: string; nftAccount: string },
): Promise<string> {
  const mint = new PublicKey(args.collateralMint);
  const token = getAssociatedTokenAddressSync(mint, wallet.publicKey);
  const program = getProgram(connection, wallet);
  const pay = await processInstruction(program, {
    keeper: wallet.publicKey,
    vault: new PublicKey(args.vault),
    series: new PublicKey(args.series),
    collateralMint: mint,
    keeperToken: token,
    payees: [{ position: new PublicKey(args.position), nftAccount: new PublicKey(args.nftAccount), payeeToken: token }],
  });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight }).add(
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, token, wallet.publicKey, mint),
    pay,
  );
  const signature = await sendTransaction(tx, connection);
  const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (result.value.err) throw new Error(`the claim failed on-chain: ${JSON.stringify(result.value.err)}`);
  return signature;
}
