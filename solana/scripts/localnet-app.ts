/**
 * A Solana vault v2 on a local validator for trying the app against, left
 * running until Ctrl-C. It sets the vault up and underwrites its pool; a
 * holder asks to underwrite 250 TestUSD and buys two positions on an "open" a
 * minute away, which settle there on a preloaded Pyth print ($355.00) without
 * being paid out. The app then shows a settled round waiting to be claimed,
 * and once the round is paid and rolled (npm run solana:keeper), the holder's
 * filled deposit to claim and the real next open on sale.
 *
 * The keys are throwaway ones in a temporary directory (the payer is also
 * TestUSD's mint authority, so it's the faucet); the script prints their
 * paths and the environment to run the app with, never their contents.
 *
 *   npm run solana:local      (needs solana-test-validator and a built program)
 *
 * PORT   the app's port, for the NFTs' art address (default 3100)
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import anchor from "@anchor-lang/core";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";

import { signForSolana, type PricedProtection } from "../../quoter/quoter";
import { buyInstructions, feedIdBytes, getProgram, PROGRAM_ID, requestDepositInstruction, seriesAddress, settleInstruction, TSLA_FEED_ID } from "../client/vault";

const RPC = "http://127.0.0.1:8899";
const RECEIVER = new PublicKey("rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp");
const SO = "solana/target/deploy/afterbell_vault.so";
const OUT = "solana/deployments/local.json";
const USD = 1_000_000n;

let validator: ChildProcess | undefined;

async function main() {
  const port = process.env.PORT ?? "3100";
  const dir = mkdtempSync(join(tmpdir(), "afterbell-local-"));
  const [payer, quoter, holder] = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  const file = (name: string, k: Keypair) => {
    const path = join(dir, `${name}.json`);
    writeFileSync(path, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 });
    return path;
  };
  const payerFile = file("payer", payer);
  const quoterFile = file("quoter", quoter);
  const holderFile = file("holder", holder);

  // The settlement print, preloaded at genesis: a local validator has no Pyth receiver.
  const openTs = Math.floor(Date.now() / 1000) + 60;
  const priceUpdate = Keypair.generate().publicKey;
  const coder = getProgram(new Connection(RPC), new anchor.Wallet(payer)).coder;
  const body = coder.types.encode("priceUpdateV2", {
    writeAuthority: payer.publicKey,
    verificationLevel: { full: {} },
    priceMessage: {
      feedId: Array.from(feedIdBytes(TSLA_FEED_ID)),
      price: new anchor.BN(35_500_000), // $355.00 at expo -5, one second after the open
      conf: new anchor.BN(1_000),
      exponent: -5,
      publishTime: new anchor.BN(openTs + 1),
      prevPublishTime: new anchor.BN(openTs - 1),
      emaPrice: new anchor.BN(35_500_000),
      emaConf: new anchor.BN(1_000),
    },
    postedSlot: new anchor.BN(1),
  });
  const data = Buffer.concat([createHash("sha256").update("account:PriceUpdateV2").digest().subarray(0, 8), body]);
  const accountFile = join(dir, "price-update.json");
  writeFileSync(
    accountFile,
    JSON.stringify({
      pubkey: priceUpdate.toBase58(),
      account: { lamports: LAMPORTS_PER_SOL, data: [data.toString("base64"), "base64"], owner: RECEIVER.toBase58(), executable: false, rentEpoch: 0, space: data.length },
    }),
  );

  validator = spawn(
    "solana-test-validator",
    ["--reset", "--quiet", "--ledger", join(dir, "ledger"), "--bpf-program", PROGRAM_ID.toBase58(), SO, "--account", priceUpdate.toBase58(), accountFile],
    { stdio: "ignore" },
  );
  const stop = () => {
    validator?.kill();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const connection = new Connection(RPC, "confirmed");
  for (let i = 0; ; i++) {
    try {
      await connection.getVersion();
      break;
    } catch {
      if (i > 60) throw new Error("the local validator didn't start");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  for (const k of [payer, holder]) await connection.confirmTransaction(await connection.requestAirdrop(k.publicKey, 10 * LAMPORTS_PER_SOL), "confirmed");

  // Vault, TestUSD and the TSLA feed as on devnet, and 100,000 TestUSD underwritten. A new
  // validator each run, so the last run's record goes.
  rmSync(OUT, { force: true });
  execFileSync("npx", ["tsx", "solana/scripts/setup.ts"], {
    env: { ...process.env, RPC_URL: RPC, ANCHOR_WALLET: payerFile, OUT, QUOTER: quoter.publicKey.toBase58(), ART_URI: `http://localhost:${port}/api/position-art/solana/` },
    stdio: "inherit",
  });
  const d = JSON.parse(readFileSync(OUT, "utf8"));
  const vault = new PublicKey(d.vault);
  const mint = new PublicKey(d.collateralMint);

  // The holder gets 1,000 TestUSD, asks to underwrite 250 and buys two positions on the local open.
  const holderToken = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, holder.publicKey)).address;
  await mintTo(connection, payer, mint, holderToken, payer, 1_000n * USD);
  const program = getProgram(connection, new anchor.Wallet(holder));
  const deposit = await requestDepositInstruction(program, { owner: holder.publicKey, vault, collateralMint: mint, ownerToken: holderToken, assets: 250n * USD });
  await sendAndConfirmTransaction(connection, new Transaction().add(deposit), [holder]);
  for (const [shares, upper, lower, premium] of [
    [10, 360, 340, 20],
    [2, 350, 330, 1.5],
  ] as const) {
    const priced = { protection: { shares, upper, lower }, openTs, expiry: Math.floor(Date.now() / 1000) + 30, premium } as PricedProtection;
    const signed = signForSolana(priced, holder.publicKey.toBase58(), { programId: PROGRAM_ID.toBase58(), vault: d.vault, feedId: TSLA_FEED_ID }, quoter.secretKey.slice(0, 32));
    const ixs = await buyInstructions(program, { buyer: holder.publicKey, vault, collateralMint: mint, buyerToken: holderToken, quote: signed.quote, ed25519Data: signed.ed25519Data });
    await sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [holder]);
  }
  console.log(`sold the holder two positions on the open at ${new Date(openTs * 1000).toISOString()}`);

  // Settle once the open has passed (the validator's clock follows the wall clock).
  while (Math.floor(Date.now() / 1000) < openTs + 3) await new Promise((r) => setTimeout(r, 1000));
  const series = seriesAddress(vault, feedIdBytes(TSLA_FEED_ID), BigInt(openTs));
  await sendAndConfirmTransaction(connection, new Transaction().add(await settleInstruction(program, { vault, series, priceUpdate })), [holder]);
  console.log("settled at $355.00; nothing paid out yet");

  const env = {
    SOLANA_DEPLOYMENT_FILE: resolve(OUT),
    SOLANA_RPC: RPC,
    NEXT_PUBLIC_SOLANA_RPC: RPC,
    QUOTER_SOLANA_KEY_FILE: quoterFile,
    FAUCET_SOLANA_KEY_FILE: payerFile,
  };
  console.log(`\nlocal vault ready: ${d.vault}\nrun the app with\n  ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" \\\n  ")}`);
  console.log(`the holder's key (for scripts): ${holderFile}\nthe payer's key (keeper, faucet): ${payerFile}\nCtrl-C stops the validator.`);
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  validator?.kill();
  process.exit(1);
});
