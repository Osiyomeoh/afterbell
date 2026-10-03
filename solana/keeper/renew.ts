/**
 * The keeper's renewal step: after an open is settled and the pool has
 * rolled, buy the next open's protection for every standing order, at the
 * quote service's price, within each order's limits. The quote is signed for
 * the order's address, which buys on the holder's behalf.
 */
import { createRequire } from "node:module";

import anchor from "@anchor-lang/core";
import type * as PythReceiver from "@pythnetwork/pyth-solana-receiver";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";

import { AfterbellClient } from "../../sdk/client";
import { toSolanaQuote } from "../../sdk/solana";
import { feedIdHex, getProgram, renewInstructions, resizeOrderInstruction, sizerAddress } from "../client/vault";
import { hermesFromEnv } from "./pyth";

const { PythSolanaReceiver, PRO_COMPATIBLE_PUSH_ORACLE_PROGRAM_ID, PRO_COMPATIBLE_RECEIVER_PROGRAM_ID, PRO_COMPATIBLE_WORMHOLE_PROGRAM_ID } =
  createRequire(import.meta.url)("@pythnetwork/pyth-solana-receiver") as typeof PythReceiver;

export type SolanaOrder = {
  address: string;
  holder: string;
  feedId: string;
  maxShares: bigint;
  startBps: number;
  depthBps: number;
  maxPremium: bigint;
  until: bigint;
  lastOpenTs: bigint;
  active: boolean;
};

export type RenewalDecision = { action: "renew" } | { action: "skip"; reason: string };

/**
 * Whether an order should buy protection for `openTs` at `premium` (collateral units). The program checks
 * the same again, except `held`: whether the holder already bought protection for that open directly
 * (as at checkout, where the order is set after tonight's purchase).
 */
export function renewalDecision(o: SolanaOrder, openTs: bigint, premium: bigint, held = false): RenewalDecision {
  if (!o.active) return { action: "skip", reason: "cancelled" };
  if (openTs > o.until) return { action: "skip", reason: "the order has ended" };
  if (openTs <= o.lastOpenTs) return { action: "skip", reason: "already renewed for this open" };
  if (held) return { action: "skip", reason: "the holder already has protection for this open" };
  if (premium > o.maxPremium) return { action: "skip", reason: `the price, ${premium} units, is above the order's cap of ${o.maxPremium}` };
  return { action: "renew" };
}

export type RenewalPlan = { order: SolanaOrder; symbol: string; openTs?: number; premium?: number; decision: RenewalDecision; signatures?: string[] };


/**
 * For each standing order: tonight's quote for its protection, signed for the
 * order, and whether to buy it. With `payer`, buys each one that should be,
 * posting Pyth's latest price for the program to check the strikes against.
 */
