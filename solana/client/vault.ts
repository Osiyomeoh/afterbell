/**
 * TypeScript client for the Solana vault v2 (solana/programs/afterbell-vault):
 * its addresses, a typed Anchor program, and the instructions to buy, settle,
 * pay positions out to their NFTs' holders and underwrite the pool. `idl/` is
 * copied from solana/target after the IDL build (npm run solana:idl).
 */
import * as anchorModule from "@anchor-lang/core";
import type { AnchorProvider, Program } from "@anchor-lang/core";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
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

/** Settlement timings and risk limits (the program's `Params`). Changes wait for the next roll. */
export type VaultParams = {
  /** How long after the open the first print may land (1..=3600 s). */
  settleWindowSecs: number;
  /** When an unsettled series voids and refunds (3600 s..=7 d, above the settle window). */
  voidDelaySecs: number;
  /** Widest Pyth confidence interval accepted, in bps of the price (1..=1000). */
  maxConfBps: number;
  /** The most a round may lock, in bps of the pool at its roll. */
  maxUtilizationBps: number;
  /** The most one stock may lock in a round, in bps of the pool at its roll. */
  maxFeedBps: number;
  /** The keeper's cut of each premium, paid to whoever pays the position out (at most 1000). */
  keeperTipBps: number;
};

/** The values the LiteSVM tests run with, and the EVM vault's limits. */
export const DEFAULT_PARAMS: VaultParams = {
  settleWindowSecs: 60,
  voidDelaySecs: 86_400,
  maxConfBps: 100,
  maxUtilizationBps: 5_000,
  maxFeedBps: 2_000,
  keeperTipBps: 200,
};

const seed = (s: string) => new TextEncoder().encode(s);

/** A feed id's bytes as Pyth writes it: 0x and 64 hex digits. */
export const feedIdHex = (bytes: number[] | Uint8Array) => "0x" + Buffer.from(bytes).toString("hex");

export function feedIdBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error(`not a 32-byte feed id: ${hex}`);
  return Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
}

const le64 = (v: bigint, signed: boolean) => {
  const b = new Uint8Array(8);
  const view = new DataView(b.buffer);
  if (signed) view.setBigInt64(0, v, true);
  else view.setBigUint64(0, v, true);
  return b;
};

