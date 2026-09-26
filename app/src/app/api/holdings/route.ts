import { PublicKey } from "@solana/web3.js";

import { tslaHoldings } from "@/server/holdings";

export const dynamic = "force-dynamic";

/** TSLA share-equivalents a wallet holds on mainnet (TSLAx, TSLAon). Read-only. */
export async function GET(req: Request) {
  let owner: PublicKey;
  try {
    owner = new PublicKey(new URL(req.url).searchParams.get("owner") ?? "");
  } catch {
    return Response.json({ error: "owner must be a Solana address" }, { status: 400 });
  }
  try {
    return Response.json({ holdings: await tslaHoldings(owner) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 503 });
  }
}
