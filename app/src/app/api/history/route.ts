import { PublicKey } from "@solana/web3.js";
import { isAddress } from "viem";

import { solanaPositionTxs, solanaVaultState } from "@/server/chain";
import { evmVaultState } from "@/server/evmChain";

export const dynamic = "force-dynamic";

/**
 * Every position a wallet bought, newest first, paid out or not: from the
 * Solana vault for a Solana address, from the Robinhood Chain vault for an
 * EVM one. Paid positions stay on-chain with what they paid, so this is read
 * straight from state.
 */
export async function GET(req: Request) {
  const owner = new URL(req.url).searchParams.get("owner") ?? "";
  let state;
  let mine: (buyer: string) => boolean;
  if (isAddress(owner)) {
    state = evmVaultState();
    mine = (b) => b.toLowerCase() === owner.toLowerCase();
  } else {
    try {
      const key = new PublicKey(owner).toBase58();
      mine = (b) => b === key;
    } catch {
      return Response.json({ error: "owner must be a Solana or EVM address" }, { status: 400 });
    }
    state = solanaVaultState();
  }
  if (!state) return Response.json({ history: [] });
  try {
    const s = await state;
    const history = s.history
      .filter((h) => mine(h.buyer))
      .map(({ buyer: _, ...h }) => h)
      .sort((a, b) => b.openTs - a.openTs);
    // Solana's transactions are found per position, so only for this wallet's.
    if (!isAddress(owner))
      await Promise.all(history.map(async (h) => Object.assign(h, await solanaPositionTxs(h.address, h.paid !== null).catch(() => ({})))));
    return Response.json({ history });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 503 });
  }
}
