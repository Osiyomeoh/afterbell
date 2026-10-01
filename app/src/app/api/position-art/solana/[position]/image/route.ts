import { PublicKey } from "@solana/web3.js";

import { svg } from "@root/solana/client/art";

import { positionCard } from "@/server/chain";

export const dynamic = "force-dynamic";

/**
 * A Solana position's NFT image, the same card the Robinhood Chain contract
 * draws. Served as an image, with scripts off, so a page can show it in an <img>.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ position: string }> }) {
  const { position } = await params;
  let address: PublicKey;
  try {
    address = new PublicKey(position);
  } catch {
    return new Response("not a position address", { status: 400 });
  }
  try {
    const card = await positionCard(address);
    if (!card) return new Response("no such position in this vault", { status: 404 });
    return new Response(svg(card), {
      headers: {
        "content-type": "image/svg+xml",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        // Its status line changes when the series settles and when it's paid.
        "cache-control": "public, max-age=30",
      },
    });
  } catch (e) {
    return new Response((e as Error).message, { status: 503 });
  }
}
