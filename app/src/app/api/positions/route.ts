import { PublicKey } from "@solana/web3.js";
import { isAddress } from "viem";

import { positionsHeldBy } from "@/server/chain";
import { evmVaultState } from "@/server/evmChain";

export const dynamic = "force-dynamic";

/**
 * The positions not yet paid out whose NFTs a wallet holds (whoever holds one
 * is paid): from the Solana vault for a Solana address, from the Robinhood
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
  let key: PublicKey;
  try {
    key = new PublicKey(owner);
  } catch {
    return Response.json({ error: "owner must be a Solana or EVM address" }, { status: 400 });
  }
  try {
    const held = await positionsHeldBy(key);
    return Response.json({ positions: (held ?? []).sort((a, b) => b.openTs - a.openTs) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 503 });
  }
}
