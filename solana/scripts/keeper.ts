/**
 * Runs the keeper once over a vault: settle due series on Pyth's first print
 * after the open, void what can't settle, pay every finished position to
 * whoever holds its NFT (the vault tips the keeper), roll the pool once
 * the round is paid, then renew every standing order for the next open.
 *
 *   PYTH_API_KEY=<your key> npm run solana:keeper
 *   PYTH_API_KEY=<your key> npm run solana:keeper -- --plan   # read-only: what it would do, and pay
 *   PYTH_API_KEY=<your key> npm run solana:keeper -- --no-pay # settle and void, but let holders claim
 *                                                             # (and repay a Kamino loan with the payout)
 *
 * RPC_URL        defaults to devnet
 * ANCHOR_WALLET  pays the fees (any funded wallet), defaults to ~/.config/solana/id.json
 * DEPLOYMENTS    defaults to solana/deployments/devnet.json
 * PYTH_API_KEY   read from the environment, only when a series is due or an order renews
 * AFTERBELL_URL  the quote service for standing orders, defaults to the hosted app
 *
 * --plan sends nothing and needs no wallet. It shows the payer's balance when
 * ANCHOR_WALLET exists, and without PYTH_API_KEY it still lists every series
 * and position, noting that it couldn't fetch the print.
 */
import { existsSync, readFileSync } from "node:fs";

import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

import { AfterbellClient } from "../../sdk/client";
import { planKeeper, runKeeper, type KeeperPlan } from "../keeper/keeper";
import { hermesFromEnv } from "../keeper/pyth";
import { kaminoSizer } from "../keeper/kaminoSize";
import { renewOrders, type RenewalPlan } from "../keeper/renew";
import { iso, loadKeypair, walletPath as defaultWallet } from "./common";

function printPlan(p: KeeperPlan) {
  const amount = (units: bigint) => (Number(units) / Number(p.collateralUnit)).toFixed(2);
  console.log(`cluster time  ${iso(p.now)}`);
  if (p.series.length === 0) console.log("\nno series with anything to do");
  for (const s of p.series) {
    console.log(`\n${s.action.toUpperCase()} series ${s.series}, open ${iso(s.openTs)}`);
    if (s.print) console.log(`  on $${s.print.price} published ${iso(s.print.publishTime)}, ${s.print.publishTime - s.openTs}s after the open`);
    if (s.note) console.log(`  ${s.note}`);
    for (const x of s.positions) {
      const to = x.holder ? `to its holder ${x.holder}` : "forfeited (its NFT was burned)";
      console.log(`  ${x.position} ${to}: ${x.units === undefined ? `up to ${amount(x.maxUnits)}` : `${amount(x.units)} (at most ${amount(x.maxUnits)})`}`);
    }
    const max = s.positions.reduce((a, x) => a + x.maxUnits, 0n);
    const known = s.positions.every((x) => x.units !== undefined);
    const pays = known ? `pays ${amount(s.positions.reduce((a, x) => a + x.units!, 0n))}` : "pays unknown until the print";
    console.log(`  ${s.positions.length} position(s): ${pays}, at most ${amount(max)}`);
  }
  console.log(`\nROLL ${p.rollBlocked === null ? "the pool rolls into its next round after this run" : `not yet: ${p.rollBlocked}`}`);
}

function printRenewals(plans: RenewalPlan[]) {
  if (plans.length === 0) return console.log("\nRENEW no standing orders");
  for (const r of plans) {
    const what = r.decision.action === "renew" ? `RENEW for the open at ${iso(r.openTs!)}, $${r.premium!.toFixed(2)}` : `SKIP ${r.decision.reason}`;
    console.log(`\n${what}\n  order ${r.order.address}, ${r.symbol} for ${r.order.holder}`);
  }
}

async function main() {
  const rpc = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const d = JSON.parse(readFileSync(process.env.DEPLOYMENTS ?? "solana/deployments/devnet.json", "utf8"));
  const walletPath = defaultWallet();
  const connection = new Connection(rpc, "confirmed");
  const vault = new PublicKey(d.vault);
  const api = new AfterbellClient(process.env.AFTERBELL_URL ?? "https://afterbell-nine.vercel.app");

  if (process.argv.includes("--plan")) {
    if (existsSync(walletPath)) {
      const payer = loadKeypair(walletPath).publicKey;
      console.log(`payer         ${payer.toBase58()}, ${(await connection.getBalance(payer)) / LAMPORTS_PER_SOL} SOL`);
    }
    printPlan(await planKeeper({ connection, vault, hermes: hermesFromEnv }));
    printRenewals(await renewOrders({ connection, vault, feeds: d.feeds, api }));
    console.log("\nplan only: nothing was sent");
    return;
  }

  const payer = loadKeypair(walletPath);
  const report = await runKeeper({ connection, payer, vault, hermes: hermesFromEnv, pay: !process.argv.includes("--no-pay"), log: (line) => console.log(line) });
  for (const w of report.waiting) console.log(`waiting ${w.series}: ${w.reason}`);
  if (report.tips > 0n) console.log(`tips earned ${report.tips} units`);
  // Renew once the pool has rolled: the next open's protection sells from the new round.
  const renewals = await renewOrders({ connection, vault, feeds: d.feeds, api, payer, sizeFor: kaminoSizer(api), log: (line) => console.log(line) });
  for (const r of renewals) if (r.decision.action === "skip") console.log(`not renewing ${r.order.address}: ${r.decision.reason}`);
  if (report.settled.length + report.voided.length + report.paid.length === 0 && !report.rolled && renewals.length === 0) console.log("nothing to do");
}

// Exit explicitly so a scheduled run never lingers on an open websocket.
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    if (e?.logs) console.error(e.logs.join("\n"));
    process.exit(1);
  },
);
