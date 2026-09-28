/**
 * The keeper: settles every due series in a vault on Pyth's first print after
 * the open, voids the ones nobody could settle, pays every position in a
 * finished series to whoever holds its NFT (the vault tips the keeper for
 * each), and rolls the pool once the round is paid. Every step is
 * permissionless, so any funded wallet can run it; it pays fees and any
 * missing token-account rent, never the payouts.
 */
import { createRequire } from "node:module";

import anchor from "@anchor-lang/core";
import type { HermesClient } from "@pythnetwork/hermes-client";
import type * as PythReceiver from "@pythnetwork/pyth-solana-receiver";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction, Transaction, type TransactionInstruction } from "@solana/web3.js";

import {
  getProgram,
  holderOf,
  parseVaultEvents,
  PROCESS_BATCH,
  processInstruction,
  rollInstruction,
  settleInstruction,
  voidSeriesInstruction,
  type Payee,
} from "../client/vault";
import { claimUnits, plan, rollBlocked, settlementError, toPrice8, type PositionView, type Print, type SeriesState, type SeriesView } from "./plan";
import { CannotSettle, NotYetPublished, settlementUpdate } from "./pyth";

// The receiver's ES-module build imports a path without its extension, which
// Node rejects; its CommonJS build loads (with the @solana/web3.js override in package.json).
const { PythSolanaReceiver, PRO_COMPATIBLE_PUSH_ORACLE_PROGRAM_ID, PRO_COMPATIBLE_RECEIVER_PROGRAM_ID, PRO_COMPATIBLE_WORMHOLE_PROGRAM_ID } =
  createRequire(import.meta.url)("@pythnetwork/pyth-solana-receiver") as typeof PythReceiver;

export type KeeperReport = {
  settled: { series: string; price: number; signatures: string[] }[];
  voided: string[];
  /** Each position paid out: to its NFT's holder (a refund if voided), or forfeited if the NFT was burned. */
  paid: { position: string; holder: string | null; units: bigint; refund: boolean }[];
  /** The tips the vault paid this keeper, in collateral units. */
  tips: bigint;
  rolled: { round: bigint; signature: string } | null;
  waiting: { series: string; reason: string }[];
  signatures: string[];
};

export type KeeperOptions = {
  connection: Connection;
  payer: Keypair;
  vault: PublicKey;
  /** Hermes, created only when a series is due (so no API key is needed otherwise). */
  hermes: () => HermesClient;
  /**
   * Settle on an update already posted on-chain instead of posting one from
   * Hermes. For tests on a local validator, which has no Pyth receiver.
   */
  postedUpdate?: (series: SeriesView) => PublicKey | undefined;
  log?: (line: string) => void;
};

const VOIDS_PER_TX = 8;
const ACCOUNTS_PER_TX = 4;

const stateOf = (s: object) => Object.keys(s)[0] as SeriesState;
const voidAfter = (s: SeriesView, v: { voidDelaySecs: number }) => `it can be voided after ${new Date((s.openTs + v.voidDelaySecs + 1) * 1000).toISOString()}`;
const hex = (bytes: number[]) => "0x" + Buffer.from(bytes).toString("hex");
const big = (x: { toString(): string }) => BigInt(x.toString());

type VaultProgram = ReturnType<typeof getProgram>;

/** Every series in the vault and every position not yet paid out, as the planner sees them and as fetched. */
async function loadVault(program: VaultProgram, vault: PublicKey) {
  const byVault = [{ memcmp: { offset: 8, bytes: vault.toBase58() } }];
  const [series, positions] = await Promise.all([program.account.series.all(byVault), program.account.position.all(byVault)]);
  const unpaid = positions.filter((p) => !p.account.closed);
  return {
    raw: new Map(series.map((s) => [s.publicKey.toBase58(), s.account])),
    series: series.map(
      (s): SeriesView => ({
        address: s.publicKey.toBase58(),
        feedId: hex(s.account.feedId),
        openTs: s.account.openTs.toNumber(),
        state: stateOf(s.account.state),
        lowestLower: big(s.account.lowestLower),
        highestUpper: big(s.account.highestUpper),
      }),
    ),
    positions: unpaid.map((p) => ({
      view: {
        address: p.publicKey.toBase58(),
        series: p.account.series.toBase58(),
        mint: p.account.mint.toBase58(),
        buyer: p.account.buyer.toBase58(),
      } as PositionView,
      account: p.account,
    })),
  };
}

