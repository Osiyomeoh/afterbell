/**
 * The hedger, once: the short in xyz:TSLA that offsets what the vaults have
 * sold, against the short held now. Only --plan is built so far: it reads,
 * prints and sends nothing. Sending waits for the API wallet (docs/hedger.md,
 * step 6).
 *
 *   npm run hedger -- --plan
 *
 * RPC_URL              Solana RPC, defaults to devnet
 * DEPLOYMENTS          vault v2, defaults to solana/deployments/devnet.json
 * DEPLOYMENTS_V1       vault v1, defaults to solana/deployments/devnet-v1.json (skipped if missing)
 * HYPERLIQUID_NETWORK  where the hedge trades: testnet (default) or mainnet
 * HEDGE_ACCOUNT        the hedge account's address; without it the short held is taken as none
 * HEDGE_MAX_NOTIONAL   the most the short may be worth, in dollars (default 1500:
 *                      about what 500 mock USDC of margin carries at 3×)
 *
 * Every read is public and needs no key: both vaults' accounts on Solana,
 * Pyth's market-hours schedule (holidays, for the model), mainnet's xyz:TSLA
 * mid, and the hedge network's market list and the account's position.
 */
import { existsSync, readFileSync } from "node:fs";

import { Connection } from "@solana/web3.js";
import { getAddress } from "viem";

import type { Opening } from "../../pricing/model";
import { hyperliquidMid, pythCalendar } from "../../quoter/marketData";
import { modelFor } from "../../quoter/quoter";
import { TSLA } from "../../quoter/stocks";
import tslaGaps from "../../research/data/pyth-tsla-gaps.json" with { type: "json" };
import { DEFAULT_SLIPPAGE, type Network } from "../hyperliquid";
import { dexOf, fetchHedgeAccount, fetchMarket, postInfo, type HedgeAccount } from "../info";
import { planHedge, type HedgePlan } from "../plan";
import { openPositions, readVault, type VaultVersion } from "../solana";
import { hedgeNetwork, iso, maxNotional, sh, usd } from "./common";

function printAccount(account: HedgeAccount | null, network: Network, coin: string) {
  console.log("\nHEDGE ACCOUNT");
  if (!account) {
    console.log("  none given (HEDGE_ACCOUNT): the short held is taken as 0");
    return;
  }
  const funds = `${usd(account.accountValue)} on the ${dexOf(coin)} dex, ${usd(account.withdrawable)} withdrawable`;
  const p = account.position;
  console.log(`  ${account.address} on ${network}`);
  if (!p) {
    console.log(`  no ${coin} position; ${funds}`);
    return;
  }
  const side = p.short >= 0 ? `short ${sh(p.short)}` : `LONG ${sh(-p.short)}`;
  const entry = p.entryPx === null ? "" : ` from ${usd(p.entryPx)}`;
  const liq = p.liquidationPx === null ? "no liquidation price" : `liquidation at ${usd(p.liquidationPx)}`;
  console.log(`  ${side}${entry}, P&L ${usd(p.unrealizedPnl)}, ${liq}, ${p.leverage.type} ${p.leverage.value}×`);
  console.log(`  ${usd(p.marginUsed)} margin used; ${funds}`);
}

function printPlan(plan: HedgePlan, coin: string, mid: number) {
  const r = plan.rebalance;
  console.log(`\nTARGET  short ${sh(r.target)} (${usd(r.target * mid)})${r.capped ? `, capped: the hedge is ${sh(plan.exposure.hedge)}` : ""}`);
  console.log(`ACTION  ${r.note}`);
  const o = plan.order;
  if (!o) return;
  const pct = (Math.abs(Number(o.p) / mid - 1) * 100).toFixed(2);
  const side = o.b ? `buy back ${o.s} ${coin}, limit $${o.p} (${pct}% above the mid)` : `sell ${o.s} ${coin}, limit $${o.p} (${pct}% below the mid)`;
  console.log(`ORDER   ${side}, immediate-or-cancel${o.r ? ", reduce-only" : ""}; at most ${DEFAULT_SLIPPAGE * 100}% from the mid`);
  console.log(`        ${JSON.stringify(o)}`);
}

