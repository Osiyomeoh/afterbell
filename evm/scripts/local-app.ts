/**
 * A local stand-in for Robinhood Chain, for trying the app's Robinhood flow
 * before (or without) the mainnet vault: anvil on port 8547 with the vault
 * deployed on a mock feed, recorded in evm/deployments/local.json
 * (gitignored). It runs until stopped.
 *
 *   npm run evm:local
 *   EVM_DEPLOYMENT_FILE=../evm/deployments/local.json QUOTER_EVM_KEY=<anvil key 1> npm run dev --workspace app
 *
 * Point a browser wallet at http://127.0.0.1:8547 (chain 31337) with one of
 * anvil's test accounts, and buy on the Robinhood Chain tab.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { privateKeyToAccount } from "viem/accounts";

import { ANVIL_KEYS, deployLocalVault, startAnvil } from "./local-chain";

const PORT = 8547;
const FILE = join(import.meta.dirname, "..", "deployments", "local.json");

async function main() {
  const { anvil, chain, client, rpc } = await startAnvil(PORT);
  const stop = () => {
    anvil.kill();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const d = await deployLocalVault(chain, client, rpc, ANVIL_KEYS[0], privateKeyToAccount(ANVIL_KEYS[1]).address);
  mkdirSync(join(FILE, ".."), { recursive: true });
  writeFileSync(FILE, JSON.stringify(d, null, 2) + "\n");
  console.log(`anvil on ${rpc}, chain ${chain.id}`);
  console.log(`vault ${d.vault}, TestUSD ${d.testUsd}, feed ${d.feeds.TSLA}; quoter is anvil's key 1`);
  console.log(`wrote ${FILE}; Ctrl-C stops anvil`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