// The program judges time by the cluster's clock, so the keeper does too.
const clusterNow = async (connection: Connection) => (await connection.getBlockTime(await connection.getSlot("confirmed"))) ?? Math.floor(Date.now() / 1000);

type PositionTerms = { shares: { toString(): string }; upper: { toString(): string }; lower: { toString(): string }; premium: { toString(): string } };
const terms = (p: PositionTerms) => ({ shares: big(p.shares), upper: big(p.upper), lower: big(p.lower), premium: big(p.premium) });

/** The vault's round, as rollBlocked reads it. */
const roundOf = (v: { roundOpenTs: { toNumber(): number }; roundUnpaid: number; pendingDepositAssets: { toString(): string }; pendingRedeemShares: { toString(): string } }) => ({
  roundOpenTs: v.roundOpenTs.toNumber(),
  roundUnpaid: v.roundUnpaid,
  pendingDepositAssets: big(v.pendingDepositAssets),
  pendingRedeemShares: big(v.pendingRedeemShares),
});

/**
 * Where each position's payout goes: its NFT's holder's collateral account,
 * or, if the NFT was burned and nobody holds it, its mint in both places
 * (the program then forfeits the payout to the pool).
 */
async function payeesFor(connection: Connection, collateralMint: PublicKey, positions: PositionView[]) {
  return Promise.all(
    positions.map(async (p) => {
      const mint = new PublicKey(p.mint);
      const holder = await holderOf(connection, mint, new PublicKey(p.buyer));
      const payee: Payee = holder
        ? { position: new PublicKey(p.address), nftAccount: holder.account, payeeToken: getAssociatedTokenAddressSync(collateralMint, holder.owner, true) }
        : { position: new PublicKey(p.address), nftAccount: mint, payeeToken: mint };
      return { payee, holder: holder?.owner ?? null };
    }),
  );
}