async function main() {
  if (!process.argv.includes("--plan")) {
    throw new Error("only --plan is built: the hedger sends orders once its API wallet is approved (docs/hedger.md, step 6)");
  }
  const network = hedgeNetwork();
  const cap = maxNotional();
  const address = process.env.HEDGE_ACCOUNT ? getAddress(process.env.HEDGE_ACCOUNT) : null;
  const stock = TSLA;
  const coin = stock.hyperliquid!;
  const history = tslaGaps.gaps as Opening[];

  const connection = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
  const vaults = [
    { label: "Solana v2", version: "v2" as VaultVersion, file: process.env.DEPLOYMENTS ?? "solana/deployments/devnet.json" },
    { label: "Solana v1", version: "v1" as VaultVersion, file: process.env.DEPLOYMENTS_V1 ?? "solana/deployments/devnet-v1.json" },
  ].filter((v) => existsSync(v.file));
  const now = Math.floor(Date.now() / 1000);

  const [books, mid, market, account, calendar] = await Promise.all([
    Promise.all(
      vaults.map(async (v) => {
        const d = JSON.parse(readFileSync(v.file, "utf8")) as { programId: string; vault: string };
        const { series, positions } = await readVault(connection, v.version, d);
        return { ...v, vault: d.vault, positions: openPositions(series, positions).filter((p) => p.openTs > now) };
      }),
    ),
    hyperliquidMid(coin),
    fetchMarket(postInfo, network, coin),
    address ? fetchHedgeAccount(postInfo, network, address, coin) : null,
    pythCalendar(stock.symbol, stock.feedId, now),
  ]);
  const positions = books.flatMap((b) => b.positions);
  const inputs = { history, annualVol: stock.annualVol, holidays: calendar.holidays, earlyCloses: calendar.earlyCloses };
  const plan = planHedge({ now, symbol: stock.symbol, positions, mid, modelFor: (openTs) => modelFor(now, openTs, inputs), market, account, maxNotional: cap });

  console.log(`now           ${iso(now)}`);
  console.log(`reference     ${coin} mid on mainnet: ${usd(mid)}`);
  console.log(`hedge market  ${coin} on ${network}: asset ${market.asset}, size step ${10 ** -market.szDecimals}, up to ${market.maxLeverage}× leverage`);
  console.log(`model         ${history.length} recorded openings to ${history.at(-1)?.to} (research/data/pyth-tsla-gaps.json), annual vol ${stock.annualVol * 100}%`);
  console.log(`cap           ${usd(cap)} of notional (HEDGE_MAX_NOTIONAL)`);

  console.log("\nVAULTS");
  for (const b of books) console.log(`  ${b.label}  ${b.vault}: ${b.positions.length} open position(s)`);
  if (!existsSync("evm/deployments/robinhood.json")) console.log("  Robinhood Chain: not deployed, nothing to read");
  else console.log("  Robinhood Chain: deployed, but the hedger doesn't read it yet");

  const e = plan.exposure;
  console.log(`\n${stock.symbol} EXPOSURE at ${usd(mid)}`);
  if (e.opens.length === 0) console.log("  nothing open");
  for (const o of e.opens) {
    console.log(`  open ${iso(o.openTs)}: ${o.positions} position(s), ${o.shares} shares, pays at most ${usd(o.maxPayout)}; hedge ${sh(o.hedge)}`);
  }
  console.log(`  hedge ${sh(e.hedge)} ${stock.symbol} (${usd(e.hedge * mid)})`);
  const others = new Map<string, number>();
  for (const p of positions) if (p.symbol !== stock.symbol) others.set(p.symbol, (others.get(p.symbol) ?? 0) + 1);
  for (const [symbol, n] of others) console.log(`  not hedged: ${symbol}, ${n} open position(s) (the hedger trades ${coin} only)`);

  printAccount(account, network, coin);
  printPlan(plan, coin, mid);
  console.log("\nplan only: nothing was sent");
}

// Exit explicitly so a run never lingers on an open websocket.
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
