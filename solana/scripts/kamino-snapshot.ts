/**
 * Saves Kamino's xStocks market, as kaminoFork loads it, from mainnet
 * (read-only) into solana/fixtures/kamino, so `npm run prove` needs no RPC.
 *
 *   npm run solana:kamino-snapshot
 *
 * MAINNET_RPC_URL defaults to the public mainnet RPC.
 */
import { snapshotKamino, SNAPSHOT_DIR } from "./kaminoFork";

snapshotKamino().then(
  ({ accounts, slot }) => console.log(`saved ${accounts} accounts and Kamino's two programs at slot ${slot} into ${SNAPSHOT_DIR}`),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
