/**
 * Read-only: the Chainlink round the keeper would settle an open on, from the
 * live feed on Robinhood Chain mainnet. Defaults to Friday 25 Sep 2026's open,
 * whose round in force is 1341 ($383.8284), as the fork tests pin.
 *
 *   npx tsx evm/scripts/check-round.ts [open unix seconds]
 */
import { createPublicClient, http } from "viem";

import { robinhoodChain, TSLA_FEED } from "../client/vault";
import { chainlinkReader } from "../keeper/keeper";
import { roundInForce } from "../keeper/rounds";

async function main() {
  const openTs = BigInt(process.argv[2] ?? 1_790_343_000);
  const client = createPublicClient({ chain: robinhoodChain, transport: http() });
  const r = await roundInForce(chainlinkReader(client, TSLA_FEED), openTs);
  if (!r) throw new Error("no round at or before that open in the feed's current phase");
  console.log(`open             ${new Date(Number(openTs) * 1000).toISOString()}`);
  console.log(`round in force   ${r.roundId >> 64n}|${r.roundId & ((1n << 64n) - 1n)} at $${Number(r.answer) / 1e8}, published ${new Date(Number(r.updatedAt) * 1000).toISOString()}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
