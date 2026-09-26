import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import devnet from "@root/solana/deployments/devnet.json";

/** A Solana vault's addresses, as solana/scripts/setup.ts records them. */
export type SolanaDeployment = {
  rpc: string;
  programId: string;
  authority: string;
  quoter: string;
  collateralMint: string;
  vault: string;
  vaultToken: string;
  feeds: Record<string, { feedId: string; feedConfig: string }>;
};

/** Vault v2's record adds its pool's share mint and escrow, and where its NFTs' art is served. */
export type SolanaV2Deployment = SolanaDeployment & { shareMint: string; shareEscrow: string; artUri: string };

const read = (file: string): SolanaDeployment | null =>
  existsSync(/* turbopackIgnore: true */ file) ? (JSON.parse(readFileSync(/* turbopackIgnore: true */ file, "utf8")) as SolanaDeployment) : null;

const isV2 = (d: SolanaDeployment | null): d is SolanaV2Deployment => !!d && "shareMint" in d;

const current = (process.env.SOLANA_DEPLOYMENT_FILE && read(process.env.SOLANA_DEPLOYMENT_FILE)) || (devnet as SolanaDeployment);

/**
 * The Solana vault v2 the app sells from: solana/deployments/devnet.json, or
 * SOLANA_DEPLOYMENT_FILE (a local validator's, say). Null while devnet.json
 * is still vault v1's: v2's accounts differ, so the app neither reads nor
 * sells from v1, and says Solana's vault isn't live yet.
 */
export const SOLANA_DEPLOYMENT: SolanaV2Deployment | null = isV2(current) ? current : null;

/**
 * Vault v1, kept for its record of what it sold and paid:
 * solana/deployments/devnet-v1.json, where its record moves when v2 takes
 * devnet.json. next.config traces solana/deployments into the record route.
 */
export const SOLANA_V1_DEPLOYMENT: SolanaDeployment | null = read(join(process.cwd(), "..", "solana", "deployments", "devnet-v1.json"));
