import { Connection } from "@solana/web3.js";

import { openSeries, readVault, type OpenSeries } from "@root/hedger/solana";

import { rpcFor } from "./chain";
import { SOLANA_V1_DEPLOYMENT } from "./deployment";

/** Solana's first vault, which sells nothing new: each series it still has open, or why it couldn't be read. */
export type FirstVault = { vault: string; open: OpenSeries[] } | { vault: string; error: string };

const TTL_MS = 10_000;
let cache: { at: number; state: Promise<FirstVault> } | null = null;

/**
 * Read as the hedge reads it (hedger/solana.ts), so the Vault page and the
 * hedge panel count the same positions. Null when the app keeps no record of
 * the first vault.
 */
export function firstVault(): Promise<FirstVault> | null {
  const d = SOLANA_V1_DEPLOYMENT;
  if (!d) return null;
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const state = readVault(new Connection(rpcFor(d), "confirmed"), "v1", d).then(
      ({ series, positions }): FirstVault => ({ vault: d.vault, open: openSeries(series, positions) }),
      (e: Error): FirstVault => ({ vault: d.vault, error: e.message }),
    );
    cache = { at: Date.now(), state };
  }
  return cache.state;
}
