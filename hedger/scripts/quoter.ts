/**
 * The testnet quoting account: the bid and ask in xyz:TSLA it rests at
 * mainnet's mid, against what it has resting now, and the cancels and new
 * quotes that bring the book to them.
 *
 *   npm run hedger:quoter -- --plan         reads and prints; sends nothing, needs no key
 *   npm run hedger:quoter                   refreshes the quotes once
 *   npm run hedger:quoter -- --every 60     refreshes every minute; Ctrl-C cancels its quotes and stops
 *
 * QUOTE_ACCOUNT       the quoting account's address; for --plan without it, no resting orders are read
 * QUOTE_SPREAD_BPS    each side's distance from the mid, in basis points (default 2)
 * QUOTE_SIZE          each side's size, in TSLA (default 5)
 * QUOTE_REFRESH_BPS   how far from the new price a resting quote may be and still be kept (default 1)
 * HEDGE_MAX_NOTIONAL  the hedger's cap, to check a quote can fill its largest trade (default 1500)
 * QUOTER_AGENT_KEY    to send: the private key of an API wallet the quoting account approved,
 *                     set in the shell; never the account's own key
 *
 * Testnet only: on mainnet the hedge trades against the real book, and this
 * account has no business there. Every read is public and needs no key:
 * mainnet's xyz:TSLA mid, and testnet's market list, its book, and the
 * account's position and resting orders.
 */
import { getAddress, type Address } from "viem";

import { hyperliquidMid } from "../../quoter/marketData";
import { TSLA } from "../../quoter/stocks";
import { cancelOrders, createExchange, type Exchange, type OrderResult } from "../exchange";
import { cancelAction, orderAction, type Market, type Network, type OrderWire } from "../hyperliquid";
import { dexOf, fetchHedgeAccount, fetchMarket, fetchOpenOrders, fetchTopOfBook, postInfo, type BookLevel, type HedgeAccount } from "../info";
import { DEFAULT_QUOTE_RULES, quoteOrders, refreshQuotes, type QuoteRefresh, type QuoteRules, type RestingOrder } from "../quotes";
import { sendQuotes, type SentQuotes } from "../send";
import { agentKey, emptyDexNote, envNumber, funds, everyMs, iso, loop, maxNotional, sh, usd } from "./common";

const NETWORK: Network = "testnet";
const coin = TSLA.hyperliquid!;

const side = (buy: boolean) => (buy ? "bid" : "ask");
const wanted = (o: OrderWire) => `${side(o.b)} ${o.s} at $${o.p}`;
const resting = (o: RestingOrder) => `${side(o.buy)} ${o.size} at $${o.px} (order ${o.oid})`;

type State = {
  now: number;
  mid: number;
  market: Market;
  top: { bid: BookLevel | null; ask: BookLevel | null };
  account: HedgeAccount | null;
  orders: RestingOrder[];
  bid: OrderWire;
  ask: OrderWire;
  refresh: QuoteRefresh;
};

async function readState(rules: QuoteRules, address: Address | null): Promise<State> {
  const now = Math.floor(Date.now() / 1000);
  const [mid, market, top, account, orders] = await Promise.all([
    hyperliquidMid(coin),
    fetchMarket(postInfo, NETWORK, coin),
    fetchTopOfBook(postInfo, NETWORK, coin),
    address ? fetchHedgeAccount(postInfo, NETWORK, address, coin) : null,
    address ? fetchOpenOrders(postInfo, NETWORK, address, coin) : [],
  ]);
  const { bid, ask } = quoteOrders(mid, market, rules);
  return { now, mid, market, top, account, orders, bid, ask, refresh: refreshQuotes(orders, [bid, ask], rules.refreshBps) };
}

/** The whole picture, for a single run. */
function printState(st: State, rules: QuoteRules, cap: number) {
  const level = (l: BookLevel | null) => (l ? `${usd(l.px)} (${l.size})` : "none");
  console.log(`now           ${iso(st.now)}`);
  console.log(`reference     ${coin} mid on mainnet: ${usd(st.mid)}`);
  console.log(`market        ${coin} on ${NETWORK}: asset ${st.market.asset}, size step ${10 ** -st.market.szDecimals}`);
  console.log(`${NETWORK} book  best bid ${level(st.top.bid)}, best ask ${level(st.top.ask)}`);
  console.log(`rules         ${rules.spreadBps} bps each side, ${rules.size} ${TSLA.symbol} a side, a resting quote kept within ${rules.refreshBps} bps`);

  console.log("\nQUOTES");
  console.log(`  ${wanted(st.bid)}`);
  console.log(`  ${wanted(st.ask)}`);
  // A stray order that crosses a quote fills against it first; the account's own old quotes are cancelled before new ones go up.
  const ours = new Set(st.orders.map((o) => o.px));
  if (st.top.bid && st.top.bid.px >= Number(st.ask.p) && !ours.has(st.top.bid.px)) {
    console.log(`  note: ${NETWORK}'s best bid ${usd(st.top.bid.px)} is at or above the ask, so the ask fills it first (up to ${st.top.bid.size} ${TSLA.symbol}), then rests`);
  }
  if (st.top.ask && st.top.ask.px <= Number(st.bid.p) && !ours.has(st.top.ask.px)) {
    console.log(`  note: ${NETWORK}'s best ask ${usd(st.top.ask.px)} is at or below the bid, so the bid fills it first (up to ${st.top.ask.size} ${TSLA.symbol}), then rests`);
  }
  const largest = cap / st.mid;
  if (rules.size < largest) {
    console.log(`  note: ${rules.size} ${TSLA.symbol} is less than the hedger's cap at this price (${sh(largest)}), so a trade that big fills over more than one run`);
  }

  console.log("\nQUOTING ACCOUNT");
  if (!st.account) {
    console.log("  none given (QUOTE_ACCOUNT): no resting orders read, so both quotes would be placed");
  } else {
    const p = st.account.position;
    const backing = funds(st.account, dexOf(coin));
    const held = !p ? `no ${coin} position` : p.short > 0 ? `short ${sh(p.short)}` : `long ${sh(-p.short)}`;
    console.log(`  ${st.account.address} on ${NETWORK}: ${held}; ${backing}`);
    const empty = emptyDexNote(st.account.accountValue, dexOf(coin), st.account.unified);
    if (empty) console.log(`  ${empty}`);
    if (st.orders.length === 0) console.log("  nothing resting");
    for (const o of st.orders) console.log(`  resting ${resting(o)}`);
  }

  const r = st.refresh;
  console.log("\nACTIONS");
  if (r.cancel.length === 0 && r.place.length === 0) console.log("  hold: both quotes are resting");
  for (const o of r.keep) console.log(`  keep    ${resting(o)}`);
  for (const o of r.cancel) console.log(`  cancel  ${resting(o)}`);
  for (const o of r.place) console.log(`  place   ${wanted(o)}, good until cancelled`);
  if (r.cancel.length > 0) console.log(`  ${JSON.stringify(cancelAction(r.cancel.map((o) => ({ a: st.market.asset, o: o.oid }))))}`);
  if (r.place.length > 0) console.log(`  ${JSON.stringify(orderAction(r.place))}`);
}

