import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";

import {
  claimDepositInstruction,
  claimRedemptionInstruction,
  getProgram,
  requestDepositInstruction,
  requestRedeemInstruction,
} from "@root/solana/client/vault";

/** A connected Solana wallet and the vault it underwrites. */
export type SolanaPoolContext = {
  connection: Connection;
  wallet: AnchorWallet;
  sendTransaction: (tx: Transaction, connection: Connection) => Promise<string>;
  vault: string;
  collateralMint: string;
};

async function send(c: SolanaPoolContext, ixs: TransactionInstruction[], onStep: (step: string) => void): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await c.connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: c.wallet.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  onStep("Confirm in your wallet");
  const signature = await c.sendTransaction(tx, c.connection);
  onStep("Waiting for Solana");
  const result = await c.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (result.value.err) throw new Error(`the transaction failed on-chain: ${JSON.stringify(result.value.err)}`);
  return signature;
}

/** Queues `assets` of TestUSD to join the Solana pool at its next roll. */
export async function depositOnSolana(c: SolanaPoolContext, assets: bigint, onStep: (step: string) => void): Promise<string> {
  const mint = new PublicKey(c.collateralMint);
  const ownerToken = getAssociatedTokenAddressSync(mint, c.wallet.publicKey);
  const balance = await getAccount(c.connection, ownerToken).then((a) => a.amount, () => 0n);
  if (balance < assets) throw new Error("You have less TestUSD than that; get test money on the Protect page.");
  const program = getProgram(c.connection, c.wallet);
  const ix = await requestDepositInstruction(program, { owner: c.wallet.publicKey, vault: new PublicKey(c.vault), collateralMint: mint, ownerToken, assets });
  return send(c, [ix], onStep);
}

/** Queues `shares` to leave the Solana pool at its next roll; they wait in the vault until then. */
export async function withdrawOnSolana(c: SolanaPoolContext, shares: bigint, onStep: (step: string) => void): Promise<string> {
  const program = getProgram(c.connection, c.wallet);
  const ix = await requestRedeemInstruction(program, { owner: c.wallet.publicKey, vault: new PublicKey(c.vault), shares });
  return send(c, [ix], onStep);
}

/** Takes what earlier rolls filled: the shares deposits bought, the TestUSD redemptions are owed, or both, in one transaction. */
export async function claimPoolOnSolana(c: SolanaPoolContext, what: { shares: boolean; assets: boolean }, onStep: (step: string) => void): Promise<string> {
  const program = getProgram(c.connection, c.wallet);
  const owner = c.wallet.publicKey;
  const vault = new PublicKey(c.vault);
  const mint = new PublicKey(c.collateralMint);
  const ixs: TransactionInstruction[] = [];
  if (what.shares) ixs.push(await claimDepositInstruction(program, { owner, vault }));
  if (what.assets) ixs.push(await claimRedemptionInstruction(program, { owner, vault, collateralMint: mint, ownerToken: getAssociatedTokenAddressSync(mint, owner) }));
  if (ixs.length === 0) throw new Error("nothing to claim");
  return send(c, ixs, onStep);
}
