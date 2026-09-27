/**
 * The testnet quoting account, once: the bid and ask in xyz:TSLA it should
 * rest at mainnet's mid, against what it has resting now. Only --plan is
 * built so far: it reads, prints and sends nothing. Sending, every minute,
 * waits for the account's API wallet (docs/hedger.md, step 6).
 *
 *   npm run hedger:quoter -- --plan
 *
 * QUOTE_ACCOUNT       the quoting account's address; without it no resting orders are read
 * QUOTE_SPREAD_BPS    each side's distance from the mid, in basis points (default 2)
 * QUOTE_SIZE          each side's size, in TSLA (default 5)
 * QUOTE_REFRESH_BPS   how far from the new price a resting quote may be and still be kept (default 1)
 * HEDGE_MAX_NOTIONAL  the hedger's cap, to check a quote can fill its largest trade (default 1500)
 *
 * Testnet only: on mainnet the hedge trades against the real book, and this
 * account has no business there. Every read is public and needs no key:
 * mainnet's xyz:TSLA mid, and testnet's market list, its book, and the
 * account's position and resting orders.
 */
import { getAddress } from "viem";

import { hyperliquidMid } from "../../quoter/marketData";
import { TSLA } from "../../quoter/stocks";
import { cancelAction, orderAction, type Network, type OrderWire } from "../hyperliquid";
import { dexOf, fetchHedgeAccount, fetchMarket, fetchOpenOrders, fetchTopOfBook, postInfo } from "../info";
import { DEFAULT_QUOTE_RULES, quoteOrders, refreshQuotes, type QuoteRules, type RestingOrder } from "../quotes";
import { envNumber, iso, maxNotional, sh, usd } from "./common";

const NETWORK: Network = "testnet";

const side = (buy: boolean) => (buy ? "bid" : "ask");
const wanted = (o: OrderWire) => `${side(o.b)} ${o.s} at $${o.p}`;
const resting = (o: RestingOrder) => `${side(o.buy)} ${o.size} at $${o.px} (order ${o.oid})`;

async function main() {
  if (!process.argv.includes("--plan")) {
    throw new Error("only --plan is built: the quoter sends once its API wallet is approved (docs/hedger.md, step 6)");
  }
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
  const coin = TSLA.hyperliquid!;
  const now = Math.floor(Date.now() / 1000);

  const [mid, market, top, account, orders] = await Promise.all([
    hyperliquidMid(coin),
    fetchMarket(postInfo, NETWORK, coin),
    fetchTopOfBook(postInfo, NETWORK, coin),
    address ? fetchHedgeAccount(postInfo, NETWORK, address, coin) : null,
    address ? fetchOpenOrders(postInfo, NETWORK, address, coin) : [],
  ]);
  const { bid, ask } = quoteOrders(mid, market, rules);
  const refresh = refreshQuotes(orders, [bid, ask], rules.refreshBps);

  const level = (l: { px: number; size: number } | null) => (l ? `${usd(l.px)} (${l.size})` : "none");
  console.log(`now           ${iso(now)}`);
  console.log(`reference     ${coin} mid on mainnet: ${usd(mid)}`);
  console.log(`market        ${coin} on ${NETWORK}: asset ${market.asset}, size step ${10 ** -market.szDecimals}`);
  console.log(`${NETWORK} book  best bid ${level(top.bid)}, best ask ${level(top.ask)}`);
  console.log(`rules         ${rules.spreadBps} bps each side, ${rules.size} ${TSLA.symbol} a side, a resting quote kept within ${rules.refreshBps} bps`);

  console.log("\nQUOTES");
  console.log(`  ${wanted(bid)}`);
  console.log(`  ${wanted(ask)}`);
  // A stray order that crosses a quote fills against it first; the account's own old quotes are cancelled before new ones go up.
  const ours = new Set(orders.map((o) => o.px));
  if (top.bid && top.bid.px >= Number(ask.p) && !ours.has(top.bid.px)) {
    console.log(`  note: ${NETWORK}'s best bid ${usd(top.bid.px)} is at or above the ask, so the ask fills it first (up to ${top.bid.size} ${TSLA.symbol}), then rests`);
  }
  if (top.ask && top.ask.px <= Number(bid.p) && !ours.has(top.ask.px)) {
    console.log(`  note: ${NETWORK}'s best ask ${usd(top.ask.px)} is at or below the bid, so the bid fills it first (up to ${top.ask.size} ${TSLA.symbol}), then rests`);
  }
  const largest = cap / mid;
  if (rules.size < largest) {
    console.log(`  note: ${rules.size} ${TSLA.symbol} is less than the hedger's cap at this price (${sh(largest)}), so a trade that big fills over more than one run`);
  }

  console.log("\nQUOTING ACCOUNT");
  if (!account) {
    console.log("  none given (QUOTE_ACCOUNT): no resting orders read, so both quotes would be placed");
  } else {
    const p = account.position;
    const funds = `${usd(account.accountValue)} on the ${dexOf(coin)} dex, ${usd(account.withdrawable)} withdrawable`;
    const held = !p ? `no ${coin} position` : p.short > 0 ? `short ${sh(p.short)}` : `long ${sh(-p.short)}`;
    console.log(`  ${account.address} on ${NETWORK}: ${held}; ${funds}`);
    if (orders.length === 0) console.log("  nothing resting");
    for (const o of orders) console.log(`  resting ${resting(o)}`);
  }

  console.log("\nACTIONS");
  if (refresh.cancel.length === 0 && refresh.place.length === 0) console.log("  hold: both quotes are resting");
  for (const o of refresh.keep) console.log(`  keep    ${resting(o)}`);
  for (const o of refresh.cancel) console.log(`  cancel  ${resting(o)}`);
  for (const o of refresh.place) console.log(`  place   ${wanted(o)}, good until cancelled`);
  if (refresh.cancel.length > 0) console.log(`  ${JSON.stringify(cancelAction(refresh.cancel.map((o) => ({ a: market.asset, o: o.oid }))))}`);
  if (refresh.place.length > 0) console.log(`  ${JSON.stringify(orderAction(refresh.place))}`);
  console.log("\nplan only: nothing was sent");
}

// Exit explicitly so a run never lingers on an open socket.
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