export async function renewOrders(opts: {
  connection: Connection;
  vault: PublicKey;
  feeds: Record<string, { feedId: string }>;
  api: AfterbellClient;
  payer?: Keypair;
  log?: (line: string) => void;
  /**
   * Tonight's size for an order whose holder named `payer` its sizer (Kamino auto-cover: the
   * shares and band from coverPlan). Null leaves the order as it is. Clamped to the holder's bounds.
   */
  sizeFor?: (order: SolanaOrder, symbol: string) => Promise<{ maxShares: bigint; startBps: number; depthBps: number } | null>;
}): Promise<RenewalPlan[]> {
  const { connection, vault, api, payer } = opts;
  const program = getProgram(connection, new anchor.Wallet(payer ?? Keypair.generate()));
  const now = BigInt(Math.floor(Date.now() / 1000));
  const symbolOf = (feedId: string) => Object.entries(opts.feeds).find(([, f]) => f.feedId.toLowerCase() === feedId)?.[0];

  const orders: SolanaOrder[] = (await program.account.order.all([{ memcmp: { offset: 8, bytes: vault.toBase58() } }]))
    .map(({ publicKey, account: a }) => ({
      address: publicKey.toBase58(),
      holder: a.holder.toBase58(),
      feedId: feedIdHex(a.feedId),
      maxShares: BigInt(a.maxShares.toString()),
      startBps: a.startBps,
      depthBps: a.depthBps,
      maxPremium: BigInt(a.maxPremium.toString()),
      until: BigInt(a.until.toString()),
      lastOpenTs: BigInt(a.lastOpenTs.toString()),
      active: a.active,
    }))
    .filter((o) => o.active && o.until > now);
  if (orders.length === 0) return [];

  // "holder:feed:openTs" for every open position, by its buyer.
  const held = new Set<string>();
  const series = new Map((await program.account.series.all([{ memcmp: { offset: 8, bytes: vault.toBase58() } }])).map((s) => [s.publicKey.toBase58(), s.account]));
  for (const { account: p } of await program.account.position.all([{ memcmp: { offset: 8, bytes: vault.toBase58() } }])) {
    const s = series.get(p.series.toBase58());
    if (!p.closed && s) held.add(`${p.buyer.toBase58()}:${feedIdHex(s.feedId)}:${s.openTs.toString()}`);
  }

  const receiver = payer
    ? new PythSolanaReceiver({
        connection,
        // The receiver bundles an older Anchor; the wallet shape is the same.
        wallet: new anchor.Wallet(payer) as never,
        receiverProgramId: PRO_COMPATIBLE_RECEIVER_PROGRAM_ID,
        wormholeProgramId: PRO_COMPATIBLE_WORMHOLE_PROGRAM_ID,
        pushOracleProgramId: PRO_COMPATIBLE_PUSH_ORACLE_PROGRAM_ID,
      })
    : undefined;

  const plans: RenewalPlan[] = [];
  for (const order of orders) {
    const symbol = symbolOf(order.feedId);
    if (!symbol) {
      plans.push({ order, symbol: order.feedId, decision: { action: "skip", reason: "a feed this deployment doesn't list" } });
      continue;
    }
    try {
      if (payer && opts.sizeFor) await resize(program, payer, order, symbol, opts.sizeFor, opts.log);
      const protection = await api.protectionBelow(symbol, Number(order.maxShares) / 1e6, order.startBps / 10_000, order.depthBps / 10_000);
      const q = await api.quote({ chain: "solana", symbol, buyer: order.address, ...protection });
      const quote = toSolanaQuote(q.solana.quote);
      const decision = renewalDecision(order, quote.openTs, quote.premium, held.has(`${order.holder}:${order.feedId}:${quote.openTs}`));
      const plan: RenewalPlan = { order, symbol, openTs: Number(quote.openTs), premium: q.priced.premium, decision };
      plans.push(plan);
      if (!receiver || !payer || decision.action !== "renew") continue;

      const holder = new PublicKey(order.holder);
      const collateralMint = new PublicKey(q.solana.collateralMint);
      const update = await hermesFromEnv().getLatestPriceUpdates([order.feedId], { encoding: "base64" });
      // Post the latest price, renew on it (the signature check must sit right before renew), then close the update.
      const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
      await builder.addPostPriceUpdates(update.binary.data);
      await builder.addPriceConsumerInstructions(async (priceUpdateAccount) =>
        (
          await renewInstructions(program, {
            keeper: payer.publicKey,
            holder,
            vault,
            collateralMint,
            holderToken: getAssociatedTokenAddressSync(collateralMint, holder, true),
            priceUpdate: priceUpdateAccount(order.feedId),
            quote,
            ed25519Data: Buffer.from(q.solana.ed25519Data, "base64"),
          })
        ).map((instruction) => ({ instruction, signers: [] })),
      );
      const txs = await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: 50_000, tightComputeBudget: true });
      plan.signatures = await receiver.provider.sendAll(txs, { commitment: "confirmed" });
      opts.log?.(`renewed ${symbol} for ${order.holder}: $${q.priced.premium.toFixed(2)} (${plan.signatures.at(-1)})`);
    } catch (e) {
      const last = plans.at(-1);
      if (last?.order === order) last.decision = { action: "skip", reason: (e as Error).message };
      else plans.push({ order, symbol, decision: { action: "skip", reason: (e as Error).message } });
    }
  }
  return plans;
}

/** Re-sizes `order` before it's quoted, when `payer` is its sizer and tonight's size differs. */
async function resize(
  program: ReturnType<typeof getProgram>,
  payer: Keypair,
  order: SolanaOrder,
  symbol: string,
  sizeFor: NonNullable<Parameters<typeof renewOrders>[0]["sizeFor"]>,
  log?: (line: string) => void,
) {
  const address = new PublicKey(order.address);
  const sizer = await program.account.sizer.fetchNullable(sizerAddress(address));
  if (!sizer?.sizer.equals(payer.publicKey)) return;
  const want = await sizeFor(order, symbol);
  if (!want) return;
  const maxShares = want.maxShares < BigInt(sizer.maxShares.toString()) ? want.maxShares : BigInt(sizer.maxShares.toString());
  const startBps = Math.max(want.startBps, sizer.minStartBps);
  const depthBps = Math.min(want.depthBps, sizer.maxDepthBps);
  if (maxShares <= 0n || depthBps <= startBps) return;
  if (maxShares === order.maxShares && startBps === order.startBps && depthBps === order.depthBps) return;
  const ix = await resizeOrderInstruction(program, { signer: payer.publicKey, order: address, maxShares, startBps, depthBps });
  const sig = await program.provider.sendAndConfirm!(new Transaction().add(ix), [payer]);
  Object.assign(order, { maxShares, startBps, depthBps });
  log?.(`resized ${symbol} for ${order.holder}: ${Number(maxShares) / 1e6} shares, ${startBps}–${depthBps} bps (${sig})`);
}
