import { board } from "@/server/board";

export const dynamic = "force-dynamic";

/** Standard cover (2% to 10% below) on one share of every stock the app prices, refreshed at most every minute. */
export async function GET() {
  try {
    return Response.json({ rows: await board() });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 503 });
  }
}
