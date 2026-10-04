import { NotAWallet } from "@/server/kaminoLoans";
import { kaminoCover, sampleCover } from "@/server/kaminoCover";

export const dynamic = "force-dynamic";

/** Auto-cover for a wallet's Kamino loans: protection starting at the opening that liquidates each, sized to repay the shortfall, and its price. */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  if (params.get("sample")) return Response.json(await sampleCover(), { status: 200 });
  const wallet = params.get("wallet")?.trim();
  if (!wallet) return Response.json({ error: "wallet is required" }, { status: 400 });
  try {
    return Response.json(await kaminoCover(wallet));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: e instanceof NotAWallet ? 400 : 503 });
  }
}
