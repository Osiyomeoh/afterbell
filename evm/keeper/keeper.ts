/**
 * The EVM keeper: settles every due series in the Robinhood Chain vault on
 * Chainlink's round in force at the open, voids series nobody could settle
 * within the settle window, and claims every finished position. All
 * permissionless; the keeper pays gas, never payouts.
 */
import { parseAbi, zeroAddress, type Account, type Address, type Chain, type Hex, type PublicClient, type Transport, type WalletClient } from "viem";

import { afterbellVaultAbi } from "../client/abi";
import type { EvmDeployment } from "../client/vault";
import { roundInForce, settleError, type FeedReader, type Round } from "./rounds";

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
const iso = (secs: bigint) => new Date(Number(secs) * 1000).toISOString();

/** The vault's timing and every position not yet claimed, read once, at the latest block. */
async function readVault(client: PublicClient, d: EvmDeployment) {
  const vault = { address: d.vault, abi: afterbellVaultAbi } as const;
  const [next, maxRoundAge, settleWindow] = await Promise.all([
    client.readContract({ ...vault, functionName: "nextPositionId" }),
    client.readContract({ ...vault, functionName: "maxRoundAge" }),
    client.readContract({ ...vault, functionName: "settleWindow" }),
  ]);
  const ids = Array.from({ length: Number(next) }, (_, i) => BigInt(i));
  const positions = await Promise.all(ids.map(async (id) => ({ id, p: await client.readContract({ ...vault, functionName: "positions", args: [id] }) })));
  // The contract judges time by the block, so the keeper does too.
  const now = (await client.getBlock()).timestamp;
  const seriesOf = async (feed: Address, openTs: bigint) =>
    client.readContract({ ...vault, functionName: "series", args: [await client.readContract({ ...vault, functionName: "seriesKey", args: [feed, openTs] })] });
  const open = positions.filter(({ p }) => !p[8]); // not yet claimed
  const due = new Map<string, { feed: Address; openTs: bigint }>();
  for (const { p } of open) due.set(`${p[1]}:${p[2]}`, { feed: p[1], openTs: p[2] });
  return { vault, maxRoundAge, settleWindow, now, open, due: [...due.values()], seriesOf };
}

type Decision = { action: "wait" | "settle" | "void"; round?: Round; note?: string };

/** What to do with an open series: the same rules AfterbellVault.settle and voidSeries apply. */
async function decide(client: PublicClient, feed: Address, openTs: bigint, v: { now: bigint; maxRoundAge: bigint; settleWindow: bigint }): Promise<Decision> {
  if (v.now <= openTs) return { action: "wait", note: `opens at ${iso(openTs)}` };
  const round = await roundInForce(chainlinkReader(client, feed), openTs);
  const problem = round ? settleError(round, openTs, v.maxRoundAge) : "no round at or before the open in the feed's current phase";
  if (round && !problem) return { action: "settle", round };
  if (v.now > openTs + v.settleWindow) return { action: "void", note: problem ?? undefined };
  return { action: "wait", note: `${problem}; it voids after ${iso(openTs + v.settleWindow)}` };
}

