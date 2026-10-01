/**
 * Read-only: fetches Pyth's first TSLA print at or after an open and says
 * whether the vault would settle on it (the same check the keeper and the
 * program make). Checks the API key, the endpoint and the settle window
 * before a real settlement depends on them.
 *
 *   PYTH_API_KEY=<your key> npx tsx solana/scripts/check-pyth.ts [open unix seconds]
 *
 * Defaults to Friday 25 Sep 2026's open (1790343000).
 */
import { DEFAULT_PARAMS, TSLA_FEED_ID } from "../client/vault";
import { hermesFromEnv, settlementUpdate } from "../keeper/pyth";

async function main() {
  const openTs = Number(process.argv[2] ?? 1_790_343_000);
  const u = await settlementUpdate(hermesFromEnv(), TSLA_FEED_ID, openTs, DEFAULT_PARAMS);
  console.log(`open             ${new Date(openTs * 1000).toISOString()}`);
  console.log(`first print      $${u.price} at ${new Date(u.publishTime * 1000).toISOString()} (${u.publishTime - openTs}s after the open)`);
  console.log(`previous print   ${new Date(u.prevPublishTime * 1000).toISOString()}`);
  console.log(`the vault would settle on it; ${u.data.length} update(s) to post`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
