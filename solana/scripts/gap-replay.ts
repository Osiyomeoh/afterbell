/**
 * TSLA's worst recorded opening, replayed against a Kamino-style loan on a
 * local validator running the vault program: the loan, the cover auto-cover
 * sizes for it, a real buy against a signed quote, and a settle at the price
 * TSLA actually opened at. Side by side, what the opening leaves the loan
 * short without cover, and what the vault pays toward it with.
 *
 * The opening is TSLA's on 23 Jul 2026 (research/data/pyth-tsla-gaps.json):
 * $374.07 at the close, $341.13 at the open, 8.8% down. The loan is made up
 * and isn't on Kamino: $10,000 of TSLA at a 70% liquidation threshold with
 * $6,650 borrowed, so it can be liquidated from a 5% gap. A local validator
 * has no Pyth receiver, so the print is a PriceUpdateV2 account preloaded at
 * genesis, as in localnet-cycle.ts. Repaying Kamino from the payout isn't
 * built yet: the payout lands in the borrower's wallet.
 *
 *   npm run solana:replay     (needs solana-test-validator and a built program)
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import anchor from "@anchor-lang/core";
import { getAccount, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";

import { coverPayout, coverPlan, shortfall } from "../../app/src/lib/kaminoCover";
import type { KaminoLoan } from "../../app/src/lib/kaminoLoan";
import { signForSolana, type PricedProtection } from "../../quoter/quoter";
import tslaGaps from "../../research/data/pyth-tsla-gaps.json";
import { buyInstructions, feedIdBytes, getProgram, PROGRAM_ID, seriesAddress, TSLA_FEED_ID } from "../client/vault";
import { runKeeper } from "../keeper/keeper";

const RPC = "http://127.0.0.1:8899";
const RECEIVER = new PublicKey("rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp");
const SO = "solana/target/deploy/afterbell_vault.so";
const USD = 1_000_000n;
/** The premium in this replay is nominal; the app quotes the real one. */
const PREMIUM = 5;

const unusedHermes = () => {
  throw new Error("the replay never calls Hermes");
};

