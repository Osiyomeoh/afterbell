/**
 * A whole round of the Solana vault on a local validator, checked at every
 * step: set up a vault and underwrite its pool, sell three positions as NFTs
 * against signed quotes, move them about before the open (Alice sells hers to
 * Carol, Erin burns hers, Bob closes his TestUSD account) while Dave asks to
 * underwrite, then run the keeper: it must settle, pay each position to
 * whoever holds its NFT what the program's math says, forfeit the burned one
 * to the pool, collect its tips and roll the pool, filling Dave's deposit at
 * the pool's value after the night.
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
import {
  burnChecked,
  closeAccount,
  createAssociatedTokenAccountIdempotent,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
  transfer,
  transferChecked,
} from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";

import { signForSolana, type PricedProtection } from "../../quoter/quoter";
import {
  buyInstructions,
  claimDepositInstruction,
  feedIdBytes,
  getProgram,
  positionAddress,
  PROGRAM_ID,
  requestDepositInstruction,
  seriesAddress,
  shareMintAddress,
  token2022Account,
  TSLA_FEED_ID,
} from "../client/vault";
import { planKeeper, runKeeper } from "../keeper/keeper";

const RPC = "http://127.0.0.1:8899";
const RECEIVER = new PublicKey("rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp");
const SO = "solana/target/deploy/afterbell_vault.so";
const USD = 1_000_000n;
const SEED = 100_000n * USD;

const unusedHermes = () => {
  throw new Error("the local cycle never calls Hermes");
};

function check(ok: boolean, what: string) {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok  ${what}`);
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "afterbell-cycle-"));
  const [payer, quoter, alice, bob, carol, dave, erin, keeper] = Array.from({ length: 8 }, () => Keypair.generate());
  const payerFile = join(dir, "payer.json");
  writeFileSync(payerFile, JSON.stringify(Array.from(payer!.secretKey)));

  // The "open" is two minutes away: time to set up, underwrite and buy before it.
  const openTs = Math.floor(Date.now() / 1000) + 120;
  const priceUpdate = Keypair.generate().publicKey;
  const coder = getProgram(new Connection(RPC), new anchor.Wallet(payer!)).coder;
  const body = coder.types.encode("priceUpdateV2", {
    writeAuthority: payer!.publicKey,
    verificationLevel: { full: {} },
    priceMessage: {
      feedId: Array.from(feedIdBytes(TSLA_FEED_ID)),
      price: new anchor.BN(36_000_000), // $360.00 at expo -5, one second after the open
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
    for (const k of [payer!, alice!, bob!, carol!, dave!, erin!, keeper!]) {
      await connection.confirmTransaction(await connection.requestAirdrop(k.publicKey, 10 * LAMPORTS_PER_SOL), "confirmed");
    }
    const send = (ixs: Parameters<Transaction["add"]>, signer: Keypair) => sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [signer]);

    // Vault, TestUSD and the TSLA feed as on devnet, and 100,000 TestUSD underwritten.
    const deployments = join(dir, "localnet.json");
    execFileSync("npx", ["tsx", "solana/scripts/setup.ts"], {
      env: { ...process.env, RPC_URL: RPC, ANCHOR_WALLET: payerFile, OUT: deployments, QUOTER: quoter!.publicKey.toBase58() },
      stdio: "inherit",
    });
    const d = JSON.parse(readFileSync(deployments, "utf8"));
    const vault = new PublicKey(d.vault);
    const mint = new PublicKey(d.collateralMint);
    const program = getProgram(connection, new anchor.Wallet(payer!));
    const totalAssets = async () => {
      const v = await program.account.vault.fetch(vault);
      const held = (await getAccount(connection, new PublicKey(d.vaultToken))).amount;
      const owed = [v.pendingDepositAssets, v.reservedAssets, v.tipsOwed, v.locked].reduce((a, x) => a + BigInt(x.toString()), 0n);
      return held - owed;
    };
    check((await totalAssets()) === SEED, "the pool holds 100,000 TestUSD, underwritten by request, roll and claim");

    const tokenOf = async (who: Keypair) => (await getOrCreateAssociatedTokenAccount(connection, payer!, mint, who.publicKey)).address;
    const fund = async (who: Keypair, units: bigint) => mintTo(connection, payer!, mint, await tokenOf(who), payer!, units);

    // Three sales on the same open, each an NFT in the buyer's wallet.
    const buy = async (buyer: Keypair, shares: number, upper: number, lower: number, premium: number) => {
      await fund(buyer, 100n * USD);
      const now = Math.floor(Date.now() / 1000);
      const priced = { protection: { shares, upper, lower }, openTs, expiry: now + 30, premium } as PricedProtection;
      const signed = signForSolana(priced, buyer.publicKey.toBase58(), { programId: PROGRAM_ID.toBase58(), vault: d.vault, feedId: TSLA_FEED_ID }, quoter!.secretKey.slice(0, 32));
      const buyerProgram = getProgram(connection, new anchor.Wallet(buyer));
      const ixs = await buyInstructions(buyerProgram, { buyer: buyer.publicKey, vault, collateralMint: mint, buyerToken: await tokenOf(buyer), quote: signed.quote, ed25519Data: signed.ed25519Data });
      await send(ixs, buyer);
      const position = positionAddress(vault, signed.quote.nonce);
      return { position, mint: (await program.account.position.fetch(position)).mint };
    };
    const a = await buy(alice!, 2, 370, 340, 1.5);
    const b = await buy(bob!, 1, 355, 330, 0.5);
    const e = await buy(erin!, 1, 365, 345, 0.5);
    const nftBalance = async (who: Keypair, m: PublicKey) => (await getAccount(connection, token2022Account(who.publicKey, m), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    check((await nftBalance(alice!, a.mint)) === 1n && (await nftBalance(bob!, b.mint)) === 1n, "sold three positions against signed quotes, each an NFT in its buyer's wallet");

    // Before the open: Alice sells her NFT to Carol, Erin burns hers, Bob closes his TestUSD account.
    const carolNft = await createAssociatedTokenAccountIdempotent(connection, alice!, a.mint, carol!.publicKey, {}, TOKEN_2022_PROGRAM_ID);
    await transferChecked(connection, alice!, token2022Account(alice!.publicKey, a.mint), a.mint, carolNft, alice!, 1n, 0, [], {}, TOKEN_2022_PROGRAM_ID);
    await burnChecked(connection, erin!, token2022Account(erin!.publicKey, e.mint), e.mint, erin!, 1n, 0, [], {}, TOKEN_2022_PROGRAM_ID);
    const bobToken = await tokenOf(bob!);
    await transfer(connection, bob!, bobToken, await tokenOf(payer!), bob!, (await getAccount(connection, bobToken)).amount);
    await closeAccount(connection, bob!, bobToken, bob!.publicKey, bob!);
    check((await nftBalance(carol!, a.mint)) === 1n, "Alice's NFT now belongs to Carol; Erin burned hers; Bob closed his TestUSD account");

    // Dave asks to underwrite 1,000: it waits for the roll, out of the round's risk.
    await fund(dave!, 1_000n * USD);
    const daveProgram = getProgram(connection, new anchor.Wallet(dave!));
    await send([await requestDepositInstruction(daveProgram, { owner: dave!.publicKey, vault, collateralMint: mint, ownerToken: await tokenOf(dave!), assets: 1_000n * USD })], dave!);
    check((await program.account.vault.fetch(vault)).pendingDepositAssets.toString() === "1000000000", "Dave's 1,000 waits for the roll");

    // Before the open, the plan waits and knows only each position's cap.
    const seriesKey = seriesAddress(vault, feedIdBytes(TSLA_FEED_ID), BigInt(openTs)).toBase58();
    const plan = () => planKeeper({ connection, vault, hermes: unusedHermes, postedUpdate: () => priceUpdate });
    const early = await plan();
    const earlySeries = early.series.find((s) => s.series === seriesKey);
    check(earlySeries?.action === "wait" && earlySeries.positions.filter((p) => p.holder).every((p) => p.units === undefined), "before the open, the plan waits");
    check(earlySeries!.positions.reduce((t, p) => t + p.maxUnits, 0n) === 105n * USD, "the plan caps the payouts at 105 TestUSD: 2 × $30 + $25 + $20");
    check(early.rollBlocked?.includes("sells until its open") === true, "and the pool can't roll while the round is selling");

    // Wait for the cluster's clock to pass the open.
    for (;;) {
      const t = await connection.getBlockTime(await connection.getSlot());
      if (t !== null && t >= openTs + 2) break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    // After it, the plan names the print, each payout and its holder, and sends nothing.
    const after = await plan();
    const planned = after.series.find((s) => s.series === seriesKey);
    check(planned?.action === "settle" && planned.print?.price === 360 && planned.print.publishTime === openTs + 1, "the plan would settle on the $360.00 print");
    const byPosition = new Map(planned!.positions.map((p) => [p.position, p]));
    check(byPosition.get(a.position.toBase58())?.holder === carol!.publicKey.toBase58(), "the plan pays Alice's position to Carol, who holds it");
    check(byPosition.get(e.position.toBase58())?.holder === null, "and forfeits Erin's, whose NFT is burned");
    check(after.rollBlocked === null, "the plan would roll the pool after paying out");
    const carolBefore = (await getAccount(connection, await tokenOf(carol!))).amount;
    check((await program.account.series.fetch(new PublicKey(seriesKey))).state.open !== undefined, "planning sent nothing: the series is still open");

    const keeperToken = await tokenOf(keeper!);
    const report = await runKeeper({ connection, payer: keeper!, vault, hermes: unusedHermes, postedUpdate: () => priceUpdate, log: (line) => console.log(`    keeper: ${line}`) });

    const series = await program.account.series.fetch(new PublicKey(seriesKey));
    check(series.state.settled !== undefined && series.price.toString() === "36000000000", "the series settled at $360.00 (8 decimals)");
    const paid = new Map(report.paid.map((p) => [p.position, p]));
    check((await getAccount(connection, await tokenOf(carol!))).amount - carolBefore === 20n * USD, "Carol, holding Alice's NFT, received exactly 20 TestUSD: 2 shares × ($370 − $360)");
    check(paid.get(b.position.toBase58())?.units === 0n && (await getAccount(connection, bobToken)).amount === 0n, "Bob is owed nothing ($360 is above his $355 strike); the keeper recreated his account to close his position");
    check(paid.get(e.position.toBase58())?.holder === null, "Erin's position was forfeited: nobody holds it");
    check(report.paid.every((p) => byPosition.get(p.position)?.units === p.units) && report.paid.length === byPosition.size, "the keeper paid exactly what the plan said it would");
    check(report.tips === 50_000n && (await getAccount(connection, keeperToken)).amount === 50_000n, "the vault paid the keeper 0.05 TestUSD in tips: 2% of the 2.50 in premiums");

    const positions = await program.account.position.all([{ memcmp: { offset: 8, bytes: vault.toBase58() } }]);
    check(positions.length === 3 && positions.every((p) => p.account.closed), "all three positions are closed, and stay on-chain with their outcome");
    const v = await program.account.vault.fetch(vault);
    check(v.locked.isZero() && v.tipsOwed.isZero() && v.roundUnpaid === 0, "nothing is locked or owed any more");

    // The roll: the pool kept the premiums, less Carol's payout and the tips, plus what Erin forfeited.
    check(report.rolled?.round === 2n && v.round.toString() === "3", "the keeper rolled the pool from round 2 into round 3");
    const nav = SEED + 2_500_000n - 50_000n - 20n * USD;
    check((await totalAssets()) === nav + 1_000n * USD, "the pool is worth 99,982.45 after the night, plus Dave's 1,000");
    const supply = SEED; // the setup's 100,000 shares, one per unit
    const daveShares = (1_000n * USD * (supply + 1n)) / (nav + 1n);
    await send([await claimDepositInstruction(daveProgram, { owner: dave!.publicKey, vault })], dave!);
    const held = (await getAccount(connection, token2022Account(dave!.publicKey, shareMintAddress(vault)), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    check(held === daveShares, `Dave claimed ${Number(daveShares) / 1e6} shares for his 1,000, at the pool's value after the night`);

    const again = await runKeeper({ connection, payer: keeper!, vault, hermes: unusedHermes, postedUpdate: () => priceUpdate });
    check(again.settled.length + again.paid.length + again.voided.length === 0 && again.rolled === null, "a second keeper run finds nothing to do");
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
