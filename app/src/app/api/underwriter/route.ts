import { PublicKey } from "@solana/web3.js";
import { isAddress } from "viem";

import { solanaUnderwriter } from "@/server/chain";
import { evmUnderwriter } from "@/server/evmChain";

export const dynamic = "force-dynamic";

/** One underwriter's stake in a pool: shares, their value, and requests pending or filled. Robinhood Chain's for an EVM address, Solana's for a Solana one. */
export async function GET(req: Request) {
  const owner = new URL(req.url).searchParams.get("owner") ?? "";
  let key: PublicKey | null = null;
  if (!isAddress(owner)) {
    try {
      key = new PublicKey(owner);
    } catch {
      return Response.json({ error: "owner must be a Solana or EVM address" }, { status: 400 });
    }
  }
  try {
    const stake = key ? await solanaUnderwriter(key) : await evmUnderwriter(owner as `0x${string}`);
    if (!stake) return Response.json({ error: `the ${key ? "Solana vault v2" : "Robinhood Chain vault"} isn't deployed yet` }, { status: 404 });
    return Response.json(stake);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 503 });
  }
}
