import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";

import { solanaPurchase, toSolanaQuote } from "@root/sdk/solana";
import { cancelOrderInstruction, getProgram, orderAddress, positionAddress, setOrderInstruction, type OrderTerms } from "@root/solana/client/vault";

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

type Send = (tx: Transaction, connection: Connection) => Promise<string>;

async function sendOne(connection: Connection, sendTransaction: Send, tx: Transaction): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  const signature = await sendTransaction(tx, connection);
  const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (result.value.err) throw new Error(`the transaction failed on-chain: ${JSON.stringify(result.value.err)}`);
  return signature;
}

/**
 * Sets the wallet's standing order on the quoted stock: the vault's keeper buys
 * the same protection each night within `terms`, paid from the allowance the
 * order is approved for over the wallet's TestUSD.
 */
export async function protectEveryNightOnSolana(
  connection: Connection,
  wallet: AnchorWallet,
  sendTransaction: Send,
  q: QuoteResponse["solana"],
  terms: OrderTerms,
): Promise<string> {
  const collateralMint = new PublicKey(q.collateralMint);
  const ix = await setOrderInstruction(getProgram(connection, wallet), {
    holder: wallet.publicKey,
    vault: new PublicKey(q.vault),
    feedId: toSolanaQuote(q.quote).feedId,
    collateralMint,
    holderToken: getAssociatedTokenAddressSync(collateralMint, wallet.publicKey),
    terms,
  });
  return sendOne(connection, sendTransaction, new Transaction({ feePayer: wallet.publicKey }).add(ix));
}

/** Stops a standing order and revokes its allowance. */
export async function stopEveryNightOnSolana(
  connection: Connection,
  wallet: AnchorWallet,
  sendTransaction: Send,
  v: { vault: string; collateralMint: string },
  feedId: Uint8Array,
): Promise<string> {
  const ix = await cancelOrderInstruction(getProgram(connection, wallet), {
    holder: wallet.publicKey,
    order: orderAddress(new PublicKey(v.vault), wallet.publicKey, feedId),
    holderToken: getAssociatedTokenAddressSync(new PublicKey(v.collateralMint), wallet.publicKey),
  });
  return sendOne(connection, sendTransaction, new Transaction({ feePayer: wallet.publicKey }).add(ix));
}

export type SolanaStandingOrder = { feedId: Uint8Array; symbol: string; maxShares: number; startBps: number; depthBps: number; maxPremium: number; until: number };

/** The wallet's live standing orders on the vault, named by the vault's feed configs. */
export async function solanaStandingOrders(connection: Connection, wallet: AnchorWallet, vault: string): Promise<SolanaStandingOrder[]> {
  const program = getProgram(connection, wallet);
  const byVault = { memcmp: { offset: 8, bytes: vault } };
  const [orders, configs] = await Promise.all([
    program.account.order.all([byVault, { memcmp: { offset: 40, bytes: wallet.publicKey.toBase58() } }]),
    program.account.feedConfig.all([byVault]),
  ]);
  const hex = (b: number[]) => Buffer.from(b).toString("hex");
  const symbols = new Map(configs.map((c) => [hex(c.account.feedId), c.account.symbol]));
  const now = Date.now() / 1000;
  return orders
    .map(({ account: o }) => ({
      feedId: Uint8Array.from(o.feedId),
      symbol: symbols.get(hex(o.feedId)) ?? hex(o.feedId).slice(0, 10),
      maxShares: o.maxShares.toNumber() / 1e6,
      startBps: o.startBps,
      depthBps: o.depthBps,
      maxPremium: o.maxPremium.toNumber() / 1e6,
      until: o.until.toNumber(),
      active: o.active,
    }))
    .filter((o) => o.active && o.until > now);
}
