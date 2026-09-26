/**
 * A whole protection cycle on a local validator, checked at every step:
 * set up a vault, sell two positions against signed quotes, let the "open"
 * pass, run the keeper to settle and claim, and compare what each buyer
 * received with what the program's math says they're owed.
 *
 * A local validator has no Pyth receiver, so the settlement price is a
 * PriceUpdateV2 account preloaded at genesis, owned by the receiver program,
 * whose print lands one second after an "open" set a little in the future.
 * Posting real updates from Hermes is exercised on devnet.
 *
 *   npm run solana:cycle      (needs solana-test-validator and a built program)
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import anchor from "@anchor-lang/core";
import { closeAccount, getAccount, getOrCreateAssociatedTokenAccount, mintTo, transfer } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";

import { signForSolana, type PricedProtection } from "../../quoter/quoter";
import { buyInstructions, feedIdBytes, getProgram, PROGRAM_ID, seriesAddress, TSLA_FEED_ID } from "../client/vault";
import { runKeeper } from "../keeper/keeper";

const RPC = "http://127.0.0.1:8899";
const RECEIVER = new PublicKey("rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp");
const SO = "solana/target/deploy/afterbell_vault.so";

function check(ok: boolean, what: string) {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok  ${what}`);
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "afterbell-cycle-"));
  const [payer, quoter, alice, bob] = [0, 1, 2, 3].map(() => Keypair.generate());
  const payerFile = join(dir, "payer.json");
  writeFileSync(payerFile, JSON.stringify(Array.from(payer!.secretKey)));

  // The "open" is 75 s away: time to set up and buy before it.
  const openTs = Math.floor(Date.now() / 1000) + 75;
  const settlementPrice = 360; // $360.00, published one second after the open
  const priceUpdate = Keypair.generate().publicKey;
  const coder = getProgram(new Connection(RPC), new anchor.Wallet(payer!)).coder;
  const body = coder.types.encode("priceUpdateV2", {
    writeAuthority: payer!.publicKey,
    verificationLevel: { full: {} },
    priceMessage: {
      feedId: Array.from(feedIdBytes(TSLA_FEED_ID)),
      price: new anchor.BN(36_000_000),
      conf: new anchor.BN(1_000),
      exponent: -5,
      publishTime: new anchor.BN(openTs + 1),
      prevPublishTime: new anchor.BN(openTs - 1),
      emaPrice: new anchor.BN(36_000_000),
      emaConf: new anchor.BN(1_000),
    },
    postedSlot: new anchor.BN(1),
  });
  const discriminator = createHash("sha256").update("account:PriceUpdateV2").digest().subarray(0, 8);
  const data = Buffer.concat([discriminator, body]);
  const accountFile = join(dir, "price-update.json");
  writeFileSync(
    accountFile,
    JSON.stringify({
      pubkey: priceUpdate.toBase58(),
      account: { lamports: LAMPORTS_PER_SOL, data: [data.toString("base64"), "base64"], owner: RECEIVER.toBase58(), executable: false, rentEpoch: 0, space: data.length },
    }),
  );

  const validator = spawn(
    "solana-test-validator",
    ["--reset", "--quiet", "--ledger", join(dir, "ledger"), "--bpf-program", PROGRAM_ID.toBase58(), SO, "--account", priceUpdate.toBase58(), accountFile],
    { stdio: "ignore" },
  );
  try {
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
    for (const k of [payer!, alice!, bob!]) await connection.confirmTransaction(await connection.requestAirdrop(k.publicKey, 10 * LAMPORTS_PER_SOL), "confirmed");

    // Vault, TestUSD and the TSLA feed, as on devnet.
    const deployments = join(dir, "localnet.json");
    execFileSync("npx", ["tsx", "solana/scripts/setup.ts"], {
      env: { ...process.env, RPC_URL: RPC, ANCHOR_WALLET: payerFile, OUT: deployments, QUOTER: quoter!.publicKey.toBase58() },
      stdio: "inherit",
    });
    const d = JSON.parse(readFileSync(deployments, "utf8"));
    const vault = new PublicKey(d.vault);
    const mint = new PublicKey(d.collateralMint);

    // Two sales on the same open: Alice's pays below $370, Bob's only below $355.
    const buy = async (buyer: Keypair, shares: number, upper: number, lower: number, premium: number) => {
      const token = await getOrCreateAssociatedTokenAccount(connection, payer!, mint, buyer.publicKey);
      await mintTo(connection, payer!, mint, token.address, payer!, 100_000_000n);
      const now = Math.floor(Date.now() / 1000);
      const priced = { protection: { shares, upper, lower }, openTs, expiry: now + 30, premium } as PricedProtection;
      const signed = signForSolana(priced, buyer.publicKey.toBase58(), { programId: PROGRAM_ID.toBase58(), vault: d.vault, feedId: TSLA_FEED_ID }, quoter!.secretKey.slice(0, 32));
      const program = getProgram(connection, new anchor.Wallet(buyer));
      const ixs = await buyInstructions(program, { buyer: buyer.publicKey, vault, collateralMint: mint, buyerToken: token.address, quote: signed.quote, ed25519Data: signed.ed25519Data });
      await sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [buyer]);
      return token.address;
    };
    const aliceToken = await buy(alice!, 2, 370, 340, 1.5);
    const bobToken = await buy(bob!, 1, 355, 330, 0.5);
    // Bob empties and closes his TestUSD account: the keeper must recreate it to pay him.
    const payerToken = await getOrCreateAssociatedTokenAccount(connection, payer!, mint, payer!.publicKey);
    await transfer(connection, bob!, bobToken, payerToken.address, bob!, (await getAccount(connection, bobToken)).amount);
    await closeAccount(connection, bob!, bobToken, bob!.publicKey, bob!);
    check(true, "sold two positions against signed quotes; Bob closed his token account");

    // Wait for the cluster's clock to pass the open.
    const aliceBefore = (await getAccount(connection, aliceToken)).amount;
    for (;;) {
      const t = await connection.getBlockTime(await connection.getSlot());
      if (t !== null && t >= openTs + 2) break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    const report = await runKeeper({
      connection,
      payer: payer!,
      vault,
      hermes: () => {
        throw new Error("the local cycle never calls Hermes");
      },
      postedUpdate: () => priceUpdate,
      log: (line) => console.log(`    keeper: ${line}`),
    });

    const program = getProgram(connection, new anchor.Wallet(payer!));
    const series = await program.account.series.fetch(seriesAddress(vault, feedIdBytes(TSLA_FEED_ID), BigInt(openTs)));
    check("settled" in series.state && series.price.toString() === "36000000000", "the series settled at $360.00 (8 decimals)");
    const paid = new Map(report.claimed.map((c) => [c.buyer, c.units]));
    check(paid.get(alice!.publicKey.toBase58()) === 20_000_000n, "the keeper reports Alice is owed 20 TestUSD: 2 shares × ($370 − $360)");
    check((await getAccount(connection, aliceToken)).amount - aliceBefore === 20_000_000n, "Alice's account received exactly 20 TestUSD");
    check(paid.get(bob!.publicKey.toBase58()) === 0n, "Bob is owed nothing: $360 is above his $355 strike");
    check((await getAccount(connection, bobToken)).amount === 0n, "the keeper recreated Bob's token account to claim for him");
    check((await program.account.position.all([{ memcmp: { offset: 8, bytes: vault.toBase58() } }])).length === 0, "both positions are closed");
    const v = await program.account.vault.fetch(vault);
    check(v.locked.toString() === "0", "the vault has no collateral locked any more");

    const again = await runKeeper({ connection, payer: payer!, vault, hermes: () => { throw new Error("unused"); }, postedUpdate: () => priceUpdate });
    check(again.settled.length + again.claimed.length + again.voided.length === 0, "a second keeper run finds nothing to do");
    console.log("PASS");
  } finally {
    validator.kill();
  }
}

// Exit explicitly: web3.js keeps retrying its websocket once the validator is gone.
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    if (e?.logs) console.error(e.logs.join("\n"));
    process.exit(1);
  },
);