/** One line a run, for --every. */
function printLine(st: State) {
  const r = st.refresh;
  const change = r.cancel.length === 0 && r.place.length === 0 ? "hold" : `cancel ${r.cancel.length}, place ${r.place.length}`;
  const p = st.account?.position;
  const held = !p ? "flat" : p.short > 0 ? `short ${sh(p.short)}` : `long ${sh(-p.short)}`;
  console.log(`${iso(st.now)}  mid ${usd(st.mid)}  ${wanted(st.bid)}  ${wanted(st.ask)}  ${held}  ${change}`);
  const empty = st.account && emptyDexNote(st.account.accountValue, dexOf(coin), st.account.unified);
  if (empty) console.log(`  ${empty}`);
}

function describePlaced(r: OrderResult, o: OrderWire): string {
  if (r.kind === "resting") return `${wanted(o)}: resting as order ${r.oid}`;
  if (r.kind === "filled") return `${wanted(o)}: filled ${r.size} at $${r.avgPx} on placing (order ${r.oid})`;
  return `${wanted(o)}: refused: ${r.message}`;
}

function printSent(sent: SentQuotes, refresh: QuoteRefresh) {
  sent.cancelled.forEach((why, k) => console.log(`  cancel ${resting(refresh.cancel[k]!)}: ${why ?? "done"}`));
  sent.placed.forEach((r, k) => console.log(`  place ${describePlaced(r, refresh.place[k]!)}`));
}

/** Cancels every order the account rests in the coin, so none is left at a stale price once the quoter stops. */
async function pullQuotes(ex: Exchange, address: Address) {
  const [market, orders] = await Promise.all([fetchMarket(postInfo, NETWORK, coin), fetchOpenOrders(postInfo, NETWORK, address, coin)]);
  if (orders.length === 0) return console.log("stopped: nothing resting");
  const why = await cancelOrders(ex, orders.map((o) => ({ a: market.asset, o: o.oid })));
  orders.forEach((o, k) => console.log(`stopped: cancel ${resting(o)}: ${why[k] ?? "done"}`));
}

async function main() {
  const planOnly = process.argv.includes("--plan");
  const every = everyMs();
  if ((process.env.HYPERLIQUID_NETWORK ?? NETWORK) !== NETWORK) {
    throw new Error("the quoting account runs on testnet only: on mainnet the hedge fills against the real book");
  }
  const rules: QuoteRules = {
    spreadBps: envNumber("QUOTE_SPREAD_BPS", DEFAULT_QUOTE_RULES.spreadBps),
    size: envNumber("QUOTE_SIZE", DEFAULT_QUOTE_RULES.size),
    refreshBps: envNumber("QUOTE_REFRESH_BPS", DEFAULT_QUOTE_RULES.refreshBps),
  };
  const cap = maxNotional();
  const address = process.env.QUOTE_ACCOUNT ? getAddress(process.env.QUOTE_ACCOUNT) : null;

  let ex: Exchange | null = null;
  if (!planOnly) {
    if (!address) throw new Error("set QUOTE_ACCOUNT: sending needs the orders the account rests now");
    ex = createExchange(NETWORK, agentKey("QUOTER_AGENT_KEY", address));
    console.log(`sending on ${NETWORK} as API wallet ${ex.signer} for ${address}\n`);
  }

  const tick = async () => {
    const st = await readState(rules, address);
    if (every === null) printState(st, rules, cap);
    else printLine(st);
    if (ex && (st.refresh.cancel.length > 0 || st.refresh.place.length > 0)) printSent(await sendQuotes(ex, st.refresh, st.market.asset), st.refresh);
    return Date.now() + (every ?? 0);
  };

  if (every === null) {
    await tick();
    if (planOnly) console.log("\nplan only: nothing was sent");
    return;
  }
  console.log(`every ${every / 1000} s; Ctrl-C ${planOnly ? "stops (plan only: nothing is sent)" : "cancels the quotes and stops"}`);
  await loop(tick, every);
  if (ex && address) await pullQuotes(ex, address);
}

// Exit explicitly so a run never lingers on an open socket.
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
