/**
 * The EVM keeper: settles every due series in the Robinhood Chain vault on
 * Chainlink's round in force at the open, voids series nobody could settle
 * within the settle window, pays every finished position out to whoever
 * holds its NFT (`process`, which pays the keeper a tip on each), and rolls
 * the pool into its next round once the last is paid. All permissionless;
 * the keeper pays gas, never payouts.
 */
import { decodeEventLog, parseAbi, zeroAddress, type Account, type Address, type Chain, type Hex, type PublicClient, type Transport, type WalletClient } from "viem";

import { afterbellPositionsAbi, afterbellVaultAbi } from "../client/abi";
import type { EvmDeployment, EvmPosition, EvmSeries } from "../client/vault";
import { roundInForce, settleError, type FeedReader, type Round, type StrikeRange } from "./rounds";

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
  /** Each position paid out: what it paid whoever held its NFT (a refund if voided), and the transaction. */
  paid: { id: bigint; holder: Address; units: bigint; refund: boolean; hash: Hex }[];
  /** The tips the vault paid this keeper for the payouts, in TestUSD units. */
  tips: bigint;
  /** The roll that ended the round, if this run made one. */
  rolled: { round: bigint; hash: Hex } | null;
  waiting: { feed: Address; openTs: number; reason: string }[];
};

/** Positions paid out per `process` call. */
const BATCH = 50n;
const OPEN = 0;
const SETTLED = 1;
const iso = (secs: bigint) => new Date(Number(secs) * 1000).toISOString();

/**
 * The vault's timing, its round, and every series with work left, read once, at the latest block: any
 * series with a position not yet paid, and every series of the current round, since the pool can't
 * roll until `process` has passed over each position, even ones their holders claimed themselves.
 */
async function readVault(client: PublicClient, d: EvmDeployment) {
  const vault = { address: d.vault, abi: afterbellVaultAbi } as const;
  const [next, maxRoundAge, settleWindow, roundOpenTs, pendingDeposits, pendingRedeems] = await Promise.all([
    client.readContract({ ...vault, functionName: "nextPositionId" }),
    client.readContract({ ...vault, functionName: "maxRoundAge" }),
    client.readContract({ ...vault, functionName: "settleWindow" }),
    client.readContract({ ...vault, functionName: "roundOpenTs" }),
    client.readContract({ ...vault, functionName: "pendingDepositAssets" }),
    client.readContract({ ...vault, functionName: "pendingRedeemShares" }),
  ]);
  const ids = Array.from({ length: Number(next) }, (_, i) => BigInt(i));
  const positions = await Promise.all(
    ids.map(async (id) => ({ id, p: (await client.readContract({ ...vault, functionName: "position", args: [id] })) as EvmPosition })),
  );
  // The contract judges time by the block, so the keeper does too.
  const now = (await client.getBlock()).timestamp;
  const keys = new Map<string, { feed: Address; openTs: bigint }>();
  for (const { p } of positions) {
    if (!p.closed || p.openTs === roundOpenTs) keys.set(`${p.feed}:${p.openTs}`, { feed: p.feed, openTs: p.openTs });
  }
  const series = await Promise.all(
    [...keys.values()].map(async ({ feed, openTs }) => {
      const key = await client.readContract({ ...vault, functionName: "seriesKey", args: [feed, openTs] });
      const [s, sold] = await Promise.all([
        client.readContract({ ...vault, functionName: "series", args: [key] }) as Promise<EvmSeries>,
        client.readContract({ ...vault, functionName: "seriesPositions", args: [feed, openTs] }),
      ]);
      const mine = positions.filter(({ p }) => p.feed === feed && p.openTs === openTs);
      return { feed, openTs, s, sold: sold.length, unpaid: mine.filter(({ p }) => !p.closed) };
    }),
  );
  const due = series.filter(({ s, sold }) => s.state === OPEN || s.processed < sold);
  return { vault, maxRoundAge, settleWindow, roundOpenTs, queued: pendingDeposits > 0n || pendingRedeems > 0n, now, due };
}

type Decision = { action: "wait" | "settle" | "void"; round?: Round; note?: string };

/** What to do with an open series: the same rules AfterbellVault.settle and voidSeries apply. */
async function decide(
  client: PublicClient,
  feed: Address,
  openTs: bigint,
  v: { now: bigint; maxRoundAge: bigint; settleWindow: bigint },
  strikes: StrikeRange,
): Promise<Decision> {
  if (v.now <= openTs) return { action: "wait", note: `opens at ${iso(openTs)}` };
  const round = await roundInForce(chainlinkReader(client, feed), openTs);
  const problem = round ? settleError(round, openTs, v.maxRoundAge, strikes) : "no round at or before the open in the feed's current phase";
  if (round && !problem) return { action: "settle", round };
  if (v.now > openTs + v.settleWindow) return { action: "void", note: problem ?? undefined };
  return { action: "wait", note: `${problem}; it voids after ${iso(openTs + v.settleWindow)}` };
}

/**
 * Why the pool can't roll yet, or null if it can: when its round sold nothing and deposits or
 * redemptions are waiting, or when the round's open has passed and `unfinished` series are left.
 */
function rollDue(v: { roundOpenTs: bigint; now: bigint; queued: boolean }, unfinished: number): string | null {
  if (v.roundOpenTs === 0n) return v.queued ? null : "the round sold nothing and no deposit or redemption is waiting";
  if (v.now <= v.roundOpenTs) return `the round sells until its open at ${iso(v.roundOpenTs)}`;
  if (unfinished > 0) return `${unfinished} series still to settle or void`;
  return null;
}

