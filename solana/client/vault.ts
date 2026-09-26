/**
 * TypeScript client for the Solana vault (solana/programs/afterbell-vault):
 * its addresses and a typed Anchor program. `idl/` is copied from
 * solana/target after `anchor build` (npm run solana:idl).
 */
import * as anchorModule from "@anchor-lang/core";
import type { AnchorProvider, Program } from "@anchor-lang/core";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Connection,
  Ed25519Program,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";

import type { SolanaQuote } from "../../pricing/solanaQuote";

import idl from "./idl/afterbell_vault.json" with { type: "json" };
import type { AfterbellVault } from "./idl/afterbell_vault";

// Node loads Anchor's CommonJS build, where BN is only on the default export;
// bundlers load its ES build, which has no default export. Take whichever exists.
const anchor = ((anchorModule as { default?: typeof anchorModule }).default ?? anchorModule) as typeof anchorModule;

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

const bn = (v: bigint) => new anchor.BN(v.toString());

/**
 * The two instructions that buy protection, in order: the Ed25519 program
 * verifying the quoter's signature, then `buy`, which checks that verification
 * covered this exact quote.
 */
export async function buyInstructions(
  program: Program<AfterbellVault>,
  args: {
    buyer: PublicKey;
    vault: PublicKey;
    collateralMint: PublicKey;
    buyerToken: PublicKey;
    quote: SolanaQuote;
    /** From the quote service: the Ed25519 instruction's data. */
    ed25519Data: Uint8Array;
  },
): Promise<TransactionInstruction[]> {
  const q = args.quote;
  const verify = new TransactionInstruction({ programId: Ed25519Program.programId, keys: [], data: Buffer.from(args.ed25519Data) });
  const buy = await program.methods
    .buy({
      feedId: Array.from(q.feedId),
      openTs: bn(q.openTs),
      shares: bn(q.shares),
      upper: bn(q.upper),
      lower: bn(q.lower),
      premium: bn(q.premium),
      expiry: bn(q.expiry),
      nonce: Array.from(q.nonce),
    })
    .accountsPartial({
      buyer: args.buyer,
      vault: args.vault,
      feedConfig: feedConfigAddress(args.vault, q.feedId),
      series: seriesAddress(args.vault, q.feedId, q.openTs),
      position: positionAddress(args.vault, q.nonce),
      collateralMint: args.collateralMint,
      buyerToken: args.buyerToken,
      vaultToken: vaultTokenAddress(args.vault),
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return [verify, buy];
}

/** `settle`: anyone may call it with the Pyth update that is the first print at or after the open. */
export function settleInstruction(
  program: Program<AfterbellVault>,
  args: { vault: PublicKey; series: PublicKey; priceUpdate: PublicKey },
): Promise<TransactionInstruction> {
  return program.methods.settle().accountsPartial(args).instruction();
}

/** `void_series`: anyone may call it once the void delay after the open has passed unsettled. */
export function voidSeriesInstruction(program: Program<AfterbellVault>, args: { vault: PublicKey; series: PublicKey }): Promise<TransactionInstruction> {
  return program.methods.voidSeries().accountsPartial(args).instruction();
}

/** `claim`: anyone may call it; the payout (or refund) goes to the buyer's own token account. */
export function claimInstruction(
  program: Program<AfterbellVault>,
  args: { vault: PublicKey; series: PublicKey; position: PublicKey; buyer: PublicKey; collateralMint: PublicKey; buyerToken: PublicKey },
): Promise<TransactionInstruction> {
  return program.methods
    .claim()
    .accountsPartial({ ...args, vaultToken: vaultTokenAddress(args.vault), tokenProgram: TOKEN_PROGRAM_ID })
    .instruction();
}