export async function runKeeper(opts: KeeperOptions): Promise<KeeperReport> {
  const { connection, payer, vault } = opts;
  const log = opts.log ?? (() => {});
  const program = getProgram(connection, new anchor.Wallet(payer));
  let v = await program.account.vault.fetch(vault);
  const report: KeeperReport = { settled: [], voided: [], paid: [], tips: 0n, rolled: null, waiting: [], signatures: [] };
  const send = async (ixs: TransactionInstruction[]) => {
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [payer], { commitment: "confirmed" });
    report.signatures.push(sig);
    return sig;
  };

  const load = () => loadVault(program, vault);
  let state = await load();
  const todo = plan(await clusterNow(connection), v.params, state.series, state.positions.map((p) => p.view));
  report.waiting.push(...todo.waiting);

  // Void what can no longer settle: every premium in it is refunded when it's paid out.
  for (let i = 0; i < todo.void.length; i += VOIDS_PER_TX) {
    const batch = todo.void.slice(i, i + VOIDS_PER_TX);
    await send(await Promise.all(batch.map((s) => voidSeriesInstruction(program, { vault, series: new PublicKey(s.address) }))));
    report.voided.push(...batch.map((s) => s.address));
    log(`voided ${batch.map((s) => s.address).join(", ")}`);
  }

  // Settle each due series on its first print after the open.
  for (const s of todo.settle) {
    const series = new PublicKey(s.address);
    const posted = opts.postedUpdate?.(s);
    if (posted) {
      const sig = await send([await settleInstruction(program, { vault, series, priceUpdate: posted })]);
      report.settled.push({ series: s.address, price: NaN, signatures: [sig] });
      log(`settled ${s.address} on posted update ${posted.toBase58()}`);
      continue;
    }
    let update;
    try {
      update = await settlementUpdate(opts.hermes(), s.feedId, s.openTs, v.params, s);
    } catch (e) {
      if (!(e instanceof NotYetPublished || e instanceof CannotSettle)) throw e;
      report.waiting.push({ series: s.address, reason: e instanceof CannotSettle ? `${e.message}; ${voidAfter(s, v.params)}` : e.message });
      continue;
    }
    const receiver = new PythSolanaReceiver({
      connection,
      // The receiver bundles an older Anchor; the wallet shape is the same.
      wallet: new anchor.Wallet(payer) as never,
      receiverProgramId: PRO_COMPATIBLE_RECEIVER_PROGRAM_ID,
      wormholeProgramId: PRO_COMPATIBLE_WORMHOLE_PROGRAM_ID,
      pushOracleProgramId: PRO_COMPATIBLE_PUSH_ORACLE_PROGRAM_ID,
    });
    // Post the update, settle on it, then close the update account to get its rent back.
    const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
    await builder.addPostPriceUpdates(update.data);
    await builder.addPriceConsumerInstructions(async (priceUpdateAccount) => [
      { instruction: await settleInstruction(program, { vault, series, priceUpdate: priceUpdateAccount(s.feedId) }), signers: [] },
    ]);
    const txs = await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: 50_000, tightComputeBudget: true });
    const sigs = await receiver.provider.sendAll(txs, { commitment: "confirmed" });
    report.signatures.push(...sigs);
    report.settled.push({ series: s.address, price: update.price, signatures: sigs });
    log(`settled ${s.address} at $${update.price} (published ${new Date(update.publishTime * 1000).toISOString()})`);
  }

  // Pay every position in a finished series to whoever holds its NFT now.
  state = await load();
  const pay = plan(await clusterNow(connection), v.params, state.series, state.positions.map((p) => p.view)).pay;
  if (pay.length) {
    const keeperToken = getAssociatedTokenAddressSync(v.collateralMint, payer.publicKey);
    const payees = await payeesFor(connection, v.collateralMint, pay);
    // Holders without a collateral account get one (the keeper pays the rent), and so does the keeper, for its tips.
    const needed = [
      { owner: payer.publicKey, account: keeperToken },
      ...payees.filter((p) => p.holder).map((p) => ({ owner: p.holder!, account: p.payee.payeeToken })),
    ].filter((a, i, all) => all.findIndex((b) => b.account.equals(a.account)) === i);
    const exists = await connection.getMultipleAccountsInfo(needed.map((a) => a.account), "confirmed");
    const missing = needed.filter((_, i) => !exists[i]);
    for (let i = 0; i < missing.length; i += ACCOUNTS_PER_TX) {
      await send(
        missing
          .slice(i, i + ACCOUNTS_PER_TX)
          .map((a) => createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, a.account, a.owner, v.collateralMint)),
      );
    }

    const bySeries = new Map<string, typeof payees>();
    pay.forEach((p, i) => bySeries.set(p.series, [...(bySeries.get(p.series) ?? []), payees[i]!]));
    for (const [series, list] of bySeries) {
      for (let i = 0; i < list.length; i += PROCESS_BATCH) {
        const batch = list.slice(i, i + PROCESS_BATCH).map((p) => p.payee);
        const ix = await processInstruction(program, {
          keeper: payer.publicKey,
          vault,
          series: new PublicKey(series),
          collateralMint: v.collateralMint,
          keeperToken,
          payees: batch,
        });
        const sig = await send([ix]);
        const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        for (const e of parseVaultEvents(program, tx?.meta?.logMessages ?? [])) {
          if (e.name === "paid") {
            report.paid.push({ position: e.data.position.toBase58(), holder: e.data.holder.toBase58(), units: big(e.data.amount), refund: e.data.refund });
            log(`${e.data.refund ? "refunded" : "paid"} ${e.data.position.toBase58()}: ${Number(big(e.data.amount)) / Number(big(v.collateralUnit))} to ${e.data.holder.toBase58()}`);
          } else if (e.name === "forfeited") {
            report.paid.push({ position: e.data.position.toBase58(), holder: null, units: 0n, refund: false });
            log(`forfeited ${e.data.position.toBase58()}: its NFT was burned, so its payout stays in the pool`);
          } else if (e.name === "processed") {
            report.tips += big(e.data.tips);
          }
        }
      }
    }
  }

  // The round is over and paid (or sold nothing while requests wait): roll, filling deposits and redemptions.
  v = await program.account.vault.fetch(vault);
  if (rollBlocked(await clusterNow(connection), roundOf(v)) === null) {
    const round = big(v.round);
    const signature = await send([await rollInstruction(program, { payer: payer.publicKey, vault, round })]);
    report.rolled = { round, signature };
    log(`rolled round ${round} into ${round + 1n}`);
  }
  return report;
}

export type PlannedPosition = {
  position: string;
  /** Whoever holds its NFT now, who is paid; null if the NFT was burned (the payout is forfeited to the pool). */
  holder: string | null;
  /** The most it can pay: the whole spread. */
  maxUnits: bigint;
  /** What paying it out would pay, once the price (or a void) is known. */
  units?: bigint;
};

export type SeriesPlan = {
  series: string;
  openTs: number;
  action: "wait" | "settle" | "void" | "pay";
  /** Why the keeper will wait, or can't settle. */
  note?: string;
  /** The print the series would settle on. */
  print?: { price: number; publishTime: number };
  positions: PlannedPosition[];
};