export async function runEvmKeeper(opts: {
  client: PublicClient;
  wallet: WalletClient<Transport, Chain, Account>;
  deployment: EvmDeployment;
  log?: (line: string) => void;
}): Promise<EvmKeeperReport> {
  const { client, wallet, deployment: d } = opts;
  const log = opts.log ?? (() => {});
  const report: EvmKeeperReport = { settled: [], voided: [], claimed: [], waiting: [] };
  const send = async (hash: Hex) => {
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transaction reverted: ${hash}`);
    return hash;
  };
  const v = await readVault(client, d);
  const { vault } = v;

  for (const { feed, openTs } of v.due) {
    const [state] = await v.seriesOf(feed, openTs);
    if (state !== 0) continue;
    const { action, round, note } = await decide(client, feed, openTs, v);
    if (action === "settle") {
      const hash = await send(await wallet.writeContract({ ...vault, functionName: "settle", args: [feed, openTs, round!.roundId] }));
      report.settled.push({ feed, openTs: Number(openTs), price: Number(round!.answer) / 1e8, roundId: round!.roundId, hash });
      log(`settled ${feed} ${openTs} at $${Number(round!.answer) / 1e8} (round ${round!.roundId & ((1n << 64n) - 1n)})`);
    } else if (action === "void") {
      const hash = await send(await wallet.writeContract({ ...vault, functionName: "voidSeries", args: [feed, openTs] }));
      report.voided.push({ feed, openTs: Number(openTs), hash });
      log(`voided ${feed} ${openTs}: ${note}`);
    } else {
      report.waiting.push({ feed, openTs: Number(openTs), reason: note! });
    }
  }

  // Claim every position whose series has settled or voided; the money goes to its buyer.
  for (const { id, p } of v.open) {
    const [state, price] = await v.seriesOf(p[1], p[2]);
    if (state === 0) continue;
    const units = state === SETTLED ? await client.readContract({ ...vault, functionName: "payoutAt", args: [p[3], p[4], p[5], price] }) : p[6];
    const hash = await send(await wallet.writeContract({ ...vault, functionName: "claim", args: [id] }));
    report.claimed.push({ id, buyer: p[0], units, hash });
    log(`claimed position ${id}: ${Number(units) / 1e6} to ${p[0]}`);
  }
  return report;
}

export type EvmSeriesPlan = {
  feed: Address;
  openTs: number;
  action: "wait" | "settle" | "void" | "claim";
  /** Why the keeper will wait, or why the series voids. */
  note?: string;
  /** The Chainlink round it would settle on. */
  round?: { roundId: bigint; price: number; updatedAt: number };
  positions: { id: bigint; buyer: Address; maxUnits: bigint; units?: bigint }[];
};

/**
 * What runEvmKeeper would do right now, sending nothing and needing no key:
 * each series it would settle (on which round), void or leave waiting, and
 * what every open position would be paid, from the contract's own payoutAt.
 * A settle or void is also simulated (eth_call), so the contract itself says
 * it would accept it.
 */
export async function planEvmKeeper(opts: { client: PublicClient; deployment: EvmDeployment }): Promise<{ now: number; series: EvmSeriesPlan[] }> {
  const { client, deployment: d } = opts;
  const v = await readVault(client, d);
  const { vault } = v;
  const out: EvmSeriesPlan[] = [];
  for (const { feed, openTs } of v.due) {
    const mine = v.open.filter(({ p }) => p[1] === feed && p[2] === openTs);
    const positionsAt = async (units: (p: (typeof mine)[number]["p"]) => Promise<bigint | undefined>) =>
      Promise.all(mine.map(async ({ id, p }) => ({ id, buyer: p[0], maxUnits: p[7], units: await units(p) })));
    const payoutAt = (p: (typeof mine)[number]["p"], price: bigint) => client.readContract({ ...vault, functionName: "payoutAt", args: [p[3], p[4], p[5], price] });
    const base = { feed, openTs: Number(openTs) };

    const [state, price] = await v.seriesOf(feed, openTs);
    if (state !== 0) {
      out.push({ ...base, action: "claim", positions: await positionsAt(async (p) => (state === SETTLED ? payoutAt(p, price) : p[6])) });
      continue;
    }
    const { action, round, note } = await decide(client, feed, openTs, v);
    const refused = async (functionName: "settle" | "voidSeries", args: readonly [Address, bigint] | readonly [Address, bigint, bigint]) => {
      try {
        await client.simulateContract({ ...vault, functionName, args: args as never, account: zeroAddress });
        return undefined;
      } catch (e) {
        return `the contract would refuse it: ${e instanceof Error ? e.message.split("\n")[0] : e}`;
      }
    };
    if (action === "settle") {
      out.push({
        ...base,
        action,
        note: await refused("settle", [feed, openTs, round!.roundId]),
        round: { roundId: round!.roundId, price: Number(round!.answer) / 1e8, updatedAt: Number(round!.updatedAt) },
        positions: await positionsAt((p) => payoutAt(p, round!.answer)),
      });
    } else if (action === "void") {
      out.push({ ...base, action, note: [note, await refused("voidSeries", [feed, openTs])].filter(Boolean).join("; ") || undefined, positions: await positionsAt(async (p) => p[6]) });
    } else {
      out.push({ ...base, action, note, positions: await positionsAt(async () => undefined) });
    }
  }
  return { now: Number(v.now), series: out };
}
