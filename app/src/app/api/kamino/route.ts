import { kaminoView } from "@/server/kamino";

export const dynamic = "force-dynamic";

/** Kamino's tokenized-stock collateral and what protecting it until the next open costs now. */
export async function GET() {
  try {
    return Response.json(await kaminoView());
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 503 });
  }
}
