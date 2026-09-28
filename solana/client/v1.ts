/**
 * The Solana vault's first version (v1), live on devnet at the program in
 * `idl/v1`: kept to read and settle what it sold, and for its history, while
 * v2 (`vault.ts`) takes over sales. v1's IDL is frozen; don't regenerate it.
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

import idl from "./idl/v1/afterbell_vault.json" with { type: "json" };
import type { AfterbellVault } from "./idl/v1/afterbell_vault";

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

export type VaultEvent =
  | { name: "protectionBought"; data: { position: PublicKey; buyer: PublicKey; feedId: number[]; openTs: { toString(): string }; premium: { toString(): string }; maxPayout: { toString(): string } } }
  | { name: "seriesSettled"; data: { series: PublicKey; price: { toString(): string }; publishTime: { toString(): string } } }
  | { name: "seriesVoided"; data: { series: PublicKey } }
  | { name: "claimed"; data: { position: PublicKey; buyer: PublicKey; amount: { toString(): string }; refund: boolean } };

/** The vault's events in one transaction's logs: sales, settlements, voids and claims. */
export function parseVaultEvents(program: Program<AfterbellVault>, logs: string[]): VaultEvent[] {
  return [...new anchor.EventParser(program.programId, program.coder).parseLogs(logs)] as VaultEvent[];
}

/**
 * What v1's events say it sold, paid and settled. A claimed v1 position is a
 * closed account, so its sale and payout survive only in these events.
 */
export type V1Ledger = {
  /** The newest transaction read into it. */
  through?: string;
  bought: Map<string, { series: string; premium: bigint; maxPayout: bigint }>;
  paid: Map<string, bigint>;
  settleTx: Map<string, string>;
};

export const emptyV1Ledger = (): V1Ledger => ({ bought: new Map(), paid: new Map(), settleTx: new Map() });

/** Adds one transaction's events, oldest transaction first. */
export function addV1Events(ledger: V1Ledger, vault: PublicKey, sig: string, events: VaultEvent[]): void {
  for (const e of events) {
    if (e.name === "protectionBought") {
      const series = seriesAddress(vault, Uint8Array.from(e.data.feedId), BigInt(e.data.openTs.toString())).toBase58();
      ledger.bought.set(e.data.position.toBase58(), { series, premium: BigInt(e.data.premium.toString()), maxPayout: BigInt(e.data.maxPayout.toString()) });
    } else if (e.name === "seriesSettled") {
      ledger.settleTx.set(e.data.series.toBase58(), sig);
    } else if (e.name === "claimed") {
      ledger.paid.set(e.data.position.toBase58(), BigInt(e.data.amount.toString()));
    }
  }
  ledger.through = sig;
}

/** The ledger as JSON (amounts in units, as strings), as solana/deployments/devnet-v1-ledger.json keeps it. */
export type V1LedgerJson = {
  vault: string;
  through?: string;
  bought: Record<string, { series: string; premium: string; maxPayout: string }>;
  paid: Record<string, string>;
  settleTx: Record<string, string>;
};

export const v1LedgerToJson = (vault: PublicKey, l: V1Ledger): V1LedgerJson => ({
  vault: vault.toBase58(),
  through: l.through,
  bought: Object.fromEntries([...l.bought].map(([k, b]) => [k, { series: b.series, premium: b.premium.toString(), maxPayout: b.maxPayout.toString() }])),
  paid: Object.fromEntries([...l.paid].map(([k, v]) => [k, v.toString()])),
  settleTx: Object.fromEntries(l.settleTx),
});

export const v1LedgerFromJson = (j: V1LedgerJson): V1Ledger => ({
  through: j.through,
  bought: new Map(Object.entries(j.bought).map(([k, b]) => [k, { series: b.series, premium: BigInt(b.premium), maxPayout: BigInt(b.maxPayout) }])),
  paid: new Map(Object.entries(j.paid).map(([k, v]) => [k, BigInt(v)])),
  settleTx: new Map(Object.entries(j.settleTx)),
});
