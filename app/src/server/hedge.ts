import { Connection } from "@solana/web3.js";
import { createPublicClient, getAddress, http } from "viem";

import { evmChain } from "@root/evm/client/vault";
import { evmVault } from "@root/hedger/evm";
import type { Network } from "@root/hedger/hyperliquid";
import { solanaVault } from "@root/hedger/solana";
import { readHedgeState, summarize, type HedgeSummary, type VaultSource } from "@root/hedger/state";
import { TSLA } from "@root/quoter/stocks";

import { RPC } from "./chain";
import { SOLANA_DEPLOYMENT, SOLANA_V1_DEPLOYMENT } from "./deployment";
import { evmDeployment } from "./evmDeployment";
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

/** Solana's vaults, v2 and v1 while its record is kept (its last series is paid on Monday 28 Sep), and Robinhood Chain's once it's deployed. */
function vaults(): VaultSource[] {
  const out: VaultSource[] = [];
  if (SOLANA_DEPLOYMENT) out.push(solanaVault("the current vault", "v2", new Connection(RPC, "confirmed"), SOLANA_DEPLOYMENT));
  if (SOLANA_V1_DEPLOYMENT) out.push(solanaVault("the first version", "v1", new Connection(SOLANA_V1_DEPLOYMENT.rpc, "confirmed"), SOLANA_V1_DEPLOYMENT));
  const evm = evmDeployment();
  if (evm) out.push(evmVault("the vault", createPublicClient({ chain: evmChain(evm), transport: http(evm.rpc) }), evm));
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
