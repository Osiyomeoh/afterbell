import { vaultState } from "@/server/chain";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const s = await vaultState();
    return Response.json({ ...s, positions: undefined, openPositions: s.positions.length });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 503 });
  }
}
