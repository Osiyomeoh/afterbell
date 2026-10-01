import { PublicKey } from "@solana/web3.js";

import { metadata } from "@root/solana/client/art";

import { positionCard } from "@/server/chain";

export const dynamic = "force-dynamic";

/**
 * A Solana position's NFT metadata: the JSON its on-chain `uri` points at
 * (the vault's art URI plus the position's address), drawn from the
 * position's accounts, with the image beside it.
 */
export async function GET(req: Request, { params }: { params: Promise<{ position: string }> }) {
  const { position } = await params;
  let address: PublicKey;
  try {
    address = new PublicKey(position);
  } catch {
    return Response.json({ error: "not a position address" }, { status: 400 });
  }
  try {
    const card = await positionCard(address);
    if (!card) return Response.json({ error: "no such position in this vault" }, { status: 404 });
    const image = `${new URL(req.url).origin}/api/position-art/solana/${address.toBase58()}/image`;
    // Its status changes when the series settles and when it's paid.
    return Response.json(metadata(card, image), { headers: { "cache-control": "public, max-age=30" } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 503 });
  }
}
