/**
 * npm run audit: reads every position on both live vaults, recomputes what
 * each should have paid from its terms and the oracle price its series
 * settled on, and exits non-zero if any payout differs.
 */
import { join } from "node:path";
import { audit, type AuditResult } from "../src/lib/audit";
import { solanaVaultState } from "../src/server/chain";
import { SOLANA_V1_DEPLOYMENT } from "../src/server/deployment";
import { evmVaultState } from "../src/server/evmChain";
import { v1AuditRows } from "../src/server/v1Audit";

const usd = (x: number | null) => (x === null ? "-" : `$${x.toFixed(6)}`);

// The app reads the deployment relative to app/; this runs from the repo root.
process.env.EVM_DEPLOYMENT_FILE ||= join(import.meta.dirname, "..", "..", "evm", "deployments", "robinhood.json");

async function main() {
  const chains = [
    ["Solana devnet", solanaVaultState()],
    ["Solana devnet, the first vault", SOLANA_V1_DEPLOYMENT && v1AuditRows(SOLANA_V1_DEPLOYMENT).then((audit) => ({ audit }))],
    ["Robinhood Chain testnet", evmVaultState()],
  ] as const;
  let bad = 0;
  for (const [name, pending] of chains) {
    if (!pending) continue;
    const results: AuditResult[] = audit((await pending).audit);
    const count = (v: AuditResult["verdict"]) => results.filter((r) => r.verdict === v).length;
    console.log(`\n${name}: ${results.length} settled or voided positions — ${count("ok")} ok, ${count("mismatch")} mismatched, ${count("unpaid")} unpaid, ${count("forfeited")} forfeited`);
    for (const r of results.filter((r) => r.verdict !== "ok"))
      console.log(`  ${r.verdict.padEnd(9)} ${r.symbol.padEnd(5)} ${new Date(r.openTs * 1000).toISOString().slice(0, 10)} ${r.address}  expected ${usd(r.expected)} paid ${usd(r.paid)}`);
    bad += count("mismatch");
  }
  console.log(bad ? `\n${bad} payout(s) differ from the terms.` : "\nEvery payout matches its terms at the settlement price.");
  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
