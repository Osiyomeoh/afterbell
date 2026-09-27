import { Connection } from "@solana/web3.js";
import { getAddress } from "viem";

import type { Network } from "@root/hedger/hyperliquid";
import { readHedgeState, summarize, type HedgeSummary, type VaultSource } from "@root/hedger/state";
import { TSLA } from "@root/quoter/stocks";

import { RPC } from "./chain";
import { SOLANA_DEPLOYMENT, SOLANA_V1_DEPLOYMENT } from "./deployment";
import { marketSnapshot } from "./market";

/**
 * The hedge's settings, all public: where it trades, its account's address
 * (HEDGE_ACCOUNT, no key: the server only reads) and the most its short may
 * be worth. The hedger script reads the same variables.
 */
function settings(): { network: Network; address: `0x${string}` | null; maxNotional: number } {
  const network = process.env.HYPERLIQUID_NETWORK || "testnet";
  if (network !== "testnet" && network !== "mainnet") throw new Error(`HYPERLIQUID_NETWORK is testnet or mainnet, not "${network}"`);
  const maxNotional = Number(process.env.HEDGE_MAX_NOTIONAL || 1500);
  if (!(maxNotional > 0)) throw new Error("HEDGE_MAX_NOTIONAL must be a positive number of dollars");
  return { network, address: process.env.HEDGE_ACCOUNT ? getAddress(process.env.HEDGE_ACCOUNT) : null, maxNotional };
}

/** Solana's vaults: v2, and v1 while its record is kept (its last series is paid on Monday 28 Sep). */
function vaults(): VaultSource[] {
  const out: VaultSource[] = [];
  if (SOLANA_DEPLOYMENT) out.push({ label: "the current vault", version: "v2", connection: new Connection(RPC, "confirmed"), deployment: SOLANA_DEPLOYMENT });
  if (SOLANA_V1_DEPLOYMENT) out.push({ label: "the first version", version: "v1", connection: new Connection(SOLANA_V1_DEPLOYMENT.rpc, "confirmed"), deployment: SOLANA_V1_DEPLOYMENT });
  return out;
}

const TTL_MS = 15_000;
let cached: { at: number; summary: Promise<HedgeSummary> } | null = null;

/** The hedge as the Vault page shows it, sized with the model the quotes are priced from; refreshed at most every 15 seconds. */
export function hedgeSummary(): Promise<HedgeSummary> {
  if (!cached || Date.now() - cached.at > TTL_MS) {
    const s = settings();
    const summary = readHedgeState({ stock: TSLA, vaults: vaults(), network: s.network, address: s.address, maxNotional: s.maxNotional, model: () => marketSnapshot(TSLA).then((m) => m.market) }).then((st) =>
      summarize(st, TSLA, s.network, s.maxNotional),
    );
    cached = { at: Date.now(), summary };
    summary.catch(() => {
      if (cached?.summary === summary) cached = null;
    });
  }
  return cached.summary;
}
