/**
 * How precisely can a contract on Robinhood Chain settle on "the open" using
 * Chainlink's TSLA feed? The feed is push-based: a new round only when the
 * price moves 0.5% or a day passes, 24/5. For every opening Pyth recorded while
 * the feed was live, compare Pyth's opening print with
 *   - the round in force at 09:30 ET (the last round published at or before it), and
 *   - the first round published at or after 09:30 ET,
 * and report how stale or late each was.
 *
 *   npx tsx research/chainlink.ts
 *
 * Rounds are cached in research/data/chainlink-robinhood-TSLA.json. The round
 * fetcher here serves every feed (research/chainlink-openings.ts).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { errBps, mean, median, nyTime } from "./lib";

const HERE = import.meta.dirname;
const RPC = "https://rpc.mainnet.chain.robinhood.com";
// Chainlink "Robinhood TSLA / USD" on Robinhood Chain mainnet (reference-data-directory, feeds-robinhood-mainnet.json).
const FEED = "0x4A1166a659A55625345e9515b32adECea5547C38";
const DECIMALS = 8;
const LATEST_ROUND_DATA = "0xfeaf968c";
const GET_ROUND_DATA = "0x9a6fc8f5";

/** Where a feed's rounds are cached, by stock symbol. */
export const roundsCache = (symbol: string) => join(HERE, "data", `chainlink-robinhood-${symbol}.json`);

export type Round = { roundId: string; answer: number; updatedAt: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The public endpoint is rate-limited: small batches, backing off on HTTP 429.
async function rpcBatch(to: string, calls: string[]): Promise<(string | null)[]> {
  const body = calls.map((data, id) => ({ jsonrpc: "2.0", id, method: "eth_call", params: [{ to, data }, "latest"] }));
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if ((res.status === 429 || res.status === 403) && attempt < 8) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const out = (await res.json()) as { id: number; result?: string }[];
    const byId = new Map(out.map((r) => [r.id, r.result ?? null]));
    return calls.map((_, i) => byId.get(i) ?? null);
  }
}

/** Decode (roundId, answer, startedAt, updatedAt, answeredInRound). */
export function decodeRound(hex: string): Round | null {
  const words = hex.slice(2).match(/.{64}/g);
  if (!words || words.length < 5) return null;
  const updatedAt = Number(BigInt("0x" + words[3]));
  if (updatedAt === 0) return null; // a round that doesn't exist
  const raw = BigInt.asIntN(256, BigInt("0x" + words[1]));
  return { roundId: BigInt("0x" + words[0]).toString(), answer: Number(raw) / 10 ** DECIMALS, updatedAt };
}

/**
 * The rounds whose price is on the feed's scale. From their launch (00:00 UTC
 * on 22 June) until 13:48 UTC on 23 June, the Robinhood feeds published
 * answers with 16 decimals while reporting 8: AAPL's round 1 reads $29.6
 * billion. Those are dropped, as anything more than 100 times from the feed's
 * median would be.
 */
export function onScale<R extends { answer: number }>(rounds: readonly R[]): R[] {
  const sorted = rounds.map((r) => r.answer).sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1] ?? 0;
  return rounds.filter((r) => r.answer > median / 100 && r.answer < median * 100);
}

export const encodeRoundId = (id: bigint) => GET_ROUND_DATA + id.toString(16).padStart(64, "0");

