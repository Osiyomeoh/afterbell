/**
 * Finding the Chainlink round the EVM vault settles on: the last one
 * published at or before the open, in the feed's current phase (round ids are
 * `phase << 64 | index`, and the contract checks the round after it in the
 * same phase). Mirrors AfterbellVault.settle so the keeper never pays for a
 * transaction the contract would reject.
 */

export type Round = { roundId: bigint; answer: bigint; updatedAt: bigint };

export type FeedReader = {
  latest(): Promise<Round>;
  /** Null when the round doesn't exist. */
  round(roundId: bigint): Promise<Round | null>;
};

const INDEX_MASK = (1n << 64n) - 1n;

/** The round in force at `openTs`, or null when the current phase has none at or before it. */
export async function roundInForce(feed: FeedReader, openTs: bigint): Promise<Round | null> {
  const latest = await feed.latest();
  // Nothing published since the open (yet): the latest round is the one in force.
  if (latest.updatedAt <= openTs) return latest;
  const phase = latest.roundId >> 64n;
  let lo = 1n;
  let hi = (latest.roundId & INDEX_MASK) - 1n;
  let found: Round | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) / 2n;
    const r = await feed.round((phase << 64n) | mid);
    if (r && r.updatedAt > 0n && r.updatedAt <= openTs) {
      found = r;
      lo = mid + 1n;
    } else {
      hi = mid - 1n;
    }
  }
  return found;
}

/** The strikes a series sold (AfterbellVault's Series.lowestLower and highestUpper); highestUpper is 0 before any sale. */
export type StrikeRange = { lowestLower: bigint; highestUpper: bigint };

/** As AfterbellVault.MAX_PRICE_RATIO: how far from its strikes a series may settle. */
export const MAX_PRICE_RATIO = 10n;

/** Why the contract would refuse to settle on `r`, or null if it will accept it. */
export function settleError(r: Round, openTs: bigint, maxRoundAge: bigint, strikes?: StrikeRange): string | null {
  if (r.updatedAt > openTs) return "the round is after the open";
  if (openTs - r.updatedAt > maxRoundAge) return "the round in force is older than the vault accepts";
  if (r.answer <= 0n || r.answer > (1n << 64n) - 1n) return "the round's price is out of range";
  if (strikes && strikes.highestUpper > 0n && (r.answer > strikes.highestUpper * MAX_PRICE_RATIO || r.answer * MAX_PRICE_RATIO < strikes.lowestLower)) {
    return `the round's price is more than ${MAX_PRICE_RATIO} times from the series' strikes, a broken feed rather than a market`;
  }
  return null;
}

/**
 * A reader that remembers rounds (a published round never changes) and the
 * latest for `latestTtlMs`, so finding the round in force, which reads a dozen
 * rounds, costs one call after the first time.
 */
export function cachedReader(feed: FeedReader, latestTtlMs: number, clock: () => number = Date.now): FeedReader {
  const rounds = new Map<bigint, Round>();
  let latest: { at: number; round: Promise<Round> } | undefined;
  return {
    latest() {
      if (!latest || clock() - latest.at > latestTtlMs) {
        const round = feed.latest();
        latest = { at: clock(), round };
        round.catch(() => (latest = undefined));
      }
      return latest.round;
    },
    async round(roundId) {
      const hit = rounds.get(roundId);
      if (hit) return hit;
      const r = await feed.round(roundId);
      // Only a published round is final; a missing one may yet appear.
      if (r && r.updatedAt > 0n) rounds.set(roundId, r);
      return r;
    },
  };
}
