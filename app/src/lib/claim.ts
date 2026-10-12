import type { AnchorWallet } from "@solana/wallet-adapter-react";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
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
  args: {
    vault: string;
    collateralMint: string;
    series: string;
    position: string;
    nftAccount: string;
  },
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
    payees: [
      {
        position: new PublicKey(args.position),
        nftAccount: new PublicKey(args.nftAccount),
        payeeToken: token,
      },
    ],
  });
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: wallet.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      token,
      wallet.publicKey,
      mint,
    ),
    pay,
  );
  const signature = await sendTransaction(tx, connection);
  const result = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  if (result.value.err)
    throw new Error(
      `the claim failed on-chain: ${JSON.stringify(result.value.err)}`,
    );
  return signature;
}

/** Mainnet USDC: a vault paying in it can repay Kamino loans with its payouts. */
export const KAMINO_REPAYABLE_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * Pays out a finished position and repays this wallet's USDC loan on Kamino's xStocks market with it, in
 * one transaction: if either fails, neither happens. Repays the payout, or the whole debt if that's less;
 * anything left over stays in the wallet. Only for a vault paying mainnet USDC.
 */
export async function claimAndRepayKamino(
  connection: Connection,
  wallet: AnchorWallet,
  sendTransaction: (tx: Transaction, connection: Connection) => Promise<string>,
  args: {
    vault: string;
    collateralMint: string;
    series: string;
    position: string;
    nftAccount: string;
    payoutUnits: bigint;
  },
): Promise<string> {
  if (args.collateralMint !== KAMINO_REPAYABLE_MINT)
    throw new Error(
      "this vault doesn't pay in USDC, so it can't repay a Kamino loan",
    );
  // Kamino's SDK is large; load it only when someone repays.
  const {
    claimAndRepayInstructions,
    loadKaminoMarket,
    usdcDebt,
    USDC_RESERVE,
    XSTOCKS_MARKET,
  } = await import("@root/solana/client/kamino");
  const market = await loadKaminoMarket(connection, XSTOCKS_MARKET);
  const debt = await usdcDebt(market, wallet.publicKey);
  if (debt === 0n)
    throw new Error(
      "this wallet has no USDC loan on Kamino's xStocks market to repay",
    );
  const repay = args.payoutUnits < debt ? args.payoutUnits : debt;

  const mint = new PublicKey(args.collateralMint);
  const token = getAssociatedTokenAddressSync(mint, wallet.publicKey);
  const ixs = await claimAndRepayInstructions(
    connection,
    market,
    [
      getProgram(connection, wallet),
      {
        keeper: wallet.publicKey,
        vault: new PublicKey(args.vault),
        series: new PublicKey(args.series),
        collateralMint: mint,
        keeperToken: token,
        payees: [
          {
            position: new PublicKey(args.position),
            nftAccount: new PublicKey(args.nftAccount),
            payeeToken: token,
          },
        ],
      },
    ],
    { owner: wallet.publicKey, reserve: USDC_RESERVE, repay },
  );
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: wallet.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(...ixs);
  const signature = await sendTransaction(tx, connection);
  const result = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  if (result.value.err)
    throw new Error(
      `the claim and repay failed on-chain: ${JSON.stringify(result.value.err)}`,
    );
  return signature;
}
