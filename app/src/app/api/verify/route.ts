import { verifyView } from "@/server/verify";

export const dynamic = "force-dynamic";

/** What /verify shows, as JSON: every settlement, renewal, hedge trade and private payment, each with the transaction that shows it. */
export async function GET() {
  try {
    return Response.json(await verifyView());
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 503 });
  }
}
