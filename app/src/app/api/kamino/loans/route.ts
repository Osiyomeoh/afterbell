import { kaminoLoans, NotAWallet } from "@/server/kaminoLoans";

export const dynamic = "force-dynamic";

/** A wallet's loans against tokenized stocks on Kamino: the opening that liquidates each, and protection down to it. */
export async function GET(req: Request) {
  const wallet = new URL(req.url).searchParams.get("wallet")?.trim();
  if (!wallet) return Response.json({ error: "wallet is required" }, { status: 400 });
  try {
    return Response.json(await kaminoLoans(wallet));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: e instanceof NotAWallet ? 400 : 503 });
  }
}