export type KeeperPlan = {
  now: number;
  collateralUnit: bigint;
  series: SeriesPlan[];
  /** Why the pool won't roll after this run, or null if it would. */
  rollBlocked: string | null;
};

/**
 * What runKeeper would do right now, without sending anything: which series
 * it would settle (and on which print), void, pay out or leave waiting, what
 * each position would pay and to whom, and whether the pool would roll.
 * Reads the cluster and Hermes only, and needs no wallet. A print it can't
 * fetch (no key, not published yet) becomes a note.
 */
export async function planKeeper(opts: Omit<KeeperOptions, "payer" | "log">): Promise<KeeperPlan> {
  const { connection, vault } = opts;
  // A throwaway wallet: Anchor wants one, and nothing here asks it to sign.
  const program = getProgram(connection, new anchor.Wallet(Keypair.generate()));
  const v = await program.account.vault.fetch(vault);
  const unit = big(v.collateralUnit);
  const state = await loadVault(program, vault);
  const now = await clusterNow(connection);
  const todo = plan(now, v.params, state.series, state.positions.map((p) => p.view));
  const holders = new Map(
    (await payeesFor(connection, v.collateralMint, state.positions.map((p) => p.view))).map((p, i) => [state.positions[i]!.view.address, p.holder?.toBase58() ?? null]),
  );

  const printOf = async (s: SeriesView) => {
    const posted = opts.postedUpdate?.(s);
    if (!posted) return settlementUpdate(opts.hermes(), s.feedId, s.openTs, v.params, s);
    const info = await connection.getAccountInfo(posted);
    if (!info) throw new Error(`no price update account at ${posted.toBase58()}`);
    const m = program.coder.types.decode("priceUpdateV2", info.data.subarray(8)).priceMessage;
    const print: Print = { price: big(m.price), conf: big(m.conf), expo: m.exponent, publishTime: m.publishTime.toNumber(), prevPublishTime: m.prevPublishTime.toNumber() };
    const error = settlementError(print, s.openTs, v.params, s);
    if (error) throw new CannotSettle(error);
    const price8 = toPrice8(print.price, print.expo);
    return { price: Number(price8) / 1e8, price8, publishTime: print.publishTime };
  };
  const positionsIn = (series: string, units: (t: ReturnType<typeof terms>) => bigint | undefined): PlannedPosition[] =>
    state.positions
      .filter((p) => p.view.series === series)
      .map((p) => {
        const t = terms(p.account);
        const holder = holders.get(p.view.address) ?? null;
        // At a price of zero a position pays its whole spread; a burned NFT's payout is forfeited.
        return { position: p.view.address, holder, maxUnits: claimUnits("settled", t, 0n, unit), units: holder === null ? 0n : units(t) };
      });

  const out: SeriesPlan[] = [];
  // Series this run would leave open: their positions stay unpaid, and the round with them.
  const stillOpen = new Set<string>();
  for (const s of state.series) {
    const base = { series: s.address, openTs: s.openTs };
    const waiting = todo.waiting.find((w) => w.series === s.address);
    if (waiting) {
      stillOpen.add(s.address);
      out.push({ ...base, action: "wait", note: waiting.reason, positions: positionsIn(s.address, () => undefined) });
    } else if (todo.void.includes(s)) {
      out.push({ ...base, action: "void", positions: positionsIn(s.address, (t) => claimUnits("voided", t, 0n, unit)) });
    } else if (todo.settle.includes(s)) {
      try {
        const u = await printOf(s);
        out.push({ ...base, action: "settle", print: { price: u.price, publishTime: u.publishTime }, positions: positionsIn(s.address, (t) => claimUnits("settled", t, u.price8, unit)) });
      } catch (e) {
        stillOpen.add(s.address);
        const why = e instanceof Error ? e.message : String(e);
        const note = e instanceof CannotSettle ? `can't settle: ${why}; ${voidAfter(s, v.params)}` : e instanceof NotYetPublished ? why : `can't fetch the print: ${why}`;
        out.push({ ...base, action: "settle", note, positions: positionsIn(s.address, () => undefined) });
      }
    } else {
      const raw = state.raw.get(s.address)!;
      const positions = positionsIn(s.address, (t) => claimUnits(s.state as Exclude<SeriesState, "open">, t, big(raw.price), unit));
      if (positions.length) out.push({ ...base, action: "pay", positions });
    }
  }
  const roundUnpaid = state.positions.filter((p) => stillOpen.has(p.view.series)).length;
  return { now, collateralUnit: unit, series: out, rollBlocked: rollBlocked(now, { ...roundOf(v), roundUnpaid }) };
}
