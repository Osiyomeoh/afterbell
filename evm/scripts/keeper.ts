/**
 * Runs the EVM keeper once over the Robinhood Chain vault: settle due series
 * on Chainlink's round in force at the open, void what can't settle, pay
 * every finished position to whoever holds its NFT (the vault tips the
 * keeper for each), and roll the pool once the round is paid.
 *
 *   KEEPER_PRIVATE_KEY=0x… npx tsx evm/scripts/keeper.ts
 *   npx tsx evm/scripts/keeper.ts --plan     # read-only, no key: what it would settle on and pay
 *
 * RPC_URL      defaults to the deployment's RPC
 * DEPLOYMENTS  defaults to evm/deployments/robinhood.json
 * KEEPER_PRIVATE_KEY pays gas (any funded account); read from the environment, never stored
 */
import { readFileSync } from "node:fs";

import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { robinhoodChain, type EvmDeployment } from "../client/vault";
import { planEvmKeeper, runEvmKeeper, type EvmPlan } from "../keeper/keeper";

const iso = (secs: number) => new Date(secs * 1000).toISOString().replace(".000Z", "Z");
const amount = (units: bigint) => (Number(units) / 1e6).toFixed(2);

function printPlan({ now, series, rollBlocked }: EvmPlan) {
  console.log(`block time  ${iso(now)}`);
  if (series.length === 0) console.log("\nno series with anything to do");
  for (const s of series) {
    console.log(`\n${s.action.toUpperCase()} ${s.feed}, open ${iso(s.openTs)}`);
    if (s.round) console.log(`  on round ${s.round.roundId & ((1n << 64n) - 1n)}: $${s.round.price}, published ${iso(s.round.updatedAt)}, ${s.openTs - s.round.updatedAt}s before the open`);
    if (s.note) console.log(`  ${s.note}`);
    for (const x of s.positions) {
      console.log(`  position ${x.id} to its holder ${x.holder}: ${x.units === undefined ? `up to ${amount(x.maxUnits)}` : `${amount(x.units)} (at most ${amount(x.maxUnits)})`}`);
    }
    const max = s.positions.reduce((a, x) => a + x.maxUnits, 0n);
    const known = s.positions.every((x) => x.units !== undefined);
    const pays = known ? `pays ${amount(s.positions.reduce((a, x) => a + x.units!, 0n))}` : "pays unknown until the open";
    console.log(`  ${s.positions.length} position(s): ${pays}, at most ${amount(max)}`);
  }
  console.log(`\nROLL ${rollBlocked === null ? "the pool rolls into its next round after this run" : `not yet: ${rollBlocked}`}`);
  console.log("\nplan only: nothing was sent");
}

async function main() {
  const d = JSON.parse(readFileSync(process.env.DEPLOYMENTS ?? "evm/deployments/robinhood.json", "utf8")) as EvmDeployment;
  const rpc = process.env.RPC_URL ?? d.rpc;
  const chain = { ...robinhoodChain, id: d.chainId };
  const client = createPublicClient({ chain, transport: http(rpc) });
  if (process.argv.includes("--plan")) {
    return printPlan(await planEvmKeeper({ client, deployment: d }));
  }
  const key = process.env.KEEPER_PRIVATE_KEY;
  if (!key) throw new Error("set KEEPER_PRIVATE_KEY");
  const report = await runEvmKeeper({
    client,
    wallet: createWalletClient({ chain, transport: http(rpc), account: privateKeyToAccount(key as Hex) }),
    deployment: d,
    log: (line) => console.log(line),
  });
  for (const w of report.waiting) console.log(`waiting ${w.feed} ${w.openTs}: ${w.reason}`);
  if (report.tips > 0n) console.log(`tips earned ${amount(report.tips)}`);
  if (report.settled.length + report.voided.length + report.paid.length === 0 && !report.rolled) console.log("nothing to do");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
