/**
 * The keeper: settles every due series in a vault on Pyth's first print after
 * the open, voids the ones nobody could settle, and claims every position in
 * finished series. Every step is permissionless, so any funded wallet can run
 * it; it pays fees and any missing token-account rent, never the payouts.
 */
import { createRequire } from "node:module";

import anchor from "@anchor-lang/core";
import type { HermesClient } from "@pythnetwork/hermes-client";
import type * as PythReceiver from "@pythnetwork/pyth-solana-receiver";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction, Transaction, type TransactionInstruction } from "@solana/web3.js";

import { claimInstruction, getProgram, settleInstruction, voidSeriesInstruction } from "../client/vault";
import { claimUnits, plan, settlementError, toPrice8, type PositionView, type Print, type SeriesState, type SeriesView } from "./plan";
import { CannotSettle, NotYetPublished, settlementUpdate } from "./pyth";

// The receiver's ES-module build imports a path without its extension, which
// Node rejects; its CommonJS build loads (with the @solana/web3.js override in package.json).
const { PythSolanaReceiver, PRO_COMPATIBLE_PUSH_ORACLE_PROGRAM_ID, PRO_COMPATIBLE_RECEIVER_PROGRAM_ID, PRO_COMPATIBLE_WORMHOLE_PROGRAM_ID } =
  createRequire(import.meta.url)("@pythnetwork/pyth-solana-receiver") as typeof PythReceiver;

export type KeeperReport = {
  settled: { series: string; price: number; signatures: string[] }[];
  voided: string[];
  claimed: { position: string; buyer: string; units: bigint }[];
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

const CLAIMS_PER_TX = 3;
const VOIDS_PER_TX = 8;

const stateOf = (s: object) => Object.keys(s)[0] as SeriesState;
const voidAfter = (s: SeriesView, v: { voidDelaySecs: number }) => `it can be voided after ${new Date((s.openTs + v.voidDelaySecs + 1) * 1000).toISOString()}`;
const hex = (bytes: number[]) => "0x" + Buffer.from(bytes).toString("hex");

type VaultProgram = ReturnType<typeof getProgram>;

/** Every series and position in the vault, as the planner sees them and as fetched. */
async function loadVault(program: VaultProgram, vault: PublicKey) {
  const byVault = [{ memcmp: { offset: 8, bytes: vault.toBase58() } }];
  const series = await program.account.series.all(byVault);
  const positions = await program.account.position.all(byVault);
  return {
    raw: new Map(series.map((s) => [s.publicKey.toBase58(), s.account])),
    series: series.map(
      (s): SeriesView => ({ address: s.publicKey.toBase58(), feedId: hex(s.account.feedId), openTs: s.account.openTs.toNumber(), state: stateOf(s.account.state) }),
    ),
    positions: positions.map((p) => ({ view: { address: p.publicKey.toBase58(), series: p.account.series.toBase58(), buyer: p.account.buyer.toBase58() } as PositionView, account: p.account })),
  };
}

// The program judges time by the cluster's clock, so the keeper does too.
const clusterNow = async (connection: Connection) => (await connection.getBlockTime(await connection.getSlot("confirmed"))) ?? Math.floor(Date.now() / 1000);

type PositionTerms = { shares: { toString(): string }; upper: { toString(): string }; lower: { toString(): string }; premium: { toString(): string } };
const terms = (p: PositionTerms) => ({ shares: BigInt(p.shares.toString()), upper: BigInt(p.upper.toString()), lower: BigInt(p.lower.toString()), premium: BigInt(p.premium.toString()) });

export async function runKeeper(opts: KeeperOptions): Promise<KeeperReport> {
  const { connection, payer, vault } = opts;
  const log = opts.log ?? (() => {});
  const program = getProgram(connection, new anchor.Wallet(payer));
  const v = await program.account.vault.fetch(vault);
  const report: KeeperReport = { settled: [], voided: [], claimed: [], waiting: [], signatures: [] };
  const load = () => loadVault(program, vault);
  const send = async (ixs: TransactionInstruction[]) => {
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [payer], { commitment: "confirmed" });
    report.signatures.push(sig);
    return sig;
  };

  let state = await load();
  const todo = plan(await clusterNow(connection), v, state.series, state.positions.map((p) => p.view));
  report.waiting.push(...todo.waiting);

  // Void what can no longer settle: every premium in it is refunded on claim.
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
      update = await settlementUpdate(opts.hermes(), s.feedId, s.openTs, v);
    } catch (e) {
      if (!(e instanceof NotYetPublished || e instanceof CannotSettle)) throw e;
      report.waiting.push({ series: s.address, reason: e instanceof CannotSettle ? `${e.message}; ${voidAfter(s, v)}` : e.message });
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

  // Claim every position in a finished series, paying each buyer's own token account.
  state = await load();
  const claims = plan(await clusterNow(connection), v, state.series, state.positions.map((p) => p.view)).claim;
  const accounts = new Map(state.positions.map((p) => [p.view.address, p.account]));
  for (let i = 0; i < claims.length; i += CLAIMS_PER_TX) {
    const batch = claims.slice(i, i + CLAIMS_PER_TX);
    const ixs: TransactionInstruction[] = [];
    for (const c of batch) {
      const buyer = new PublicKey(c.buyer);
      const buyerToken = getAssociatedTokenAddressSync(v.collateralMint, buyer, true);
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, buyerToken, buyer, v.collateralMint));
      ixs.push(
        await claimInstruction(program, {
          vault,
          series: new PublicKey(c.series),
          position: new PublicKey(c.address),
          buyer,
          collateralMint: v.collateralMint,
          buyerToken,
        }),
      );
    }
    await send(ixs);
    for (const c of batch) {
      const series = state.raw.get(c.series)!;
      const p = accounts.get(c.address)!;
      const units = claimUnits(stateOf(series.state) as Exclude<SeriesState, "open">, terms(p), BigInt(series.price.toString()), BigInt(v.collateralUnit.toString()));
      report.claimed.push({ position: c.address, buyer: c.buyer, units });
      log(`claimed ${c.address}: ${Number(units) / Number(v.collateralUnit.toString())} to ${c.buyer}`);
    }
  }
  return report;
}

