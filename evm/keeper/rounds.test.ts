import { describe, expect, it } from "vitest";

import { cachedReader, roundInForce, settleError, type FeedReader, type Round } from "./rounds";

const PHASE = 1n << 64n;
/** A feed whose rounds 1..n in phase 1 were published at the given times. */
function feed(times: number[]): FeedReader & { reads: number } {
  const rounds: Round[] = times.map((t, i) => ({ roundId: PHASE | BigInt(i + 1), answer: 38_000_000_000n + BigInt(i), updatedAt: BigInt(t) }));
  const f = {
    reads: 0,
    latest: async () => rounds[rounds.length - 1]!,
    round: async (id: bigint) => {
      f.reads++;
      return rounds.find((r) => r.roundId === id) ?? null;
    },
  };
  return f;
}

describe("the Chainlink round in force at the open", () => {
  // Rounds at 100, 200, ..., 1000.
  const times = Array.from({ length: 10 }, (_, i) => (i + 1) * 100);

  it("is the last round published at or before the open", async () => {
    expect((await roundInForce(feed(times), 450n))?.roundId).toBe(PHASE | 4n);
    expect((await roundInForce(feed(times), 400n))?.roundId).toBe(PHASE | 4n);
    expect((await roundInForce(feed(times), 999n))?.roundId).toBe(PHASE | 9n);
  });

  it("is the latest round when nothing has been published since the open", async () => {
    const f = feed(times);
    expect((await roundInForce(f, 5_000n))?.roundId).toBe(PHASE | 10n);
    expect(f.reads).toBe(0);
  });

  it("doesn't exist when the phase began after the open", async () => {
    expect(await roundInForce(feed(times), 50n)).toBeNull();
  });

  it("is found in a few reads, not one per round", async () => {
    const f = feed(Array.from({ length: 1341 }, (_, i) => (i + 1) * 60));
    expect((await roundInForce(f, 60n * 700n + 30n))?.roundId).toBe(PHASE | 700n);
    expect(f.reads).toBeLessThanOrEqual(12);
  });
});

describe("what the contract accepts", () => {
  const r: Round = { roundId: PHASE | 1341n, answer: 38_382_840_000n, updatedAt: 1_790_342_808n };
  it("takes a fresh round at or before the open", () => {
    expect(settleError(r, 1_790_343_000n, 3n * 86_400n)).toBeNull();
  });
  it("refuses stale rounds, rounds after the open and bad prices", () => {
    expect(settleError(r, 1_790_342_808n + 3n * 86_400n + 1n, 3n * 86_400n)).toBe("the round in force is older than the vault accepts");
    expect(settleError(r, 1_790_342_000n, 3n * 86_400n)).toBe("the round is after the open");
    expect(settleError({ ...r, answer: 0n }, 1_790_343_000n, 3n * 86_400n)).toBe("the round's price is out of range");
  });
});

describe("a cached reader", () => {
  it("reads each published round once, and the latest again only after its ttl", async () => {
    const f = feed(Array.from({ length: 1341 }, (_, i) => (i + 1) * 60));
    let latestReads = 0;
    const counted = { ...f, latest: () => (latestReads++, f.latest()) };
    let now = 0;
    const c = cachedReader(counted, 5_000, () => now);
    await roundInForce(c, 60n * 700n + 30n);
    const first = f.reads;
    expect((await roundInForce(c, 60n * 700n + 30n))?.roundId).toBe(PHASE | 700n);
    expect(f.reads).toBe(first);
    expect(latestReads).toBe(1);
    now = 6_000;
    await c.latest();
    expect(latestReads).toBe(2);
  });

  it("doesn't remember a round that isn't there yet", async () => {
    const f = feed([100, 200]);
    const c = cachedReader(f, 5_000);
    expect(await c.round(PHASE | 3n)).toBeNull();
    expect(await c.round(PHASE | 3n)).toBeNull();
    expect(f.reads).toBe(2);
  });
});
