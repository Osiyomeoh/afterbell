/**
 * Sets up a Solana vault after the program is deployed: a TestUSD mint with
 * no value (6 decimals), the vault, the TSLA feed, and collateral. Safe to
 * re-run: each step is skipped when it's already done, and the addresses are
 * kept in a deployments file.
 *
 *   QUOTER=<quoter pubkey> npx tsx solana/scripts/setup.ts
 *
 * RPC_URL      defaults to devnet
 * ANCHOR_WALLET the vault authority and fee payer, defaults to ~/.config/solana/id.json
 *              (the key is only loaded to sign, never printed)
 * OUT          the deployments file, defaults to solana/deployments/devnet.json
 * SEED         TestUSD to mint and deposit on the first run, defaults to 100000
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import anchor from "@anchor-lang/core";
import { createMint, getAccount, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

import {
  DEFAULT_CONFIG,
  feedConfigAddress,
  feedIdBytes,
  getProgram,
  PROGRAM_ID,
  TSLA_FEED_ID,
  vaultAddress,
  vaultTokenAddress,
  type VaultConfig,
} from "../client/vault";

const DECIMALS = 6;

type Deployment = {
  rpc: string;
  programId: string;
  authority: string;
  quoter: string;
  collateralMint: string;
  vault: string;
  vaultToken: string;
  feeds: Record<string, { feedId: string; feedConfig: string }>;
};

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name}`);
  return v;
}

async function main() {
  const rpc = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const out = process.env.OUT ?? "solana/deployments/devnet.json";
  const walletPath = process.env.ANCHOR_WALLET ?? join(homedir(), ".config/solana/id.json");
  const seedUnits = BigInt(process.env.SEED ?? "100000") * 10n ** BigInt(DECIMALS);
  const quoter = new PublicKey(required("QUOTER"));

  const connection = new Connection(rpc, "confirmed");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))));
  const program = getProgram(connection, new anchor.Wallet(payer));
  const log = (s: string) => console.log(s);

  const programInfo = await connection.getAccountInfo(PROGRAM_ID);
  if (!programInfo?.executable) throw new Error(`the program ${PROGRAM_ID.toBase58()} is not deployed at ${rpc}`);

  const previous: Partial<Deployment> = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
  if (previous.authority && previous.authority !== payer.publicKey.toBase58()) {
    throw new Error(`${out} belongs to authority ${previous.authority}, not ${payer.publicKey.toBase58()}`);
  }

  // 1. Collateral: a fresh mint the authority controls, so it can mint test dollars.
  let mint: PublicKey;
  if (previous.collateralMint) {
    mint = new PublicKey(previous.collateralMint);
    log(`TestUSD mint     ${mint.toBase58()} (existing)`);
  } else {
    mint = await createMint(connection, payer, payer.publicKey, null, DECIMALS);
    log(`TestUSD mint     ${mint.toBase58()} (created)`);
  }

  // 2. The vault.
  const vault = vaultAddress(payer.publicKey, mint);
  const vaultToken = vaultTokenAddress(vault);
  const config: VaultConfig = { quoter, ...DEFAULT_CONFIG };
  const existing = await program.account.vault.fetchNullable(vault);
  if (!existing) {
    await program.methods
      .initializeVault(config)
      .accountsPartial({
        authority: payer.publicKey,
        vault,
        collateralMint: mint,
        vaultToken,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    log(`vault            ${vault.toBase58()} (initialized)`);
  } else if (
    !existing.quoter.equals(config.quoter) ||
    existing.settleWindowSecs !== config.settleWindowSecs ||
    existing.voidDelaySecs !== config.voidDelaySecs ||
    existing.maxConfBps !== config.maxConfBps
  ) {
    await program.methods.setConfig(config).accountsPartial({ authority: payer.publicKey, vault }).rpc();
    log(`vault            ${vault.toBase58()} (config updated)`);
  } else {
    log(`vault            ${vault.toBase58()} (existing)`);
  }

  // 3. The TSLA feed.
  const feedId = feedIdBytes(TSLA_FEED_ID);
  const feedConfig = feedConfigAddress(vault, feedId);
  const feed = await program.account.feedConfig.fetchNullable(feedConfig);
  if (!feed?.allowed) {
    await program.methods
      .allowFeed(Array.from(feedId), true)
      .accountsPartial({ authority: payer.publicKey, vault, feedConfig, systemProgram: SystemProgram.programId })
      .rpc();
    log(`TSLA feed        ${feedConfig.toBase58()} (allowed)`);
  } else {
    log(`TSLA feed        ${feedConfig.toBase58()} (existing)`);
  }

  // 4. Collateral, on the first run only.
  const held = (await getAccount(connection, vaultToken)).amount;
  if (held === 0n) {
    const from = await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
    await mintTo(connection, payer, mint, from.address, payer, seedUnits);
    await program.methods
      .deposit(new anchor.BN(seedUnits.toString()))
      .accountsPartial({
        depositor: payer.publicKey,
        vault,
        collateralMint: mint,
        depositorToken: from.address,
        vaultToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  }
  const collateral = (await getAccount(connection, vaultToken)).amount;
  log(`collateral       ${Number(collateral) / 10 ** DECIMALS} TestUSD`);

  const deployment: Deployment = {
    rpc,
    programId: PROGRAM_ID.toBase58(),
    authority: payer.publicKey.toBase58(),
    quoter: quoter.toBase58(),
    collateralMint: mint.toBase58(),
    vault: vault.toBase58(),
    vaultToken: vaultToken.toBase58(),
    feeds: { TSLA: { feedId: TSLA_FEED_ID, feedConfig: feedConfig.toBase58() } },
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(deployment, null, 2) + "\n");
  log(`wrote ${out}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
