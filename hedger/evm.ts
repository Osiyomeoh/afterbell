/**
 * The positions the Robinhood Chain vault has sold and not yet paid out,
 * read from the chain. Reads only.
 */
import type { Address, PublicClient } from "viem";

import { afterbellVaultAbi } from "../evm/client/abi";
import type { EvmDeployment, EvmPosition } from "../evm/client/vault";
import type { VaultSource } from "./state";
import type { OpenPosition } from "./target";

/** A position as stored: shares with 6 decimals, strikes with 8 (Chainlink's). */
export type EvmPositionRecord = Pick<EvmPosition, "feed" | "openTs" | "shares" | "upper" | "lower" | "closed">;

const SHARE = 1e6;
const PRICE = 1e8;

/**
 * The positions not yet paid out, each named by the stock the deployment
 * lists for its feed (the feed's address when it lists none, so nothing
 * unknown is hedged as something else). A series can't be settled or voided
 * before its open, and the hedge counts nothing after it, so the series
 * needn't be read.
 */
export function openEvmPositions(positions: readonly EvmPositionRecord[], feeds: EvmDeployment["feeds"]): OpenPosition[] {
  const symbolOf = new Map(Object.entries(feeds).flatMap(([symbol, feed]) => (feed ? [[feed.toLowerCase(), symbol] as const] : [])));
  return positions
    .filter((p) => !p.closed)
    .map((p) => ({
      symbol: symbolOf.get(p.feed.toLowerCase()) ?? p.feed,
      openTs: Number(p.openTs),
      shares: Number(p.shares) / SHARE,
      upper: Number(p.upper) / PRICE,
      lower: Number(p.lower) / PRICE,
    }));
}

/** Every position the vault at `vault` has sold, as the keeper reads them. */
export async function readEvmVault(client: PublicClient, vault: Address): Promise<EvmPositionRecord[]> {
  const contract = { address: vault, abi: afterbellVaultAbi } as const;
  const next = await client.readContract({ ...contract, functionName: "nextPositionId" });
  return Promise.all(
    Array.from({ length: Number(next) }, (_, i) => client.readContract({ ...contract, functionName: "position", args: [BigInt(i)] }) as Promise<EvmPosition>),
  );
}

/** The Robinhood Chain vault as a source for the hedge. */
export function evmVault(label: string, client: PublicClient, deployment: Pick<EvmDeployment, "vault" | "feeds">): VaultSource {
  return {
    chain: "robinhood",
    label,
    vault: deployment.vault,
    read: async () => openEvmPositions(await readEvmVault(client, deployment.vault), deployment.feeds),
  };
}
