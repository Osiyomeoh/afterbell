/**
 * The hedger: the short in xyz:TSLA that offsets what the vaults have sold,
 * against the short held now, and the order that closes the gap.
 *
 *   npm run hedger -- --plan              reads and prints; sends nothing, needs no key
 *   npm run hedger                        sends the order, once
 *   npm run hedger -- --every 300         runs every 5 minutes, and just after each open
 *
 * RPC_URL              Solana RPC, defaults to devnet
 * DEPLOYMENTS          vault v2, defaults to solana/deployments/devnet.json
 * DEPLOYMENTS_V1       vault v1, defaults to solana/deployments/devnet-v1.json (skipped if missing)
 * EVM_DEPLOYMENTS      the Robinhood Chain vault, defaults to evm/deployments/robinhood.json
 *                      (skipped if missing; read through the RPC the file names)
 * HYPERLIQUID_NETWORK  where the hedge trades: testnet (default) or mainnet (plan only)
 * HEDGE_ACCOUNT        the hedge account's address; for --plan without it, the short held is taken as none
 * HEDGE_MAX_NOTIONAL   the most the short may be worth, in dollars (default 1500:
 *                      about what 500 mock USDC of margin carries at 3×)
 * HEDGE_LEVERAGE       the position's isolated leverage, set when it opens (default 3)
 * HEDGER_AGENT_KEY     to send: the private key of an API wallet the hedge account approved,
 *                      set in the shell; never the account's own key
 *
 * Every read is public and needs no key: both vaults' accounts on Solana,
 * the Robinhood Chain vault's positions once it's deployed,
 * the account's trades and funding over the last week (single runs only),
 * Pyth's market-hours schedule (holidays, for the model), mainnet's xyz:TSLA
 * mid, and the hedge network's market list and the account's position.
 * Sending is on testnet only for now (docs/hedger.md: no real money).
 */
import { existsSync, readFileSync } from "node:fs";

import { Connection } from "@solana/web3.js";
import { createPublicClient, getAddress, http, type Address } from "viem";

import { evmChain, type EvmDeployment } from "../../evm/client/vault";
import type { Opening } from "../../pricing/model";
import { pythCalendar } from "../../quoter/marketData";
import { TSLA } from "../../quoter/stocks";
import tslaGaps from "../../research/data/pyth-tsla-gaps.json" with { type: "json" };
import { evmVault } from "../evm";
import { createExchange, type Exchange, type OrderResult } from "../exchange";
import { DEFAULT_SLIPPAGE, type Network } from "../hyperliquid";
import { dexOf, fetchHedgeActivity, postInfo, type HedgeAccount, type HedgeActivity } from "../info";
import { nextRunMs, type HedgePlan } from "../plan";
import { sendHedge, type SentHedge } from "../send";
import { solanaVault } from "../solana";
import { readHedgeState, type HedgeState, type ModelInputs, type VaultSource } from "../state";
import { agentKey, envNumber, everyMs, hedgeNetwork, iso, loop, maxNotional, sh, usd } from "./common";

const stock = TSLA;
const coin = stock.hyperliquid!;
const history = tslaGaps.gaps as Opening[];

type Settings = { network: Network; cap: number; address: Address | null; connection: Connection };

const readJson = <T>(file: string): T | null => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null);

/** The vaults whose deployment files exist: Solana's v2, and v1 until its last series is paid; Robinhood Chain's once it's deployed. */
function vaultSources(connection: Connection): VaultSource[] {
  type SolanaDeployment = { programId: string; vault: string };
  const v2 = readJson<SolanaDeployment>(process.env.DEPLOYMENTS ?? "solana/deployments/devnet.json");
  const v1 = readJson<SolanaDeployment>(process.env.DEPLOYMENTS_V1 ?? "solana/deployments/devnet-v1.json");
  const evm = readJson<EvmDeployment>(process.env.EVM_DEPLOYMENTS ?? "evm/deployments/robinhood.json");
  return [
    ...(v2 ? [solanaVault("Solana v2", "v2", connection, v2)] : []),
    ...(v1 ? [solanaVault("Solana v1", "v1", connection, v1)] : []),
    ...(evm ? [evmVault("Robinhood Chain", createPublicClient({ chain: evmChain(evm), transport: http(evm.rpc) }), evm)] : []),
  ];
}

