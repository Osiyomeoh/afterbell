import { isAddress } from "viem";

import { evmUnderwriter } from "@/server/evmChain";

export const dynamic = "force-dynamic";

/** One underwriter's stake in the Robinhood Chain pool: shares, their value, and requests pending or filled. */
export async function GET(req: Request) {
  const owner = new URL(req.url).searchParams.get("owner") ?? "";
  if (!isAddress(owner)) return Response.json({ error: "owner must be an EVM address" }, { status: 400 });
  try {
    const stake = await evmUnderwriter(owner);
    if (!stake) return Response.json({ error: "the Robinhood Chain vault isn't deployed yet" }, { status: 404 });
    return Response.json(stake);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 503 });
  }
}
