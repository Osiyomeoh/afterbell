import { waitlistView } from "@/server/waitlist";

export const dynamic = "force-dynamic";

/** The mainnet waitlist as read from devnet: how many wallets, what they'd protect, and each signup's transaction. */
export async function GET() {
  try {
    return Response.json(await waitlistView(), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