/** The model from the recorded openings, with holidays and early closes from Pyth's public schedule. */
const recordedModel = async (now: number): Promise<ModelInputs> => {
  const calendar = await pythCalendar(stock.symbol, stock.feedId, now);
  return { history, annualVol: stock.annualVol, holidays: calendar.holidays, earlyCloses: calendar.earlyCloses };
};

const readState = (s: Settings) =>
  readHedgeState({ stock, vaults: vaultSources(s.connection), network: s.network, address: s.address, maxNotional: s.cap, model: recordedModel });

function printAccount(account: HedgeAccount | null, network: Network) {
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

function orderLine(plan: HedgePlan, mid: number): string | null {
  const o = plan.order;
  if (!o) return null;
  const pct = (Math.abs(Number(o.p) / mid - 1) * 100).toFixed(2);
  const side = o.b ? `buy back ${o.s} ${coin}, limit $${o.p} (${pct}% above the mid)` : `sell ${o.s} ${coin}, limit $${o.p} (${pct}% below the mid)`;
  return `${side}, immediate-or-cancel${o.r ? ", reduce-only" : ""}; at most ${DEFAULT_SLIPPAGE * 100}% from the mid`;
}

/** The whole picture, for a single run. */
function printState(st: HedgeState, s: Settings) {
  console.log(`now           ${iso(st.now)}`);
  console.log(`reference     ${coin} mid on mainnet: ${usd(st.mid)}`);
  console.log(`hedge market  ${coin} on ${s.network}: asset ${st.market.asset}, size step ${10 ** -st.market.szDecimals}, up to ${st.market.maxLeverage}× leverage`);
  console.log(`model         ${history.length} recorded openings to ${history.at(-1)?.to} (research/data/pyth-tsla-gaps.json), annual vol ${stock.annualVol * 100}%`);
  console.log(`cap           ${usd(s.cap)} of notional (HEDGE_MAX_NOTIONAL)`);

  console.log("\nVAULTS");
  for (const b of st.books) console.log(`  ${b.label}  ${b.vault}: ${b.positions.length} open position(s)`);
  if (!st.books.some((b) => b.chain === "robinhood")) console.log("  Robinhood Chain: no deployment file (EVM_DEPLOYMENTS), nothing to read");

  const e = st.plan.exposure;
  console.log(`\n${stock.symbol} EXPOSURE at ${usd(st.mid)}`);
  if (e.opens.length === 0) console.log("  nothing open");
  for (const o of e.opens) {
    console.log(`  open ${iso(o.openTs)}: ${o.positions} position(s), ${o.shares} shares, pays at most ${usd(o.maxPayout)}; hedge ${sh(o.hedge)}`);
  }
  console.log(`  hedge ${sh(e.hedge)} ${stock.symbol} (${usd(e.hedge * st.mid)})`);
  const others = new Map<string, number>();
  for (const p of st.positions) if (p.symbol !== stock.symbol) others.set(p.symbol, (others.get(p.symbol) ?? 0) + 1);
  for (const [symbol, n] of others) console.log(`  not hedged: ${symbol}, ${n} open position(s) (the hedger trades ${coin} only)`);

  printAccount(st.account, s.network);
  const r = st.plan.rebalance;
  console.log(`\nTARGET  short ${sh(r.target)} (${usd(r.target * st.mid)})${r.capped ? `, capped: the hedge is ${sh(e.hedge)}` : ""}`);
  console.log(`ACTION  ${r.note}`);
  const line = orderLine(st.plan, st.mid);
  if (line) console.log(`ORDER   ${line}\n        ${JSON.stringify(st.plan.order)}`);
}

function printActivity(a: HedgeActivity) {
  console.log(`\nTRADES since ${iso(a.since)}`);
  if (a.trades === 0) console.log("  none");
  for (const f of a.fills) {
    const pnl = f.closedPnl === 0 ? "" : `, closed P&L ${usd(f.closedPnl)}`;
    console.log(`  ${iso(f.time)}  ${f.dir}: ${f.sell ? "sold" : "bought"} ${sh(f.size)} at ${usd(f.price)}, fee $${f.fee.toFixed(4)}${pnl}`);
  }
  if (a.trades > a.fills.length) console.log(`  … ${a.trades - a.fills.length} earlier`);
  if (a.trades > 0) console.log(`  ${a.trades} trade(s): fees $${a.fees.toFixed(4)}, closed P&L ${usd(a.closedPnl)}`);
  console.log(`  funding ${a.funding >= 0 ? "received" : "paid"} $${Math.abs(a.funding).toFixed(4)} over ${a.fundingPayments} payment(s)`);
}

/** One line a run, for --every. */
function printLine(st: HedgeState) {
  const held = st.plan.current;
  console.log(`${iso(st.now)}  mid ${usd(st.mid)}  hedge ${sh(st.plan.exposure.hedge)}  short ${sh(held)}  ${st.plan.rebalance.note}`);
}

function describeResult(r: OrderResult, asked: string): string {
  if (r.kind === "filled") return `filled ${r.size}${String(r.size) === asked ? "" : ` of ${asked}`} at $${r.avgPx} (order ${r.oid})`;
  if (r.kind === "resting") return `resting as order ${r.oid}`;
  return `not filled: ${r.message}`;
}

function printSent(sent: SentHedge, plan: HedgePlan) {
  if (sent.leverage !== null) console.log(`  set ${coin} to isolated ${sent.leverage}×`);
  if (sent.result && plan.order) console.log(`  ${describeResult(sent.result, plan.order.s)}`);
}

async function main() {
  const planOnly = process.argv.includes("--plan");
  const every = everyMs();
  const network = hedgeNetwork();
  const address = process.env.HEDGE_ACCOUNT ? getAddress(process.env.HEDGE_ACCOUNT) : null;
  const settings: Settings = { network, cap: maxNotional(), address, connection: new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed") };

  let ex: Exchange | null = null;
  let leverage = 0;
  if (!planOnly) {
    if (network !== "testnet") throw new Error("the hedger sends on testnet only for now; use --plan to read mainnet");
    if (!address) throw new Error("set HEDGE_ACCOUNT: sending needs the short the account holds now");
    leverage = envNumber("HEDGE_LEVERAGE", 3);
    ex = createExchange(network, agentKey("HEDGER_AGENT_KEY", address));
    console.log(`sending on ${network} as API wallet ${ex.signer} for ${address}\n`);
  }

  const tick = async () => {
    const st = await readState(settings);
    if (every === null) {
      printState(st, settings);
      if (settings.address) printActivity(await fetchHedgeActivity(postInfo, network, settings.address, coin, st.now - 7 * 86_400));
    } else printLine(st);
    if (ex && st.plan.order) {
      if (!Number.isInteger(leverage) || leverage < 1 || leverage > st.market.maxLeverage) {
        throw new Error(`HEDGE_LEVERAGE must be a whole number from 1 to ${st.market.maxLeverage}`);
      }
      if (st.account && st.account.accountValue === 0) console.log(`  note: the account holds nothing on the ${dexOf(coin)} dex; the order needs margin there`);
      printSent(await sendHedge(ex, st.plan, st.account!, leverage), st.plan);
    }
    return nextRunMs(Date.now(), every ?? 0, st.plan.exposure.opens.map((o) => o.openTs));
  };

  if (every === null) {
    await tick();
    if (planOnly) console.log("\nplan only: nothing was sent");
  } else {
    console.log(`every ${every / 1000} s and just after each open; Ctrl-C stops${planOnly ? " (plan only: nothing is sent)" : ""}`);
    await loop(tick, 60_000);
  }
}

// Exit explicitly so a run never lingers on an open websocket.
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
