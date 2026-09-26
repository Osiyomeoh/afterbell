import { Connection, PublicKey } from "@solana/web3.js";

import { SOLANA_DEPLOYMENT } from "@/server/deployment";
import { keypairFromEnv } from "@/server/env";
import { drip } from "@/server/faucet";

export const dynamic = "force-dynamic";

const RPC = process.env.SOLANA_RPC || process.env.NEXT_PUBLIC_SOLANA_RPC || "https://api.devnet.solana.com";

export async function POST(req: Request) {
  let owner: PublicKey;
  try {
    const body = (await req.json()) as { owner?: unknown };
    if (typeof body.owner !== "string") throw new Error();
    owner = new PublicKey(body.owner);
    // A program address can't sign, so it could never spend what it's sent.
    if (!PublicKey.isOnCurve(owner.toBytes())) throw new Error();
  } catch {
    return Response.json({ error: "owner must be a wallet address" }, { status: 400 });
  }
  const faucet = keypairFromEnv("FAUCET_SOLANA_KEY");
  if (!faucet) return Response.json({ error: "the faucet isn't configured" }, { status: 503 });
  try {
    const r = await drip(new Connection(RPC, "confirmed"), faucet, new PublicKey(SOLANA_DEPLOYMENT.collateralMint), owner);
    return Response.json({ ...r, alreadyFunded: r.signature === null });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
