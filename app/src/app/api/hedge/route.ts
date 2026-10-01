import { hedgeSummary } from "@/server/hedge";

export const dynamic = "force-dynamic";

/** The short in xyz:TSLA the vaults' open protection calls for, and the hedge account's position: read from public endpoints, no key. */
export async function GET() {
  try {
    return Response.json(await hedgeSummary());
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 503 });
  }
}
