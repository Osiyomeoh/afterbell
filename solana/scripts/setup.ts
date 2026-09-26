/**
 * Sets up a Solana vault after the program is deployed: a TestUSD mint with
 * no value (6 decimals), the vault and its pool's share mint, a feed for each
 * stock Solana can settle (named by ticker, for the NFTs), and the pool's
 * first underwriting. Safe to re-run: each step is skipped when it's already
 * done, and the addresses are kept in a deployments file.
 *
 *   QUOTER=<quoter pubkey> npx tsx solana/scripts/setup.ts
 *
 * RPC_URL      defaults to devnet
 * ANCHOR_WALLET the vault authority and fee payer, defaults to ~/.config/solana/id.json
 *              (the key is only loaded to sign, never printed)
 * OUT          the deployments file, defaults to solana/deployments/devnet.json
 * MINT         an existing TestUSD mint to use; otherwise one is created
 * SEED         TestUSD to underwrite on the first run, defaults to 100000; the authority
 *              mints it if it holds the mint's authority, else must already hold it
 * ART_URI      where position NFTs' images are served (the vault appends the position's
 *              address); defaults to the local app, until the app is hosted
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import anchor from "@anchor-lang/core";
import { createMint, getAccount, getMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";

import {
  claimDepositInstruction,
  DEFAULT_PARAMS,
  feedConfigAddress,
  feedIdBytes,
  getProgram,
  PROGRAM_ID,
  requestDepositInstruction,
  rollInstruction,
  shareEscrowAddress,
  shareMintAddress,
  vaultAddress,
  vaultTokenAddress,
  type VaultParams,
} from "../client/vault";
import { STOCKS } from "../../quoter/stocks";

const DECIMALS = 6;
const LOCAL_ART = "http://localhost:3100/api/position-art/solana/";

type Deployment = {
  rpc: string;
  programId: string;
  authority: string;
  quoter: string;
  collateralMint: string;
  vault: string;
  vaultToken: string;
  shareMint: string;
  shareEscrow: string;
  artUri: string;
  feeds: Record<string, { feedId: string; feedConfig: string }>;
};

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name}`);
  return v;
}

const sameParams = (a: VaultParams, b: VaultParams) => (Object.keys(a) as (keyof VaultParams)[]).every((k) => a[k] === b[k]);

async function main() {
  const rpc = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const out = process.env.OUT ?? "solana/deployments/devnet.json";
  const walletPath = process.env.ANCHOR_WALLET ?? join(homedir(), ".config/solana/id.json");
  const seedUnits = BigInt(process.env.SEED ?? "100000") * 10n ** BigInt(DECIMALS);
  const artUri = process.env.ART_URI ?? LOCAL_ART;
  const quoter = new PublicKey(required("QUOTER"));

  const connection = new Connection(rpc, "confirmed");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))));
  const program = getProgram(connection, new anchor.Wallet(payer));
  const log = (s: string) => console.log(s);
  const send = (ixs: TransactionInstruction[]) => sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [payer], { commitment: "confirmed" });

  const programInfo = await connection.getAccountInfo(PROGRAM_ID);
  if (!programInfo?.executable) throw new Error(`the program ${PROGRAM_ID.toBase58()} is not deployed at ${rpc}`);

  const previous: Partial<Deployment> = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
  if (previous.authority && previous.authority !== payer.publicKey.toBase58()) {
    throw new Error(`${out} belongs to authority ${previous.authority}, not ${payer.publicKey.toBase58()}`);
  }

  // 1. Collateral: an existing TestUSD mint, or a fresh one the authority controls.
  let mint: PublicKey;
  const existingMint = process.env.MINT ?? previous.collateralMint;
  if (existingMint) {
    mint = new PublicKey(existingMint);
    log(`TestUSD mint     ${mint.toBase58()} (existing)`);
  } else {
    mint = await createMint(connection, payer, payer.publicKey, null, DECIMALS);
    log(`TestUSD mint     ${mint.toBase58()} (created)`);
  }

  // 2. The vault, with its pool's share mint and escrow.
  const vault = vaultAddress(payer.publicKey, mint);
  const [vaultToken, shareMint, shareEscrow] = [vaultTokenAddress(vault), shareMintAddress(vault), shareEscrowAddress(vault)];
  const existing = await program.account.vault.fetchNullable(vault);
  if (!existing) {
    await program.methods
      .initializeVault(quoter, DEFAULT_PARAMS, artUri)
      .accountsPartial({
        authority: payer.publicKey,
        vault,
        collateralMint: mint,
        vaultToken,
        shareMint,
        shareEscrow,
        tokenProgram: TOKEN_PROGRAM_ID,
        shareTokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    log(`vault            ${vault.toBase58()} (initialized)`);
  } else {
    const changes: string[] = [];
    if (!existing.quoter.equals(quoter)) {
      await program.methods.setQuoter(quoter).accountsPartial({ authority: payer.publicKey, vault }).rpc();
      changes.push("quoter");
    }
    // Params wait for the next roll, so a round finishes on the rules it started with.
    const current = (existing.paramsQueued ? existing.nextParams : existing.params) as VaultParams;
    if (!sameParams(current, DEFAULT_PARAMS)) {
      await program.methods.setParams(DEFAULT_PARAMS).accountsPartial({ authority: payer.publicKey, vault }).rpc();
      changes.push("params (from the next roll)");
    }
    if (existing.artUri !== artUri) {
      await program.methods.setArtUri(artUri).accountsPartial({ authority: payer.publicKey, vault }).rpc();
      changes.push("art address");
    }
    log(`vault            ${vault.toBase58()} (${changes.length ? `updated: ${changes.join(", ")}` : "existing"})`);
  }
  if (artUri === LOCAL_ART) log(`art address      ${artUri} (the local app; set ART_URI once the app is hosted)`);

  // 3. A feed for each stock Solana can settle: those whose Pyth prints the keeper can fetch.
  const feeds: Deployment["feeds"] = {};
  for (const stock of STOCKS.filter((s) => s.pyth)) {
    const feedId = feedIdBytes(stock.feedId);
    const feedConfig = feedConfigAddress(vault, feedId);
    const feed = await program.account.feedConfig.fetchNullable(feedConfig);
    if (!feed?.allowed || feed.symbol !== stock.symbol) {
      await program.methods
        .allowFeed(Array.from(feedId), stock.symbol, true)
        .accountsPartial({ authority: payer.publicKey, vault, feedConfig, systemProgram: SystemProgram.programId })
        .rpc();
    }
    log(`${`${stock.symbol} feed`.padEnd(17)}${feedConfig.toBase58()} (${feed?.allowed ? "existing" : "allowed"})`);
    feeds[stock.symbol] = { feedId: stock.feedId, feedConfig: feedConfig.toBase58() };
  }

  // 4. The pool's first underwriting, as anyone underwrites: a request, a roll, and a claim of the shares.
  const supply = (await getMint(connection, shareMint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
  const v = await program.account.vault.fetch(vault);
  if (supply === 0n && v.pendingDepositAssets.isZero()) {
    const from = await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
    const mintAuthority = (await getMint(connection, mint)).mintAuthority;
    if (mintAuthority?.equals(payer.publicKey)) await mintTo(connection, payer, mint, from.address, payer, seedUnits);
    const held = (await getAccount(connection, from.address)).amount;
    if (held < seedUnits) throw new Error(`the authority holds ${held} TestUSD units, less than SEED (${seedUnits}), and can't mint more`);
    await send([await requestDepositInstruction(program, { owner: payer.publicKey, vault, collateralMint: mint, ownerToken: from.address, assets: seedUnits })]);
    log(`pool             requested ${Number(seedUnits) / 10 ** DECIMALS} TestUSD`);
  }
  const now = await program.account.vault.fetch(vault);
  if (supply === 0n && now.roundOpenTs.isZero() && !now.pendingDepositAssets.isZero()) {
    await send([await rollInstruction(program, { payer: payer.publicKey, vault, round: BigInt(now.round.toString()) })]);
    await send([await claimDepositInstruction(program, { owner: payer.publicKey, vault })]);
    log(`pool             rolled round ${now.round.toString()} and claimed the shares`);
  }
  const pool = (await getMint(connection, shareMint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
  log(`pool shares      ${Number(pool) / 10 ** DECIMALS}`);

  const deployment: Deployment = {
    rpc,
    programId: PROGRAM_ID.toBase58(),
    authority: payer.publicKey.toBase58(),
    quoter: quoter.toBase58(),
    collateralMint: mint.toBase58(),
    vault: vault.toBase58(),
    vaultToken: vaultToken.toBase58(),
    shareMint: shareMint.toBase58(),
    shareEscrow: shareEscrow.toBase58(),
    artUri,
    feeds,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(deployment, null, 2) + "\n");
  log(`wrote ${out}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
