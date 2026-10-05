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
 * genesis, as in localnet-cycle.ts.
 *
 * The vault's collateral is USDC, and the borrower also has a real loan on
 * Kamino's xStocks market, cloned from mainnet (kaminoFork.ts): TSLAx
 * deposited, USDC borrowed. Once the series settles, the borrower claims the
 * payout and repays Kamino with it in one transaction. Kamino's prices can't
 * move during a local run, so the opening's effect on the loan is computed
 * from the made-up loan; what the cloned loan shows is the payout reaching
 * Kamino's debt atomically.
 *
 *   npm run solana:replay     (needs solana-test-validator and a built program)
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import anchor from "@anchor-lang/core";
import { address } from "@solana/kit";
import { getAccount, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";

import { coverPayout, coverPlan, shortfall } from "../../app/src/lib/kaminoCover";
import type { KaminoLoan } from "../../app/src/lib/kaminoLoan";
import { signForSolana, type PricedProtection } from "../../quoter/quoter";
import tslaGaps from "../../research/data/pyth-tsla-gaps.json";
import { claimAndRepayInstructions, kaminoInstructions, loadKaminoMarket } from "../client/kamino";
import { buyInstructions, feedIdBytes, getProgram, holderOf, PROGRAM_ID, seriesAddress, settleInstruction, TSLA_FEED_ID } from "../client/vault";
import { kaminoFork, TSLAX_MINT, TSLAX_RESERVE, USDC_MINT, USDC_RESERVE, XSTOCKS_MARKET } from "./kaminoFork";

const RPC = "http://127.0.0.1:8899";
const RECEIVER = new PublicKey("rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp");
const SO = "solana/target/deploy/afterbell_vault.so";
const USD = 1_000_000n;
/** The premium in this replay is nominal; the app quotes the real one. */
const PREMIUM = 5;

/** TSLAx the borrower deposits on Kamino (8 decimals), and the USDC they borrow against it. */
const TSLAX_DEPOSIT = 30n * 10n ** 8n;
const BORROWED = 6_000n * USD;

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

  // Kamino, with USDC and TSLAx mintable by the payer and its prices fresh until a minute after the open.
  const kamino = await kaminoFork(dir, openTs + 60, payer!.publicKey);
  const validator = spawn(
    "solana-test-validator",
    ["--reset", "--quiet", "--ledger", join(dir, "ledger"), "--bpf-program", PROGRAM_ID.toBase58(), SO, "--account", priceUpdate.toBase58(), accountFile, ...kamino],
    { stdio: "ignore" },
  );
  try {
    const connection = new Connection(RPC, "confirmed");
    for (let i = 0; ; i++) {
      try {
        await connection.getVersion();
        break;
      } catch {
        if (i > 120) throw new Error("the local validator didn't start");
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    for (const k of [payer!, borrower!, keeper!]) {
      await connection.confirmTransaction(await connection.requestAirdrop(k.publicKey, 10 * LAMPORTS_PER_SOL), "confirmed");
    }

    // The vault as on devnet, with 100,000 USDC underwritten.
    const deployments = join(dir, "localnet.json");
    execFileSync("npx", ["tsx", "solana/scripts/setup.ts"], {
      env: { ...process.env, RPC_URL: RPC, ANCHOR_WALLET: payerFile, OUT: deployments, QUOTER: quoter!.publicKey.toBase58(), MINT: USDC_MINT.toBase58() },
      stdio: "inherit",
    });
    const d = JSON.parse(readFileSync(deployments, "utf8"));
    const vault = new PublicKey(d.vault);
    const mint = new PublicKey(d.collateralMint);
    const program = getProgram(connection, new anchor.Wallet(payer!));

    // The borrower's Kamino loan: TSLAx deposited, USDC borrowed against it.
    const send = (ixs: Parameters<Transaction["add"]>, signer = borrower!) => sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [signer]);
    const tslax = (await getOrCreateAssociatedTokenAccount(connection, payer!, TSLAX_MINT, borrower!.publicKey, false, "confirmed", {}, TOKEN_2022_PROGRAM_ID)).address;
    await mintTo(connection, payer!, TSLAX_MINT, tslax, payer!, TSLAX_DEPOSIT, [], {}, TOKEN_2022_PROGRAM_ID);
    const owner = { owner: borrower!.publicKey };
    await send(await kaminoInstructions(connection, await loadKaminoMarket(connection, XSTOCKS_MARKET), "deposit", { ...owner, reserve: TSLAX_RESERVE, amount: TSLAX_DEPOSIT }));
    await send(await kaminoInstructions(connection, await loadKaminoMarket(connection, XSTOCKS_MARKET), "borrow", { ...owner, reserve: USDC_RESERVE, amount: BORROWED }));
    const kaminoDebt = async () => {
      const market = await loadKaminoMarket(connection, XSTOCKS_MARKET);
      const obligation = await market.getUserVanillaObligation(address(borrower!.publicKey.toBase58()));
      return obligation.getBorrowByReserve(address(USDC_RESERVE.toBase58()))!.amount.toNumber() / 1e6;
    };
    check(true, `the borrower deposited ${Number(TSLAX_DEPOSIT) / 1e8} TSLAx on the cloned Kamino and borrowed ${usd(Number(BORROWED) / 1e6)} USDC`);

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

    // The open passes; the keeper settles at TSLA's real opening.
    for (;;) {
      const t = await connection.getBlockTime(await connection.getSlot());
      if (t !== null && t >= openTs + 2) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const seriesKey = seriesAddress(vault, feedIdBytes(TSLA_FEED_ID), BigInt(openTs));
    await send([await settleInstruction(program, { vault, series: seriesKey, priceUpdate })], keeper!);
    const series = await program.account.series.fetch(seriesKey);
    check(series.state.settled !== undefined, `the series settled at ${usd(Number(series.price.toString()) / 1e8)}, TSLA's opening on ${worst.to}`);

    // The borrower claims the payout and repays Kamino with it, in one transaction.
    const [position] = await program.account.position.all([{ memcmp: { offset: 8, bytes: vault.toBase58() } }]);
    const nft = (await holderOf(connection, position!.account.mint))!;
    const expected = shares * (upper - worst.open);
    const repay = BigInt(Math.round(expected * 1e6));
    const [walletBefore, debtBefore] = [(await getAccount(connection, token)).amount, await kaminoDebt()];
    const claimAndRepay = await claimAndRepayInstructions(
      connection,
      await loadKaminoMarket(connection, XSTOCKS_MARKET),
      [program, { keeper: borrower!.publicKey, vault, series: seriesKey, collateralMint: mint, keeperToken: token, payees: [{ position: position!.publicKey, nftAccount: nft.account, payeeToken: getAssociatedTokenAddressSync(mint, nft.owner) }] }],
      { ...owner, reserve: USDC_RESERVE, repay },
    );
    await send(claimAndRepay);
    const debtAfter = await kaminoDebt();
    const paid = debtBefore - debtAfter;
    check(Math.abs(paid - expected) < 0.01, `in one transaction, the vault paid ${usd(expected)} (${shares} × (${usd(upper)} − ${usd(worst.open)})) and Kamino's debt fell from ${usd(debtBefore)} to ${usd(debtAfter)}`);
    const kept = Number((await getAccount(connection, token)).amount - walletBefore) / 1e6;
    check(kept >= 0 && kept < 1, `the wallet kept only the ${usd(kept)} tip the vault pays whoever processes a series`);
    check(paid >= short, `which covers the ${usd(short)} the opening put the loan over its limit`);
    check(Math.abs(coverPayout(plan.lines, drop) - short) < 0.01, "auto-cover's sizing pays exactly the shortfall before rounding to whole shares");

    console.log(`\n                     without cover    with cover`);
    console.log(`  debt over limit    ${usd(short).padStart(13)}    ${usd(Math.max(0, short - paid)).padStart(10)}  (after repaying with the payout)`);
    console.log(`  liquidatable       ${"yes".padStart(13)}    ${(short - paid > 0 ? "yes" : "no").padStart(10)}`);
    console.log(`  cost of cover      ${usd(0).padStart(13)}    ${usd(PREMIUM).padStart(10)}  (nominal)`);
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
