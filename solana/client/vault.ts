/**
 * TypeScript client for the Solana vault (solana/programs/afterbell-vault):
 * its addresses and a typed Anchor program. `idl/` is copied from
 * solana/target after `anchor build` (npm run solana:idl).
 */
import anchor from "@anchor-lang/core";
import type { AnchorProvider, Program } from "@anchor-lang/core";
import { Connection, PublicKey } from "@solana/web3.js";

import idl from "./idl/afterbell_vault.json" with { type: "json" };
import type { AfterbellVault } from "./idl/afterbell_vault";

export const PROGRAM_ID = new PublicKey(idl.address);

/** Pyth's Equity.US.TSLA feed, the one our Pyth access is entitled to. */
export const TSLA_FEED_ID = "0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1";

export type VaultConfig = {
  quoter: PublicKey;
  /** How long after the open the first print may land (1..=3600 s). */
  settleWindowSecs: number;
  /** When an unsettled series voids and refunds (3600 s..=7 d, above the settle window). */
  voidDelaySecs: number;
  /** Widest Pyth confidence interval accepted, in bps of the price (1..=1000). */
  maxConfBps: number;
};

/** The values the LiteSVM tests run with. */
export const DEFAULT_CONFIG: Omit<VaultConfig, "quoter"> = {
  settleWindowSecs: 60,
  voidDelaySecs: 86_400,
  maxConfBps: 100,
};

const seed = (s: string) => new TextEncoder().encode(s);

export function feedIdBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error(`not a 32-byte feed id: ${hex}`);
  return Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
}

const pda = (seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

export const vaultAddress = (authority: PublicKey, collateralMint: PublicKey) =>
  pda([seed("vault"), authority.toBytes(), collateralMint.toBytes()]);
export const vaultTokenAddress = (vault: PublicKey) => pda([seed("vault_token"), vault.toBytes()]);
export const feedConfigAddress = (vault: PublicKey, feedId: Uint8Array) => pda([seed("feed"), vault.toBytes(), feedId]);
export function seriesAddress(vault: PublicKey, feedId: Uint8Array, openTs: bigint): PublicKey {
  const ts = new Uint8Array(8);
  new DataView(ts.buffer).setBigInt64(0, openTs, true);
  return pda([seed("series"), vault.toBytes(), feedId, ts]);
}
export const positionAddress = (vault: PublicKey, nonce: Uint8Array) => pda([seed("position"), vault.toBytes(), nonce]);

export function getProgram(connection: Connection, wallet: AnchorProvider["wallet"]): Program<AfterbellVault> {
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  return new anchor.Program<AfterbellVault>(idl as AfterbellVault, provider);
}
