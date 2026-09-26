import { evmVaultState } from "@/server/evmChain";
import { solanaLedger } from "@/server/ledger";

export const dynamic = "force-dynamic";

/** Every series either vault has sold: what it took in, how it settled, and what it paid out. */
export async function GET() {
  try {
    const [solana, evm] = await Promise.all([solanaLedger(), evmVaultState()]);
    const series = [...solana, ...(evm?.ledger ?? [])].sort((a, b) => b.openTs - a.openTs);
    return Response.json({ series });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 503 });
  }
}
