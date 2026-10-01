import { solanaVaultState } from "@/server/chain";
import { evmVaultState } from "@/server/evmChain";
import { firstVault } from "@/server/firstVault";

export const dynamic = "force-dynamic";

/**
 * A vault's collateral, locked payouts and series: Solana's, or Robinhood Chain's with `?chain=robinhood`.
 * Solana's also carries what its first vault still has open.
 */
export async function GET(req: Request) {
  const robinhood = new URL(req.url).searchParams.get("chain") === "robinhood";
  const state = robinhood ? evmVaultState() : solanaVaultState();
  if (!state) return Response.json({ error: `the ${robinhood ? "Robinhood Chain vault" : "Solana vault v2"} isn't deployed yet` }, { status: 404 });
  try {
    const [s, first] = await Promise.all([state, robinhood ? null : firstVault()]);
    return Response.json({ ...s, positions: undefined, ledger: undefined, openPositions: s.positions.length, ...(first && { firstVault: first }) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 503 });
  }
}
