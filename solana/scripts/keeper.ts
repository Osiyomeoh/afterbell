/**
 * Runs the keeper once over a vault: settle due series on Pyth's first print
 * after the open, void what can't settle, and claim every finished position.
 *
 *   PYTH_API_KEY=<your key> npm run solana:keeper
 *
 * RPC_URL        defaults to devnet
 * ANCHOR_WALLET  pays the fees (any funded wallet), defaults to ~/.config/solana/id.json
 * DEPLOYMENTS    defaults to solana/deployments/devnet.json
 * PYTH_API_KEY   read from the environment, only when a series is due
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import { runKeeper } from "../keeper/keeper";
import { hermesFromEnv } from "../keeper/pyth";

async function main() {
  const rpc = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const d = JSON.parse(readFileSync(process.env.DEPLOYMENTS ?? "solana/deployments/devnet.json", "utf8"));
  const walletPath = process.env.ANCHOR_WALLET ?? join(homedir(), ".config/solana/id.json");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))));

  const report = await runKeeper({
    connection: new Connection(rpc, "confirmed"),
    payer,
    vault: new PublicKey(d.vault),
    hermes: hermesFromEnv,
    log: (line) => console.log(line),
  });
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
