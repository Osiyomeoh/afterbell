import { PublicKey } from "@solana/web3.js";
import { isAddress } from "viem";

import { vaultState } from "@/server/chain";
import { evmVaultState } from "@/server/evmChain";

export const dynamic = "force-dynamic";

/**
 * One buyer's positions that haven't been claimed yet (a claim closes the
 * position): from the Solana vault for a Solana address, from the Robinhood
 * Chain vault for an EVM one.
 */
export async function GET(req: Request) {
  const owner = new URL(req.url).searchParams.get("owner") ?? "";
  if (isAddress(owner)) {
    const state = evmVaultState();
    if (!state) return Response.json({ positions: [] });
    try {
      const s = await state;
      return Response.json({ positions: s.positions.filter((p) => p.buyer.toLowerCase() === owner.toLowerCase()).sort((a, b) => b.openTs - a.openTs) });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 503 });
    }
  }
  try {
    new PublicKey(owner);
  } catch {
    return Response.json({ error: "owner must be a Solana or EVM address" }, { status: 400 });
  }
  try {
    const s = await vaultState();
    return Response.json({ positions: s.positions.filter((p) => p.buyer === owner).sort((a, b) => b.openTs - a.openTs) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 503 });
  }
}