export async function runEvmKeeper(opts: {
  client: PublicClient;
  wallet: WalletClient<Transport, Chain, Account>;
  deployment: EvmDeployment;
  log?: (line: string) => void;
}): Promise<EvmKeeperReport> {
  const { client, wallet, deployment: d } = opts;
  const log = opts.log ?? (() => {});
  const report: EvmKeeperReport = { settled: [], voided: [], paid: [], tips: 0n, rolled: null, waiting: [] };
  const send = async (hash: Hex) => {
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transaction reverted: ${hash}`);
    return receipt;
  };
  const v = await readVault(client, d);
  const { vault } = v;

  for (const { feed, openTs, s, sold } of v.due) {
    if (s.state === OPEN) {
      const { action, round, note } = await decide(client, feed, openTs, v, s);
      if (action === "settle") {
        const { transactionHash: hash } = await send(await wallet.writeContract({ ...vault, functionName: "settle", args: [feed, openTs, round!.roundId] }));
        report.settled.push({ feed, openTs: Number(openTs), price: Number(round!.answer) / 1e8, roundId: round!.roundId, hash });
        log(`settled ${feed} ${openTs} at $${Number(round!.answer) / 1e8} (round ${round!.roundId & ((1n << 64n) - 1n)})`);
      } else if (action === "void") {
        const { transactionHash: hash } = await send(await wallet.writeContract({ ...vault, functionName: "voidSeries", args: [feed, openTs] }));
        report.voided.push({ feed, openTs: Number(openTs), hash });
        log(`voided ${feed} ${openTs}: ${note}`);
      } else {
        report.waiting.push({ feed, openTs: Number(openTs), reason: note! });
        continue;
      }
    }
    // Pay the series out to whoever holds each NFT, a batch at a time; the vault pays this keeper the tips.
    for (let done = s.processed; done < sold; done += Number(BATCH)) {
      const receipt = await send(await wallet.writeContract({ ...vault, functionName: "process", args: [feed, openTs, BATCH] }));
      for (const entry of receipt.logs) {
        if (entry.address.toLowerCase() !== d.vault.toLowerCase()) continue;
        const event = decodeEventLog({ abi: afterbellVaultAbi, data: entry.data, topics: entry.topics });
        if (event.eventName === "Claimed") {
          const { id, holder, amount, refund } = event.args;
          report.paid.push({ id, holder, units: amount, refund, hash: receipt.transactionHash });
          log(`position ${id}: ${refund ? "refunded" : "paid"} ${Number(amount) / 1e6} to ${holder}`);
        } else if (event.eventName === "Processed") {
          report.tips += event.args.tips;
        }
      }
    }
  }

  // The round is over and paid (or sold nothing while requests wait): roll, filling deposits and redemptions.
  const after = await readVault(client, d);
  if (rollDue(after, after.due.length) === null) {
    const round = await client.readContract({ ...vault, functionName: "round" });
    const { transactionHash: hash } = await send(await wallet.writeContract({ ...vault, functionName: "roll" }));
    report.rolled = { round, hash };
    log(`rolled round ${round} into ${round + 1n} (${hash})`);
  }
  return report;
}

export type EvmSeriesPlan = {
  feed: Address;
  openTs: number;
  action: "wait" | "settle" | "void" | "pay";
  /** Why the keeper will wait, or why the series voids. */
  note?: string;
  /** The Chainlink round it would settle on. */
  round?: { roundId: bigint; price: number; updatedAt: number };
  positions: { id: bigint; holder: Address; maxUnits: bigint; units?: bigint }[];
};

export type EvmPlan = {
  now: number;
  series: EvmSeriesPlan[];
  /** Why the pool won't roll yet, or null if it would roll after this run's payouts. */
  rollBlocked: string | null;
};

/**
 * What runEvmKeeper would do right now, sending nothing and needing no key:
 * each series it would settle (on which round), void, pay out or leave
 * waiting, what every open position would be paid (from the contract's own
 * payoutAt), and whether the pool would roll. A settle or void is also
 * simulated (eth_call), so the contract itself says it would accept it.
 */
export async function planEvmKeeper(opts: { client: PublicClient; deployment: EvmDeployment }): Promise<EvmPlan> {
  const { client, deployment: d } = opts;
  const v = await readVault(client, d);
  const { vault } = v;
  const out: EvmSeriesPlan[] = [];
  let unfinished = 0;
  for (const { feed, openTs, s, unpaid } of v.due) {
    const positionsAt = async (units: (p: EvmPosition) => Promise<bigint | undefined>) =>
      Promise.all(
        unpaid.map(async ({ id, p }) => ({
          id,
          holder: await client.readContract({ address: d.positions, abi: afterbellPositionsAbi, functionName: "ownerOf", args: [id] }),
          maxUnits: p.maxPayout,
          units: await units(p),
        })),
      );
    const payoutAt = (p: EvmPosition, price: bigint) => client.readContract({ ...vault, functionName: "payoutAt", args: [p.shares, p.upper, p.lower, price] });
    const base = { feed, openTs: Number(openTs) };

    if (s.state !== OPEN) {
      out.push({ ...base, action: "pay", positions: await positionsAt(async (p) => (s.state === SETTLED ? payoutAt(p, s.price) : p.premium)) });
      continue;
    }
    const { action, round, note } = await decide(client, feed, openTs, v, s);
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
      out.push({ ...base, action, note: [note, await refused("voidSeries", [feed, openTs])].filter(Boolean).join("; ") || undefined, positions: await positionsAt(async (p) => p.premium) });
    } else {
      unfinished++;
      out.push({ ...base, action, note, positions: await positionsAt(async () => undefined) });
    }
  }
  return { now: Number(v.now), series: out, rollBlocked: rollDue(v, unfinished) };
}
