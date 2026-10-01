import { pricedStock, pricedStocks } from "@/server/market";
import { overnight } from "@/server/overnight";

export const dynamic = "force-dynamic";

/** A stock's price since the last close, from Hyperliquid: `?symbol=QQQ`, TSLA by default. */
export async function GET(req: Request) {
  const stock = pricedStock(new URL(req.url).searchParams.get("symbol"));
  if (!stock) return Response.json({ error: `unknown stock; one of ${pricedStocks().map((s) => s.symbol).join(", ")}` }, { status: 404 });
  try {
    return Response.json(await overnight(stock));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 503 });
  }
}
