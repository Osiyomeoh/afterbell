import { nextOpen } from "@root/quoter/calendar";
import { DEFAULT_QUOTER_CONFIG, referencePrice } from "@root/quoter/quoter";

import { SOLANA_DEPLOYMENT } from "@/server/deployment";
import { evmDeployment } from "@/server/evmDeployment";
import { marketSnapshot, onSolanaVault, pricedStock, pricedStocks } from "@/server/market";

export const dynamic = "force-dynamic";

/**
 * Everything the browser needs to price protection on one stock itself while
 * the buyer adjusts the ticket: `?symbol=QQQ`, TSLA by default.
 */
export async function GET(req: Request) {
  const stock = pricedStock(new URL(req.url).searchParams.get("symbol"));
  if (!stock) return Response.json({ error: `unknown stock; one of ${pricedStocks().map((s) => s.symbol).join(", ")}` }, { status: 404 });
  try {
    const snap = await marketSnapshot(stock);
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
    const robinhoodFeed = evm?.feeds[stock.symbol];
    return Response.json({
      symbol: m.symbol,
      name: stock.name,
      // Selling now on each vault, and which chains' oracles can settle it: Solana needs Pyth prints the key reads, Robinhood Chain a Chainlink feed.
      stocks: pricedStocks().map((s) => ({
        symbol: s.symbol,
        name: s.name,
        solana: onSolanaVault(s),
        robinhood: !!evm?.feeds[s.symbol],
        settles: [...(s.pyth ? ["solana"] : []), ...(s.chainlink ? ["robinhood"] : [])],
      })),
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
      hyperliquid: { coin: stock.hyperliquid ?? null, tracks: stock.hyperliquidTracks, ratio: snap.hyperliquidRatio ?? null },
      // Null until the Solana vault v2 is deployed.
      solana: SOLANA_DEPLOYMENT && { cluster: "devnet", ...SOLANA_DEPLOYMENT, selling: onSolanaVault(stock) },
      // Null until the Robinhood Chain vault is deployed. Buying there also needs a Chainlink feed for the stock and the quoter's key on the server.
      robinhood: evm && { ...evm, selling: !!process.env.QUOTER_EVM_KEY && !!robinhoodFeed },
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 503 });
  }
}