export type PlannedPosition = {
  position: string;
  buyer: string;
  /** The most it can pay: the whole spread. */
  maxUnits: bigint;
  /** What a claim would pay, once the price (or a void) is known. */
  units?: bigint;
};

export type SeriesPlan = {
  series: string;
  openTs: number;
  action: "wait" | "settle" | "void" | "claim";
  /** Why the keeper will wait, or can't settle. */
  note?: string;
  /** The print the series would settle on. */
  print?: { price: number; publishTime: number };
  positions: PlannedPosition[];
};

export type KeeperPlan = { now: number; collateralUnit: bigint; series: SeriesPlan[] };

/**
 * What runKeeper would do right now, without sending anything: which series
 * it would settle (and on which print), void or leave waiting, and what each
 * position would be paid. Reads the cluster and Hermes only, and needs no
 * wallet. A print it can't fetch (no key, not published yet) becomes a note.
 */
export async function planKeeper(opts: Omit<KeeperOptions, "payer" | "log">): Promise<KeeperPlan> {
  const { connection, vault } = opts;
  // A throwaway wallet: Anchor wants one, and nothing here asks it to sign.
  const program = getProgram(connection, new anchor.Wallet(Keypair.generate()));
  const v = await program.account.vault.fetch(vault);
  const unit = BigInt(v.collateralUnit.toString());
  const state = await loadVault(program, vault);
  const now = await clusterNow(connection);
  const todo = plan(now, v, state.series, state.positions.map((p) => p.view));

  const printOf = async (s: SeriesView) => {
    const posted = opts.postedUpdate?.(s);
    if (!posted) return settlementUpdate(opts.hermes(), s.feedId, s.openTs, v);
    const info = await connection.getAccountInfo(posted);
    if (!info) throw new Error(`no price update account at ${posted.toBase58()}`);
    const m = program.coder.types.decode("priceUpdateV2", info.data.subarray(8)).priceMessage;
    const print: Print = { price: BigInt(m.price.toString()), conf: BigInt(m.conf.toString()), expo: m.exponent, publishTime: m.publishTime.toNumber(), prevPublishTime: m.prevPublishTime.toNumber() };
    const error = settlementError(print, s.openTs, v);
    if (error) throw new CannotSettle(error);
    const price8 = toPrice8(print.price, print.expo);
    return { price: Number(price8) / 1e8, price8, publishTime: print.publishTime };
  };
  const positionsIn = (series: string, units: (t: ReturnType<typeof terms>) => bigint | undefined): PlannedPosition[] =>
    state.positions
      .filter((p) => p.view.series === series)
      .map((p) => {
        const t = terms(p.account);
        // At a price of zero a position pays its whole spread.
        return { position: p.view.address, buyer: p.view.buyer, maxUnits: claimUnits("settled", t, 0n, unit), units: units(t) };
      });

  const out: SeriesPlan[] = [];
  for (const s of state.series) {
    const base = { series: s.address, openTs: s.openTs };
    const waiting = todo.waiting.find((w) => w.series === s.address);
    if (waiting) {
      out.push({ ...base, action: "wait", note: waiting.reason, positions: positionsIn(s.address, () => undefined) });
    } else if (todo.void.includes(s)) {
      out.push({ ...base, action: "void", positions: positionsIn(s.address, (t) => claimUnits("voided", t, 0n, unit)) });
    } else if (todo.settle.includes(s)) {
      try {
        const u = await printOf(s);
        out.push({ ...base, action: "settle", print: { price: u.price, publishTime: u.publishTime }, positions: positionsIn(s.address, (t) => claimUnits("settled", t, u.price8, unit)) });
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        const note = e instanceof CannotSettle ? `can't settle: ${why}; ${voidAfter(s, v)}` : e instanceof NotYetPublished ? why : `can't fetch the print: ${why}`;
        out.push({ ...base, action: "settle", note, positions: positionsIn(s.address, () => undefined) });
      }
    } else {
      const raw = state.raw.get(s.address)!;
      const positions = positionsIn(s.address, (t) => claimUnits(s.state as Exclude<SeriesState, "open">, t, BigInt(raw.price.toString()), unit));
      if (positions.length) out.push({ ...base, action: "claim", positions });
    }
  }
  return { now, collateralUnit: unit, series: out };
}
