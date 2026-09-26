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

/** Why the contract would refuse to settle on `r`, or null if it will accept it. */
export function settleError(r: Round, openTs: bigint, maxRoundAge: bigint): string | null {
  if (r.updatedAt > openTs) return "the round is after the open";
  if (openTs - r.updatedAt > maxRoundAge) return "the round in force is older than the vault accepts";
  if (r.answer <= 0n || r.answer > (1n << 64n) - 1n) return "the round's price is out of range";
  return null;
}
