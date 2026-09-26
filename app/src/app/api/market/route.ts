import { nextOpen } from "@root/quoter/calendar";
import { DEFAULT_QUOTER_CONFIG, referencePrice } from "@root/quoter/quoter";

import { SOLANA_DEPLOYMENT } from "@/server/deployment";
import { evmDeployment } from "@/server/evmDeployment";
import { marketSnapshot } from "@/server/market";

export const dynamic = "force-dynamic";

/** Everything the browser needs to price protection itself while the buyer adjusts the ticket. */
export async function GET() {
  try {
    const snap = await marketSnapshot();
    const now = Math.floor(Date.now() / 1000);
    const m = snap.market;
    let reference: { price: number; basis: string } | null = null;
    let paused: string | null = null;
    try {
      reference = referencePrice(now, m);
    } catch (e) {
      paused = (e as Error).message;
    }
    const cfg = DEFAULT_QUOTER_CONFIG;
    const evm = evmDeployment();
    return Response.json({
      symbol: m.symbol,
      now,
      close: m.close,
      closeTs: snap.closeTs,
      closeSource: snap.closeSource,
      live: m.live ?? null,
      liveSource: snap.liveSource,
      inSession: snap.inSession,
      reference,
      paused,
      nextOpen: nextOpen(now, cfg.stopBeforeOpenSecs + cfg.ttlSecs, m.holidays),
      holidays: [...m.holidays],
      earlyCloses: [...(m.earlyCloses ?? new Map())],
      history: m.history,
      annualVol: m.annualVol,
      config: cfg,
      solana: { cluster: "devnet", ...SOLANA_DEPLOYMENT },
      // Null until the Robinhood Chain vault is deployed. Buying there also needs the quoter's key on the server.
      robinhood: evm && { ...evm, selling: !!process.env.QUOTER_EVM_KEY },
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 503 });
  }
}
