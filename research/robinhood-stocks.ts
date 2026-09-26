/**
 * The stocks Robinhood Chain can settle: every US equity feed Chainlink
 * publishes there, with the Hyperliquid perp that can hedge it and the Pyth
 * feed whose public market-hours schedule gives its holidays. Writes
 * research/data/robinhood-stocks.json, which quoter/stocks.ts reads, keeping
 * each stock's annualVol (measured by research/chainlink-openings.ts; run that
 * next for a new stock). Re-run when Chainlink adds feeds.
 *
 *   npx tsx research/robinhood-stocks.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIRECTORY = "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json";
const BENCHMARKS = "https://benchmarks.pyth.network/v1/price_feeds/?asset_type=equity";
const HYPERLIQUID = "https://api.hyperliquid.xyz/info";
const OUT = join(import.meta.dirname, "data", "robinhood-stocks.json");

/** Feeds with no opening gap worth protecting: a T-bill fund barely moves overnight. */
const SKIP = new Set(["SGOV"]);
/** Funds whose Hyperliquid perp tracks what they hold, at a different level. */
const INDEX_PERP: Record<string, string> = { SPY: "SP500", QQQ: "XYZ100", SLV: "SILVER", USO: "CL" };
/** Short names for display; Pyth's are the listing's, in capitals. A new feed needs one here. */
const NAMES: Record<string, string> = {
  AAPL: "Apple", AMD: "AMD", AMZN: "Amazon", ASML: "ASML", BABA: "Alibaba", CLSK: "CleanSpark", COIN: "Coinbase",
  CRCL: "Circle", CRWV: "CoreWeave", DELL: "Dell", EWY: "South Korea (EWY)", GME: "GameStop", GOOGL: "Alphabet",
  INTC: "Intel", IONQ: "IonQ", META: "Meta", MSFT: "Microsoft", MSTR: "Strategy", MU: "Micron", NBIS: "Nebius",
  NVDA: "Nvidia", ORCL: "Oracle", PLTR: "Palantir", QQQ: "Nasdaq-100 (QQQ)", RGTI: "Rigetti", RKLB: "Rocket Lab",
  SLV: "Silver (SLV)", SNDK: "Sandisk", SPCX: "SpaceX", SPY: "S&P 500 (SPY)", TSLA: "Tesla", TSM: "TSMC",
  USAR: "USA Rare Earth", USO: "Oil (USO)",
};

const get = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, { ...init, headers: { "user-agent": "afterbell-research/0.1", ...init?.headers } });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return (await res.json()) as T;
};

type Entry = { symbol: string; name: string; listing: string; feedId: string; chainlink: string; hyperliquid: string | null; hyperliquidTracks: "stock" | "index"; annualVol?: number };

async function main() {
  const feeds = await get<{ name: string; proxyAddress: string; docs?: { marketHours?: string } }[]>(DIRECTORY);
  const [meta] = await get<[{ universe: { name: string; isDelisted?: boolean }[] }, unknown]>(HYPERLIQUID, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs", dex: "xyz" }),
  });
  const perps = new Set(meta.universe.filter((u) => !u.isDelisted).map((u) => u.name));
  const pyth = new Map<string, { id: string; description: string }>();
  for (const f of await get<{ id: string; attributes?: { symbol?: string; description?: string; schedule?: string } }[]>(BENCHMARKS)) {
    const s = f.attributes?.symbol ?? "";
    if (s.startsWith("Equity.US.") && s.endsWith("/USD") && f.attributes?.schedule) pyth.set(s.slice(10, -4), { id: "0x" + f.id.replace(/^0x/, ""), description: f.attributes.description ?? "" });
  }

  const before = new Map<string, Entry>(existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")) as { stocks: Entry[] }).stocks.map((s) => [s.symbol, s]) : []);
  const out: Entry[] = [];
  for (const f of feeds) {
    const m = /^Robinhood (\w+)\s*[-/]\s*USD$/.exec(f.name);
    if (!m || f.docs?.marketHours !== "us_equities_24/5") continue;
    const symbol = m[1]!;
    if (SKIP.has(symbol)) continue;
    const p = pyth.get(symbol);
    if (!p) {
      console.log(`skip ${symbol}: no Pyth market-hours schedule`);
      continue;
    }
    if (!NAMES[symbol]) throw new Error(`${symbol} is new: give it a short name in NAMES`);
    const perp = `xyz:${INDEX_PERP[symbol] ?? symbol}`;
    const annualVol = before.get(symbol)?.annualVol;
    out.push({
      symbol,
      name: NAMES[symbol],
      listing: p.description.replace(/ \/ US DOLLAR$/, ""),
      feedId: p.id,
      chainlink: f.proxyAddress,
      hyperliquid: perps.has(perp) ? perp : null,
      hyperliquidTracks: INDEX_PERP[symbol] ? "index" : "stock",
      ...(annualVol !== undefined && { annualVol }),
    });
  }
  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  writeFileSync(OUT, JSON.stringify({ source: `${DIRECTORY}, Hyperliquid xyz perps, Pyth equity schedules`, generatedAt: new Date().toISOString(), stocks: out }, null, 1) + "\n");
  console.log(`${out.length} stocks (${out.filter((s) => s.hyperliquid).length} with a Hyperliquid perp) → ${OUT}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
