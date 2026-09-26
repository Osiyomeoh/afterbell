import { createPublicClient, http } from "viem";

import { afterbellPositionsAbi } from "@root/evm/client/abi";
import { evmChain } from "@root/evm/client/vault";

import { evmDeployment } from "@/server/evmDeployment";

export const dynamic = "force-dynamic";

/**
 * A Robinhood Chain position's NFT image, as its contract draws it on-chain
 * (tokenURI's JSON carries the SVG). Served as an image, with scripts off,
 * so the page can show it in an <img>.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = evmDeployment();
  if (!d) return new Response("the Robinhood Chain vault isn't deployed yet", { status: 404 });
  if (!/^\d{1,18}$/.test(id)) return new Response("id must be a position number", { status: 400 });
  try {
    const client = createPublicClient({ chain: evmChain(d), transport: http(d.rpc) });
    const uri = await client.readContract({ address: d.positions, abi: afterbellPositionsAbi, functionName: "tokenURI", args: [BigInt(id)] });
    const meta = JSON.parse(Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64").toString("utf8")) as { image: string };
    const svg = Buffer.from(meta.image.slice(meta.image.indexOf(",") + 1), "base64");
    return new Response(svg, {
      headers: {
        "content-type": "image/svg+xml",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        // Its status line changes when the series settles and when it's paid.
        "cache-control": "public, max-age=30",
      },
    });
  } catch (e) {
    return new Response((e as Error & { shortMessage?: string }).shortMessage ?? (e as Error).message, { status: 404 });
  }
}
