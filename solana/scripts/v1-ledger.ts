/**
 * Records vault v1's ledger, what its events say it sold, settled and paid,
 * in solana/deployments/devnet-v1-ledger.json, so the app needn't read every
 * v1 transaction again each time a server starts. Devnet's public RPC answers
 * only about ten getTransaction calls at a time (28 Sep), so this reads one
 * every two seconds, and waits out a refusal.
 *
 *   npx tsx solana/scripts/v1-ledger.ts
 *
 * Read-only; no key. The app reads anything newer than the file itself.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { Connection, PublicKey } from "@solana/web3.js";

import { addV1Events, emptyV1Ledger, getProgram, parseVaultEvents, v1LedgerToJson } from "../client/v1";

const DEPLOYMENT = "solana/deployments/devnet-v1.json";
const OUT = "solana/deployments/devnet-v1-ledger.json";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function patiently<T>(what: string, call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      if (attempt >= 10 || !String((e as Error).message).includes("429")) throw e;
      console.log(`  ${what}: rate-limited, waiting 15 s (attempt ${attempt})`);
      await sleep(15_000);
    }
  }
}

async function main() {
  const d = JSON.parse(readFileSync(DEPLOYMENT, "utf8")) as { rpc: string; vault: string };
  const connection = new Connection(process.env.RPC_URL ?? d.rpc, { commitment: "confirmed", disableRetryOnRateLimit: true });
  const vault = new PublicKey(d.vault);
  const readOnly = { publicKey: PublicKey.default, signTransaction: () => Promise.reject(), signAllTransactions: () => Promise.reject() };
  const program = getProgram(connection, readOnly);

  const sigs: string[] = [];
  for (let before: string | undefined; ; ) {
    const page = await patiently("signatures", () => connection.getSignaturesForAddress(vault, { before, limit: 1000 }));
    sigs.push(...page.filter((s) => !s.err).map((s) => s.signature));
    if (page.length < 1000) break;
    before = page[page.length - 1]!.signature;
  }
  console.log(`vault ${vault.toBase58()}: ${sigs.length} transactions`);

  const ledger = emptyV1Ledger();
  for (const sig of sigs.reverse()) {
    const tx = await patiently(sig.slice(0, 8), () => connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }));
    if (!tx) throw new Error(`transaction ${sig} not found`);
    const events = parseVaultEvents(program, tx.meta?.logMessages ?? []);
    addV1Events(ledger, vault, sig, events);
    console.log(`  ${sig.slice(0, 8)}… ${events.map((e) => e.name).join(", ") || "no events"}`);
    await sleep(2_000);
  }

  writeFileSync(OUT, JSON.stringify(v1LedgerToJson(vault, ledger), null, 2) + "\n");
  console.log(`${OUT}: ${ledger.bought.size} sales, ${ledger.settleTx.size} settled, ${ledger.paid.size} paid, through ${ledger.through}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
