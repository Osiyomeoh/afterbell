/**
 * The EVM keeper: settles every due series in the Robinhood Chain vault on
 * Chainlink's round in force at the open, voids series nobody could settle
 * within the settle window, and claims every finished position. All
 * permissionless; the keeper pays gas, never payouts.
 */
import { parseAbi, type Account, type Address, type Chain, type Hex, type PublicClient, type Transport, type WalletClient } from "viem";

import { afterbellVaultAbi } from "../client/abi";
import type { EvmDeployment } from "../client/vault";
import { roundInForce, settleError, type FeedReader } from "./rounds";

const aggregatorAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function getRoundData(uint80 roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

export function chainlinkReader(client: PublicClient, feed: Address): FeedReader {
  return {
    async latest() {
      const [roundId, answer, , updatedAt] = await client.readContract({ address: feed, abi: aggregatorAbi, functionName: "latestRoundData" });
      return { roundId, answer, updatedAt };
    },
    async round(id) {
      try {
        const [roundId, answer, , updatedAt] = await client.readContract({ address: feed, abi: aggregatorAbi, functionName: "getRoundData", args: [id] });
        return updatedAt > 0n ? { roundId, answer, updatedAt } : null;
      } catch {
        return null; // Chainlink reverts for a round that doesn't exist
      }
    },
  };
}

export type EvmKeeperReport = {
  settled: { feed: Address; openTs: number; price: number; roundId: bigint; hash: Hex }[];
  voided: { feed: Address; openTs: number; hash: Hex }[];
  claimed: { id: bigint; buyer: Address; units: bigint; hash: Hex }[];
  waiting: { feed: Address; openTs: number; reason: string }[];
};

const SETTLED = 1;

export async function runEvmKeeper(opts: {
  client: PublicClient;
  wallet: WalletClient<Transport, Chain, Account>;
  deployment: EvmDeployment;
  log?: (line: string) => void;
}): Promise<EvmKeeperReport> {
  const { client, wallet, deployment: d } = opts;
  const log = opts.log ?? (() => {});
  const vault = { address: d.vault, abi: afterbellVaultAbi } as const;
  const report: EvmKeeperReport = { settled: [], voided: [], claimed: [], waiting: [] };
  const send = async (hash: Hex) => {
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transaction reverted: ${hash}`);
    return hash;
  };

  const [next, maxRoundAge, settleWindow] = await Promise.all([
    client.readContract({ ...vault, functionName: "nextPositionId" }),
    client.readContract({ ...vault, functionName: "maxRoundAge" }),
    client.readContract({ ...vault, functionName: "settleWindow" }),
  ]);
  const ids = Array.from({ length: Number(next) }, (_, i) => BigInt(i));
  const positions = await Promise.all(ids.map(async (id) => ({ id, p: await client.readContract({ ...vault, functionName: "positions", args: [id] }) })));
  const open = positions.filter(({ p }) => !p[8]); // not yet claimed

  // The contract judges time by the block, so the keeper does too.
  const now = (await client.getBlock()).timestamp;
  const seriesOf = async (feed: Address, openTs: bigint) =>
    client.readContract({ ...vault, functionName: "series", args: [await client.readContract({ ...vault, functionName: "seriesKey", args: [feed, openTs] })] });

  const due = new Map<string, { feed: Address; openTs: bigint }>();
  for (const { p } of open) due.set(`${p[1]}:${p[2]}`, { feed: p[1], openTs: p[2] });
  for (const { feed, openTs } of due.values()) {
    const [state] = await seriesOf(feed, openTs);
    if (state !== 0) continue;
    if (now <= openTs) {
      report.waiting.push({ feed, openTs: Number(openTs), reason: `opens at ${new Date(Number(openTs) * 1000).toISOString()}` });
      continue;
    }
    const round = await roundInForce(chainlinkReader(client, feed), openTs);
    const problem = round ? settleError(round, openTs, maxRoundAge) : "no round at or before the open in the feed's current phase";
    if (round && !problem) {
      const hash = await send(await wallet.writeContract({ ...vault, functionName: "settle", args: [feed, openTs, round.roundId] }));
      report.settled.push({ feed, openTs: Number(openTs), price: Number(round.answer) / 1e8, roundId: round.roundId, hash });
      log(`settled ${feed} ${openTs} at $${Number(round.answer) / 1e8} (round ${round.roundId & ((1n << 64n) - 1n)})`);
    } else if (now > openTs + settleWindow) {
      const hash = await send(await wallet.writeContract({ ...vault, functionName: "voidSeries", args: [feed, openTs] }));
      report.voided.push({ feed, openTs: Number(openTs), hash });
      log(`voided ${feed} ${openTs}: ${problem}`);
    } else {
      report.waiting.push({ feed, openTs: Number(openTs), reason: `${problem}; it voids after ${new Date(Number(openTs + settleWindow) * 1000).toISOString()}` });
    }
  }

  // Claim every position whose series has settled or voided; the money goes to its buyer.
  for (const { id, p } of open) {
    const [state, price] = await seriesOf(p[1], p[2]);
    if (state === 0) continue;
    const units = state === SETTLED ? await client.readContract({ ...vault, functionName: "payoutAt", args: [p[3], p[4], p[5], price] }) : p[6];
    const hash = await send(await wallet.writeContract({ ...vault, functionName: "claim", args: [id] }));
    report.claimed.push({ id, buyer: p[0], units, hash });
    log(`claimed position ${id}: ${Number(units) / 1e6} to ${p[0]}`);
  }
  return report;
}
