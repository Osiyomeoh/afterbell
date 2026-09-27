"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import type { Connection, Transaction } from "@solana/web3.js";
import { useCallback } from "react";

/**
 * Sends a transaction the wallet signs through the app's own connection
 * (devnet), rather than asking the wallet to send it. A wallet that sends
 * submits to the network it's set to: Phantom on mainnet sends a devnet
 * transaction to mainnet and reports only "Unexpected error". Sent from
 * here, it reaches devnet whatever the wallet is set to, and a transaction
 * the program refuses comes back with the program's reason.
 */
export function useSendTransaction(): (tx: Transaction, connection: Connection) => Promise<string> {
  const { signTransaction } = useWallet();
  return useCallback(
    async (tx: Transaction, connection: Connection) => {
      if (!signTransaction) throw new Error("This wallet can't sign transactions for the app.");
      const signed = await signTransaction(tx);
      return connection.sendRawTransaction(signed.serialize(), { preflightCommitment: "confirmed" });
    },
    [signTransaction],
  );
}
