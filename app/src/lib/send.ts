"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import type { Connection, Transaction, TransactionError } from "@solana/web3.js";
import { useCallback } from "react";

/**
 * Sends a transaction the wallet signs through the app's own connection
 * (devnet), rather than asking the wallet to send it. A wallet that sends
 * submits to the network it's set to: Phantom on mainnet sends a devnet
 * transaction to mainnet and reports only "Unexpected error". Sent from
 * here, it reaches devnet whatever the wallet is set to.
 *
 * It's simulated on devnet first, so a transaction that would fail says why
 * (the program's own message, or a missing balance) before the wallet is
 * asked to sign anything.
 */
export function useSendTransaction(): (tx: Transaction, connection: Connection) => Promise<string> {
  const { signTransaction } = useWallet();
  return useCallback(
    async (tx: Transaction, connection: Connection) => {
      if (!signTransaction) throw new Error("This wallet can't sign transactions for the app.");
      const sim = await connection.simulateTransaction(tx);
      if (sim.value.err) throw new Error(explain(sim.value.err, sim.value.logs ?? []));
      const signed = await signTransaction(tx);
      return connection.sendRawTransaction(signed.serialize(), { preflightCommitment: "confirmed" });
    },
    [signTransaction],
  );
}

/** Why devnet would refuse a transaction, in the words most useful to the person buying. */
export function explain(err: TransactionError, logs: readonly string[]): string {
  const text = JSON.stringify(err);
  const anchor = logs.map((l) => /Error Message: (.*)$/.exec(l)?.[1]).find(Boolean);
  if (anchor) return `Devnet would refuse this: ${anchor}`;
  if (/AccountNotFound|InsufficientFundsForFee|InsufficientFundsForRent|insufficient lamports/i.test(text + logs.join(" "))) {
    return "Your wallet needs a little devnet SOL to pay the fee and the rent for your position's NFT. Use “Get test money”, or a devnet SOL faucet.";
  }
  return `Devnet would refuse this transaction (${text}).`;
}
