/**
 * Runs the keeper once over a vault: settle due series on Pyth's first print
 * after the open, void what can't settle, and claim every finished position.
 *
 *   PYTH_API_KEY=<your key> npm run solana:keeper
 *   PYTH_API_KEY=<your key> npm run solana:keeper -- --plan   # read-only: what it would do, and pay
 *
 * RPC_URL        defaults to devnet
 * ANCHOR_WALLET  pays the fees (any funded wallet), defaults to ~/.config/solana/id.json
 * DEPLOYMENTS    defaults to solana/deployments/devnet.json
 * PYTH_API_KEY   read from the environment, only when a series is due
 *
 * --plan sends nothing and needs no wallet. It shows the payer's balance when
 * ANCHOR_WALLET exists, and without PYTH_API_KEY it still lists every series
 * and position, noting that it couldn't fetch the print.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

import { planKeeper, runKeeper, type KeeperPlan } from "../keeper/keeper";
import { hermesFromEnv } from "../keeper/pyth";

const iso = (secs: number) => new Date(secs * 1000).toISOString().replace(".000Z", "Z");

function printPlan(p: KeeperPlan) {
  const amount = (units: bigint) => (Number(units) / Number(p.collateralUnit)).toFixed(2);
  console.log(`cluster time  ${iso(p.now)}`);
  if (p.series.length === 0) console.log("\nno series with anything to do");
  for (const s of p.series) {
    console.log(`\n${s.action.toUpperCase()} series ${s.series}, open ${iso(s.openTs)}`);
    if (s.print) console.log(`  on $${s.print.price} published ${iso(s.print.publishTime)}, ${s.print.publishTime - s.openTs}s after the open`);
    if (s.note) console.log(`  ${s.note}`);
    for (const x of s.positions) {
      console.log(`  ${x.position} to ${x.buyer}: ${x.units === undefined ? `up to ${amount(x.maxUnits)}` : `${amount(x.units)} (at most ${amount(x.maxUnits)})`}`);
    }
    const max = s.positions.reduce((a, x) => a + x.maxUnits, 0n);
    const known = s.positions.every((x) => x.units !== undefined);
    const pays = known ? `pays ${amount(s.positions.reduce((a, x) => a + x.units!, 0n))}` : "pays unknown until the print";
    console.log(`  ${s.positions.length} position(s): ${pays}, at most ${amount(max)}`);
  }
  console.log("\nplan only: nothing was sent");
}

async function main() {
  const rpc = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const d = JSON.parse(readFileSync(process.env.DEPLOYMENTS ?? "solana/deployments/devnet.json", "utf8"));
  const walletPath = process.env.ANCHOR_WALLET ?? join(homedir(), ".config/solana/id.json");
  const connection = new Connection(rpc, "confirmed");
  const vault = new PublicKey(d.vault);

  if (process.argv.includes("--plan")) {
    if (existsSync(walletPath)) {
      const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8")))).publicKey;
      console.log(`payer         ${payer.toBase58()}, ${(await connection.getBalance(payer)) / LAMPORTS_PER_SOL} SOL`);
    }
    printPlan(await planKeeper({ connection, vault, hermes: hermesFromEnv }));
    return;
  }

  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))));
  const report = await runKeeper({ connection, payer, vault, hermes: hermesFromEnv, log: (line) => console.log(line) });
  for (const w of report.waiting) console.log(`waiting ${w.series}: ${w.reason}`);
  if (report.settled.length + report.voided.length + report.claimed.length === 0) console.log("nothing to do");
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