/** Every round in the feed's current phase, oldest first; fetches only those not in `cache` yet. */
export async function allRounds(feed: string, cache: string): Promise<Round[]> {
  const cached: Round[] = existsSync(cache) ? JSON.parse(readFileSync(cache, "utf8")).rounds : [];
  const [latestHex] = await rpcBatch(feed, [LATEST_ROUND_DATA]);
  const latest = decodeRound(latestHex!)!;
  const latestId = BigInt(latest.roundId);
  const phase = latestId >> 64n;
  const last = latestId & ((1n << 64n) - 1n);
  const have = new Set(cached.map((r) => r.roundId));

  const wanted: bigint[] = [];
  for (let i = 1n; i <= last; i++) {
    const id = (phase << 64n) | i;
    if (!have.has(id.toString())) wanted.push(id);
  }
  const rounds = [...cached];
  const save = () => {
    rounds.sort((a, b) => a.updatedAt - b.updatedAt);
    writeFileSync(cache, JSON.stringify({ source: `Chainlink ${feed} on Robinhood Chain mainnet`, updatedAt: new Date().toISOString(), rounds }) + "\n");
  };
  for (let i = 0; i < wanted.length; i += 20) {
    const results = await rpcBatch(feed, wanted.slice(i, i + 20).map(encodeRoundId));
    for (const r of results) {
      const round = r ? decodeRound(r) : null;
      if (round) rounds.push(round);
    }
    save(); // keep progress if the endpoint cuts us off
    await sleep(1000);
  }
  save();
  return rounds;
}

async function main() {
  const fetched = await allRounds(FEED, roundsCache("TSLA"));
  const rounds = onScale(fetched);
  const first = rounds[0]!;
  const pyth = JSON.parse(readFileSync(join(HERE, "data", "pyth-tsla-gaps.json"), "utf8")) as {
    gaps: { from: string; to: string; open: number }[];
  };
  const rows = pyth.gaps
    .map((g) => ({ date: g.to, openTs: nyTime(g.to, 9, 30) / 1000, pythOpen: g.open }))
    .filter((g) => g.openTs > first.updatedAt)
    .map((g) => {
      const inForce = [...rounds].reverse().find((r) => r.updatedAt <= g.openTs)!;
      const after = rounds.find((r) => r.updatedAt >= g.openTs);
      return {
        date: g.date,
        inForceErrBps: errBps(inForce.answer, g.pythOpen),
        inForceAgeMin: (g.openTs - inForce.updatedAt) / 60,
        afterErrBps: after ? errBps(after.answer, g.pythOpen) : null,
        afterDelayMin: after ? (after.updatedAt - g.openTs) / 60 : null,
      };
    });

  const perDay = rounds.length / ((rounds.at(-1)!.updatedAt - first.updatedAt) / 86400);
  const after = rows.filter((r) => r.afterErrBps !== null);
  const lines = [
    `# Settling on the open with Chainlink's TSLA feed on Robinhood Chain`,
    ``,
    `Generated ${new Date().toISOString()} by \`npx tsx research/chainlink.ts\`. Feed ${FEED}: ${rounds.length} rounds since ${new Date(first.updatedAt * 1000).toISOString().slice(0, 10)}, ${perDay.toFixed(1)} a day on average (${fetched.length - rounds.length} launch-day rounds published at the wrong scale left out).`,
    `Compared with Pyth's first print at or after 09:30 ET on ${rows.length} openings.`,
    ``,
    `| Rule | Error vs Pyth open (median / mean / max, bps) | Timing (median / max, minutes) |`,
    `|---|---|---|`,
    `| Round in force at 09:30 ET | ${median(rows.map((r) => r.inForceErrBps)).toFixed(1)} / ${mean(rows.map((r) => r.inForceErrBps)).toFixed(1)} / ${Math.max(...rows.map((r) => r.inForceErrBps)).toFixed(1)} | published ${median(rows.map((r) => r.inForceAgeMin)).toFixed(0)} / ${Math.max(...rows.map((r) => r.inForceAgeMin)).toFixed(0)} min before |`,
    `| First round at or after 09:30 ET | ${median(after.map((r) => r.afterErrBps!)).toFixed(1)} / ${mean(after.map((r) => r.afterErrBps!)).toFixed(1)} / ${Math.max(...after.map((r) => r.afterErrBps!)).toFixed(1)} | published ${median(after.map((r) => r.afterDelayMin!)).toFixed(0)} / ${Math.max(...after.map((r) => r.afterDelayMin!)).toFixed(0)} min after |`,
  ];
  writeFileSync(join(HERE, "results", "chainlink-settlement.md"), lines.join("\n") + "\n");
  console.log(lines.join("\n"));
}

if (import.meta.filename === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