function check(ok: boolean, what: string) {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok  ${what}`);
}

const usd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cents = (v: number) => Math.round(v * 100) / 100;

async function main() {
  // The opening: TSLA's worst on record.
  type Gap = { to: string; close: number; open: number };
  const worst = (tslaGaps.gaps as Gap[]).reduce((w, g) => (g.open / g.close < w.open / w.close ? g : w));
  const drop = 1 - worst.open / worst.close;

  // The loan and the cover auto-cover sizes for it.
  const loan: KaminoLoan = { obligation: "replay", market: "replay", debtUsd: 6650, liquidationLimitUsd: 7000, depositUsd: 10_000, stocks: [{ symbol: "TSLA", usd: 10_000 }] };
  const plan = coverPlan(loan);
  if (plan.action !== "cover") throw new Error(`no cover: ${plan.reason}`);
  const line = plan.lines[0]!;
  const shares = Math.ceil(line.notionalUsd / worst.close);
  const upper = cents(worst.close * (1 - line.startBps / 10_000));
  const lower = cents(worst.close * (1 - (line.startBps + line.depthBps) / 10_000));
  const short = shortfall(loan, drop);

  console.log(`\nTSLA ${worst.to}: closed ${usd(worst.close)}, opened ${usd(worst.open)}, ${(drop * 100).toFixed(1)}% down`);
  console.log(`Loan: ${usd(10_000)} of TSLA, ${usd(loan.debtUsd)} borrowed, liquidatable from a ${(plan.gap * 100).toFixed(1)}% gap`);
  console.log(`Cover: ${shares} shares, paying from ${usd(upper)} down to ${usd(lower)}\n`);

  const dir = mkdtempSync(join(tmpdir(), "afterbell-replay-"));
  const [payer, quoter, borrower, keeper] = Array.from({ length: 4 }, () => Keypair.generate());
  const payerFile = join(dir, "payer.json");
  writeFileSync(payerFile, JSON.stringify(Array.from(payer!.secretKey)));

  // The print TSLA opened at, one second after an "open" two minutes away.
  const openTs = Math.floor(Date.now() / 1000) + 120;
  const priceUpdate = Keypair.generate().publicKey;
  const printed = Math.round(worst.open * 1e5);
  const coder = getProgram(new Connection(RPC), new anchor.Wallet(payer!)).coder;
  const body = coder.types.encode("priceUpdateV2", {
    writeAuthority: payer!.publicKey,
    verificationLevel: { full: {} },
    priceMessage: {
      feedId: Array.from(feedIdBytes(TSLA_FEED_ID)),
      price: new anchor.BN(printed),
      conf: new anchor.BN(1_000),
      exponent: -5,
      publishTime: new anchor.BN(openTs + 1),
      prevPublishTime: new anchor.BN(openTs - 1),
      emaPrice: new anchor.BN(printed),
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
    for (const k of [payer!, borrower!, keeper!]) {
      await connection.confirmTransaction(await connection.requestAirdrop(k.publicKey, 10 * LAMPORTS_PER_SOL), "confirmed");
    }

    // The vault as on devnet, with 100,000 TestUSD underwritten.
    const deployments = join(dir, "localnet.json");
    execFileSync("npx", ["tsx", "solana/scripts/setup.ts"], {
      env: { ...process.env, RPC_URL: RPC, ANCHOR_WALLET: payerFile, OUT: deployments, QUOTER: quoter!.publicKey.toBase58() },
      stdio: "inherit",
    });
    const d = JSON.parse(readFileSync(deployments, "utf8"));
    const vault = new PublicKey(d.vault);
    const mint = new PublicKey(d.collateralMint);
    const program = getProgram(connection, new anchor.Wallet(payer!));

    // The borrower buys the cover against a signed quote.
    const token = (await getOrCreateAssociatedTokenAccount(connection, payer!, mint, borrower!.publicKey)).address;
    await mintTo(connection, payer!, mint, token, payer!, 100n * USD);
    const now = Math.floor(Date.now() / 1000);
    const priced = { protection: { shares, upper, lower }, openTs, expiry: now + 30, premium: PREMIUM } as PricedProtection;
    const signed = signForSolana(priced, borrower!.publicKey.toBase58(), { programId: PROGRAM_ID.toBase58(), vault: d.vault, feedId: TSLA_FEED_ID }, quoter!.secretKey.slice(0, 32));
    const ixs = await buyInstructions(getProgram(connection, new anchor.Wallet(borrower!)), {
      buyer: borrower!.publicKey,
      vault,
      collateralMint: mint,
      buyerToken: token,
      quote: signed.quote,
      ed25519Data: signed.ed25519Data,
    });
    await sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [borrower!]);
    check(true, `the borrower bought ${shares} shares of cover for ${usd(PREMIUM)} (nominal)`);

    // The open passes; the keeper settles at TSLA's real opening and pays.
    for (;;) {
      const t = await connection.getBlockTime(await connection.getSlot());
      if (t !== null && t >= openTs + 2) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const before = (await getAccount(connection, token)).amount;
    await runKeeper({ connection, payer: keeper!, vault, hermes: unusedHermes, postedUpdate: () => priceUpdate, log: (l) => console.log(`    keeper: ${l}`) });
    const series = await program.account.series.fetch(seriesAddress(vault, feedIdBytes(TSLA_FEED_ID), BigInt(openTs)));
    check(series.state.settled !== undefined, `the series settled at ${usd(Number(series.price.toString()) / 1e8)}, TSLA's opening on ${worst.to}`);
    const paid = Number((await getAccount(connection, token)).amount - before) / 1e6;
    const expected = shares * (upper - worst.open);
    check(Math.abs(paid - expected) < 0.01, `the vault paid the borrower ${usd(paid)}: ${shares} × (${usd(upper)} − ${usd(worst.open)})`);
    check(paid >= short, `which covers the ${usd(short)} the opening put the loan over its limit`);
    check(Math.abs(coverPayout(plan.lines, drop) - short) < 0.01, "auto-cover's sizing pays exactly the shortfall before rounding to whole shares");

    console.log(`\n                     without cover    with cover`);
    console.log(`  debt over limit    ${usd(short).padStart(13)}    ${usd(Math.max(0, short - paid)).padStart(10)}  (after repaying with the payout)`);
    console.log(`  liquidatable       ${"yes".padStart(13)}    ${(short - paid > 0 ? "yes" : "no").padStart(10)}`);
    console.log(`  cost of cover      ${usd(0).padStart(13)}    ${usd(PREMIUM).padStart(10)}  (nominal)`);
    console.log(`\nRepaying Kamino from the payout in the same transaction isn't built yet; here the payout lands in the borrower's wallet.`);
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
