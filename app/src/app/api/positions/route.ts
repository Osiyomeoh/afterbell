import { PublicKey } from "@solana/web3.js";

import { vaultState } from "@/server/chain";

export const dynamic = "force-dynamic";

/** One buyer's positions that haven't been claimed yet (a claim closes the position). */
export async function GET(req: Request) {
  const owner = new URL(req.url).searchParams.get("owner") ?? "";
  try {
    new PublicKey(owner);
  } catch {
    return Response.json({ error: "owner must be a Solana address" }, { status: 400 });
  }
  try {
    const s = await vaultState();
    return Response.json({ positions: s.positions.filter((p) => p.buyer === owner).sort((a, b) => b.openTs - a.openTs) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 503 });
  }
}