const pda = (seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

export const vaultAddress = (authority: PublicKey, collateralMint: PublicKey) =>
  pda([seed("vault"), authority.toBytes(), collateralMint.toBytes()]);
export const vaultTokenAddress = (vault: PublicKey) => pda([seed("vault_token"), vault.toBytes()]);
/** The pool's shares: a Token-2022 mint the vault controls. */
export const shareMintAddress = (vault: PublicKey) => pda([seed("share_mint"), vault.toBytes()]);
/** Where queued redemptions and filled deposits' shares wait. */
export const shareEscrowAddress = (vault: PublicKey) => pda([seed("share_escrow"), vault.toBytes()]);
export const feedConfigAddress = (vault: PublicKey, feedId: Uint8Array) => pda([seed("feed"), vault.toBytes(), feedId]);
export const seriesAddress = (vault: PublicKey, feedId: Uint8Array, openTs: bigint) =>
  pda([seed("series"), vault.toBytes(), feedId, le64(openTs, true)]);
export const positionAddress = (vault: PublicKey, nonce: Uint8Array) => pda([seed("position"), vault.toBytes(), nonce]);
/** A position's NFT: a Token-2022 mint with a supply of one. */
export const positionMintAddress = (vault: PublicKey, nonce: Uint8Array) => pda([seed("position_mint"), vault.toBytes(), nonce]);
export const requestAddress = (vault: PublicKey, owner: PublicKey) => pda([seed("request"), vault.toBytes(), owner.toBytes()]);
/** A holder's standing order for one stock: the SPL delegate for its premium allowance. */
export const orderAddress = (vault: PublicKey, holder: PublicKey, feedId: Uint8Array) =>
  pda([seed("order"), vault.toBytes(), holder.toBytes(), feedId]);
/** The pool's value at the roll that ended `round`: what that round's requests fill at. */
export const rateAddress = (vault: PublicKey, round: bigint) => pda([seed("rate"), vault.toBytes(), le64(round, false)]);

/** The owner's account for a Token-2022 mint: a position's NFT, or the pool's shares. */
export const token2022Account = (owner: PublicKey, mint: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);

export function getProgram(connection: Connection, wallet: AnchorProvider["wallet"]): Program<AfterbellVault> {
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  return new anchor.Program<AfterbellVault>(idl as AfterbellVault, provider);
}

const bn = (v: bigint) => new anchor.BN(v.toString());

/**
 * The two instructions that buy protection, in order: the Ed25519 program
 * verifying the quoter's signature, then `buy`, which checks that verification
 * covered this exact quote. The position's NFT is minted to the buyer.
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
  const positionMint = positionMintAddress(args.vault, q.nonce);
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
      positionMint,
      buyerNft: token2022Account(args.buyer, positionMint),
      collateralMint: args.collateralMint,
      buyerToken: args.buyerToken,
      vaultToken: vaultTokenAddress(args.vault),
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: TOKEN_PROGRAM_ID,
      nftTokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return [verify, buy];
}

/** A standing order's limits; `allowance` is what the order may spend in premiums in all. */
export type OrderTerms = {
  maxShares: bigint;
  /** Strikes the order accepts, in bps below the price: where cover starts and how deep it goes. */
  startBps: number;
  depthBps: number;
  maxPremium: bigint;
  /** No renewals for openings at or after this unix time. */
  until: bigint;
  allowance: bigint;
};

/** `set_order`: creates or changes the holder's order and approves it to spend `allowance`. */
export function setOrderInstruction(
  program: Program<AfterbellVault>,
  args: { holder: PublicKey; vault: PublicKey; feedId: Uint8Array; collateralMint: PublicKey; holderToken: PublicKey; terms: OrderTerms },
): Promise<TransactionInstruction> {
  const t = args.terms;
  return program.methods
    .setOrder(Array.from(args.feedId), {
      maxShares: bn(t.maxShares),
      startBps: t.startBps,
      depthBps: t.depthBps,
      maxPremium: bn(t.maxPremium),
      until: bn(t.until),
      allowance: bn(t.allowance),
    })
    .accountsPartial({
      holder: args.holder,
      vault: args.vault,
      feedConfig: feedConfigAddress(args.vault, args.feedId),
      order: orderAddress(args.vault, args.holder, args.feedId),
      collateralMint: args.collateralMint,
      holderToken: args.holderToken,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/** `cancel_order`: stops renewals and revokes the allowance. */
export function cancelOrderInstruction(
  program: Program<AfterbellVault>,
  args: { holder: PublicKey; order: PublicKey; holderToken: PublicKey },
): Promise<TransactionInstruction> {
  return program.methods
    .cancelOrder()
    .accountsPartial({ holder: args.holder, order: args.order, holderToken: args.holderToken, tokenProgram: TOKEN_PROGRAM_ID })
    .instruction();
}

/**
 * The two instructions a keeper sends to renew an order: the quoter's signature
 * (over a quote whose buyer is the order), then `renew`. The holder's allowance
 * pays the premium and the NFT goes to the holder; the keeper pays the rent.
 */
export async function renewInstructions(
  program: Program<AfterbellVault>,
  args: {
    keeper: PublicKey;
    holder: PublicKey;
    vault: PublicKey;
    collateralMint: PublicKey;
    holderToken: PublicKey;
    priceUpdate: PublicKey;
    quote: SolanaQuote;
    ed25519Data: Uint8Array;
  },
): Promise<TransactionInstruction[]> {
  const q = args.quote;
  const verify = new TransactionInstruction({ programId: Ed25519Program.programId, keys: [], data: Buffer.from(args.ed25519Data) });
  const positionMint = positionMintAddress(args.vault, q.nonce);
  const renew = await program.methods
    .renew({
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
      keeper: args.keeper,
      holder: args.holder,
      order: orderAddress(args.vault, args.holder, q.feedId),
      vault: args.vault,
      feedConfig: feedConfigAddress(args.vault, q.feedId),
      series: seriesAddress(args.vault, q.feedId, q.openTs),
      position: positionAddress(args.vault, q.nonce),
      positionMint,
      holderNft: token2022Account(args.holder, positionMint),
      collateralMint: args.collateralMint,
      holderToken: args.holderToken,
      vaultToken: vaultTokenAddress(args.vault),
      priceUpdate: args.priceUpdate,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: TOKEN_PROGRAM_ID,
      nftTokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return [verify, renew];
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

/** A position to pay out, with the accounts that prove its holder and receive the money. */
export type Payee = {
  position: PublicKey;
  /** The holder's Token-2022 account holding the position's NFT. */
  nftAccount: PublicKey;
  /** The holder's collateral account, where the payout goes. */
  payeeToken: PublicKey;
};

/**
 * Most positions one `process` fits: each takes three accounts, and a legacy
 * transaction is 1,232 bytes (the LiteSVM tests check seven fit).
 */
export const PROCESS_BATCH = 7;

/**
 * `process`: pays positions of a settled or voided series to whoever holds
 * each NFT, and the caller their tips. Anyone may call it.
 */
export function processInstruction(
  program: Program<AfterbellVault>,
  args: { keeper: PublicKey; vault: PublicKey; series: PublicKey; collateralMint: PublicKey; keeperToken: PublicKey; payees: Payee[] },
): Promise<TransactionInstruction> {
  return program.methods
    .process()
    .accountsPartial({
      keeper: args.keeper,
      vault: args.vault,
      series: args.series,
      collateralMint: args.collateralMint,
      vaultToken: vaultTokenAddress(args.vault),
      keeperToken: args.keeperToken,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(
      args.payees.flatMap((p) => [
        { pubkey: p.position, isSigner: false, isWritable: true },
        { pubkey: p.nftAccount, isSigner: false, isWritable: false },
        { pubkey: p.payeeToken, isSigner: false, isWritable: true },
      ]),
    )
    .instruction();
}

/**
 * Who holds a position's NFT now: the owner of the one account holding it
 * (the mint's supply is one), or null if nobody does.
 */
export async function holderOf(connection: Connection, mint: PublicKey): Promise<{ owner: PublicKey; account: PublicKey } | null> {
  const { value } = await connection.getTokenLargestAccounts(mint, "confirmed");
  const held = value.find((a) => a.amount === "1");
  if (!held) return null;
  const account = await getAccount(connection, held.address, "confirmed", TOKEN_2022_PROGRAM_ID);
  return { owner: account.owner, account: held.address };
}

// --------------------------------------------------------------------- the pool

type RequestView = { depositRound: { toString(): string }; depositAssets: { toString(): string }; redeemRound: { toString(): string }; redeemShares: { toString(): string } };

/**
 * The rate account a request's deposit or redemption needs to fill, if one
 * queued in a round already rolled is waiting; null otherwise.
 */
export function pendingRate(vault: PublicKey, request: RequestView | null, round: bigint, side: "deposit" | "redeem"): PublicKey | null {
  if (!request) return null;
  const [amount, queued] =
    side === "deposit" ? [request.depositAssets, request.depositRound] : [request.redeemShares, request.redeemRound];
  const r = BigInt(queued.toString());
  return BigInt(amount.toString()) > 0n && r < round ? rateAddress(vault, r) : null;
}

/** The owner's request and the vault's round, which say which rate (if any) an instruction needs. */
async function requestAndRound(program: Program<AfterbellVault>, vault: PublicKey, owner: PublicKey) {
  const [v, r] = await Promise.all([program.account.vault.fetch(vault), program.account.request.fetchNullable(requestAddress(vault, owner))]);
  return { request: r, round: BigInt(v.round.toString()) };
}

/** `request_deposit`: queues `assets` to join the pool at the next roll. */
export async function requestDepositInstruction(
  program: Program<AfterbellVault>,
  args: { owner: PublicKey; vault: PublicKey; collateralMint: PublicKey; ownerToken: PublicKey; assets: bigint },
): Promise<TransactionInstruction> {
  const { request, round } = await requestAndRound(program, args.vault, args.owner);
  return program.methods
    .requestDeposit(bn(args.assets))
    .accountsPartial({
      owner: args.owner,
      vault: args.vault,
      request: requestAddress(args.vault, args.owner),
      rate: pendingRate(args.vault, request, round, "deposit"),
      collateralMint: args.collateralMint,
      ownerToken: args.ownerToken,
      vaultToken: vaultTokenAddress(args.vault),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/** `request_redeem`: queues `shares` to leave the pool at the next roll; they wait in the vault's escrow. */
export async function requestRedeemInstruction(
  program: Program<AfterbellVault>,
  args: { owner: PublicKey; vault: PublicKey; shares: bigint },
): Promise<TransactionInstruction> {
  const { request, round } = await requestAndRound(program, args.vault, args.owner);
  const shareMint = shareMintAddress(args.vault);
  return program.methods
    .requestRedeem(bn(args.shares))
    .accountsPartial({
      owner: args.owner,
      vault: args.vault,
      request: requestAddress(args.vault, args.owner),
      rate: pendingRate(args.vault, request, round, "redeem"),
      shareMint,
      ownerShares: token2022Account(args.owner, shareMint),
      shareEscrow: shareEscrowAddress(args.vault),
      shareTokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/** `claim_deposit`: takes the shares every filled deposit bought (creating the owner's share account). */
export async function claimDepositInstruction(
  program: Program<AfterbellVault>,
  args: { owner: PublicKey; vault: PublicKey },
): Promise<TransactionInstruction> {
  const { request, round } = await requestAndRound(program, args.vault, args.owner);
  const shareMint = shareMintAddress(args.vault);
  return program.methods
    .claimDeposit()
    .accountsPartial({
      owner: args.owner,
      vault: args.vault,
      request: requestAddress(args.vault, args.owner),
      rate: pendingRate(args.vault, request, round, "deposit"),
      shareMint,
      ownerShares: token2022Account(args.owner, shareMint),
      shareEscrow: shareEscrowAddress(args.vault),
      shareTokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/** `claim_redemption`: takes the collateral every filled redemption is owed. */
export async function claimRedemptionInstruction(
  program: Program<AfterbellVault>,
  args: { owner: PublicKey; vault: PublicKey; collateralMint: PublicKey; ownerToken: PublicKey },
): Promise<TransactionInstruction> {
  const { request, round } = await requestAndRound(program, args.vault, args.owner);
  return program.methods
    .claimRedemption()
    .accountsPartial({
      owner: args.owner,
      vault: args.vault,
      request: requestAddress(args.vault, args.owner),
      rate: pendingRate(args.vault, request, round, "redeem"),
      collateralMint: args.collateralMint,
      ownerToken: args.ownerToken,
      vaultToken: vaultTokenAddress(args.vault),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

/** `roll`: ends round `round` and fills its requests; anyone may call it, paying the rate record's rent. */
export function rollInstruction(
  program: Program<AfterbellVault>,
  args: { payer: PublicKey; vault: PublicKey; round: bigint },
): Promise<TransactionInstruction> {
  return program.methods
    .roll()
    .accountsPartial({
      payer: args.payer,
      vault: args.vault,
      rate: rateAddress(args.vault, args.round),
      vaultToken: vaultTokenAddress(args.vault),
      shareMint: shareMintAddress(args.vault),
      shareEscrow: shareEscrowAddress(args.vault),
      shareTokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

// ------------------------------------------------------------------ events

type Num = { toString(): string };

export type VaultEvent =
  | {
      name: "protectionBought";
      data: { vault: PublicKey; position: PublicKey; mint: PublicKey; number: Num; buyer: PublicKey; feedId: number[]; openTs: Num; shares: Num; upper: Num; lower: Num; premium: Num; maxPayout: Num };
    }
  | { name: "seriesSettled"; data: { series: PublicKey; price: Num; publishTime: Num } }
  | { name: "seriesVoided"; data: { series: PublicKey } }
  | { name: "paid"; data: { position: PublicKey; holder: PublicKey; amount: Num; refund: boolean } }
  | { name: "forfeited"; data: { position: PublicKey; amount: Num } }
  | { name: "processed"; data: { series: PublicKey; positions: number; keeper: PublicKey; tips: Num } }
  | { name: "rolled"; data: { vault: PublicKey; round: Num; openTs: Num; assets: Num; supply: Num; depositAssets: Num; depositShares: Num; redeemShares: Num; redeemAssets: Num } }
  | { name: "depositRequested" | "redeemRequested" | "depositClaimed" | "redemptionClaimed" | "paramsQueued" | "paramsSet"; data: Record<string, unknown> };

/** The vault's events in one transaction's logs. */
export function parseVaultEvents(program: Program<AfterbellVault>, logs: string[]): VaultEvent[] {
  return [...new anchor.EventParser(program.programId, program.coder).parseLogs(logs)] as VaultEvent[];
}
