/**
 * Runs the EVM keeper once over the Robinhood Chain vault: settle due series
 * on Chainlink's round in force at the open, void what can't settle, claim
 * every finished position.
 *
 *   KEEPER_PRIVATE_KEY=0x… npx tsx evm/scripts/keeper.ts
 *
 * RPC_URL      defaults to the deployment's RPC
 * DEPLOYMENTS  defaults to evm/deployments/robinhood.json
 * KEEPER_PRIVATE_KEY pays gas (any funded account); read from the environment, never stored
 */
import { readFileSync } from "node:fs";

import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { robinhoodChain, type EvmDeployment } from "../client/vault";
import { runEvmKeeper } from "../keeper/keeper";

async function main() {
  const d = JSON.parse(readFileSync(process.env.DEPLOYMENTS ?? "evm/deployments/robinhood.json", "utf8")) as EvmDeployment;
  const rpc = process.env.RPC_URL ?? d.rpc;
  const key = process.env.KEEPER_PRIVATE_KEY;
  if (!key) throw new Error("set KEEPER_PRIVATE_KEY");
  const chain = { ...robinhoodChain, id: d.chainId };
  const report = await runEvmKeeper({
    client: createPublicClient({ chain, transport: http(rpc) }),
    wallet: createWalletClient({ chain, transport: http(rpc), account: privateKeyToAccount(key as Hex) }),
    deployment: d,
    log: (line) => console.log(line),
  });
  for (const w of report.waiting) console.log(`waiting ${w.feed} ${w.openTs}: ${w.reason}`);
  if (report.settled.length + report.voided.length + report.claimed.length === 0) console.log("nothing to do");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
