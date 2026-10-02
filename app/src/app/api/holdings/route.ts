import { PublicKey } from "@solana/web3.js";

import { holdings } from "@/server/holdings";

export const dynamic = "force-dynamic";

/** Share-equivalents a wallet holds on mainnet of each covered stock (TSLAx, TSLAon, QQQx, QQQon). Read-only. */
export async function GET(req: Request) {
  let owner: PublicKey;
  try {
    owner = new PublicKey(new URL(req.url).searchParams.get("owner") ?? "");
  } catch {
    return Response.json({ error: "owner must be a Solana address" }, { status: 400 });
  }
  try {
    return Response.json({ holdings: await holdings(owner) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 503 });
  }
}
