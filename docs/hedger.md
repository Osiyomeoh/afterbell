# Hedger

Status, 27 Sep 2026: written and tested, and it reads the live vaults and prices, but **it hasn't traded yet**. Sizing, signing, plan mode, the testnet quoter, the send path, a backtest and the Vault page panel are built (steps 1 to 5 and 7 below). Trading on Hyperliquid testnet (step 6) waits on its two accounts. Market facts were checked on 26 Sep against Hyperliquid's public API and docs.

## What it does

Every open position is a put spread the vault has sold: it pays `shares × clamp(upper − open, 0, upper − lower)` at the next 09:30 ET open. The hedger holds a short in Hyperliquid's `xyz:TSLA` perp sized to the vault's current exposure, so a drop overnight is partly paid for by the short. It keeps one rule at all times:

> **target short = the vault's delta**: how much its expected payout rises per $1 fall in TSLA, summed over every open position, priced with the same openings model the quoter uses.

That one rule covers the whole cycle. Protection sold during the day or after the bell raises the target; as TSLA falls toward the strikes the target grows; at 09:30 ET the positions for that open stop counting, the target drops to zero and the hedger buys the short back. Hyperliquid's `xyz:TSLA` is a median 4.1 bps from Pyth's opening print (research/results), so closing at the open follows the price the vault settles on.

The vault stays on devnet with TestUSD, and the hedge runs on **Hyperliquid testnet** with mock USDC (decided 26 Sep: no real money at risk). Mainnet is used for two things only: one deposit of 5 USDC, which testnet's faucet requires, and its public prices, which the hedge follows. The same code runs on mainnet by changing one setting, when there's money for it; sending there is refused until then.

## Numbers

**Monday 28 Sep's book** (five positions on the first Solana vault, 8 shares, strikes $364.15 to $370.32, paying at most $238.90), priced with the 46 recorded openings on 26 Sep:

| TSLA at | Short to hold |
|---|---|
| $380 | 0.26 TSLA |
| $371.76 (Saturday) | 1.16 TSLA, about $430 |
| $365 | 3.83 TSLA |
| $360 | 6.36 TSLA |

The first live `npm run hedger -- --plan` (27 Sep, 12:37 UTC) read the same five positions from devnet, and none on the new vault, and asked for a 0.831 TSLA short at mainnet's $373.34.

**Backtest** (`npm run hedger:backtest`, full tables in [research/results/hedge-backtest.md](../research/results/hedge-backtest.md)). 36 nights, 5 Aug to 25 Sep. Each night the vault sells protection on 10 TSLA at the close, priced only from earlier openings, and pays it on Pyth's opening print. The short trades at Hyperliquid's own 15-minute prices, through the hedger's own dead band, and is bought back at the open. Fees are growth mode's highest taker rate. Funding and the spread are left out. The spread of the vault's nightly result (standard deviation):

| Protection | Unhedged | Short set at the close | Rebalanced hourly | Every 15 minutes | Hourly, narrowing to the open |
|---|---|---|---|---|---|
| 2% to 10% below the close (paid on 1 night) | $12.28 | $11.46 (−7%) | $7.56 (−38%) | $7.63 (−38%) | $6.33 (−48%) |
| 1% to 5% below the close (paid on 8 nights) | $19.89 | $15.09 (−24%) | $7.56 (−62%) | $7.36 (−63%) | $6.65 (−67%) |

What it shows, and what it doesn't:

- **One night carries most of it.** On 3 to 4 Sep TSLA fell through the night on Hyperliquid (−1.9% by midnight, −2.9% by 08:00, −3.8% at the open), so a rebalanced short followed it down: the vault's worst night on 2% to 10% went from −$57 to −$16. A drop that comes all at once at the open would give it nothing to follow.
- **Far-out protection gets noisier on quiet nights.** Without that night, every hedge makes the other 35 nights of 2% to 10% protection noisier (SD $4.00 → about $6.00). On 1% to 5%, rebalancing still cuts the spread by about half without it. Monday's real book is near the money (strikes 0.4% to 2% under the close), closer to the second case.
- **Hourly is as good as every 15 minutes**, with about a third of the trades. The hedger runs every 5 minutes; the dead band keeps it from trading most of those times.
- **The model doesn't narrow as the open nears, and a hedge that does was better.** The hedger prices the whole close-to-open move from any moment of the night. Measured on the recorded nights, much of it has already happened by the morning: Hyperliquid's price 3 hours before the open leaves 61% of the move's size still to come, 15 minutes before it 34% (the report's last table; about 100% from 14 hours out, so at the close). The last column scales the model's moves by that share at each rebalance, measured only on the nights before the one it hedges (29 of the 36 nights had enough of them; the rest hedge as "hourly"). Same trades, a smaller spread, and better worst nights (−$8.98 against −$15.73 on 2% to 10%; −$19.59 against −$27.54 on 1% to 5%). On 1% to 5% without 3 to 4 Sep it's no better than hourly ($5.01 against $4.97). **The hedger doesn't use it yet:** the same model prices the quotes, which would then be cheaper overnight, so that's a pricing decision first.

One stock over a few dozen nights: read it as how the hedge behaves, not as proof of how much it saves.

## Hyperliquid facts it depends on (checked 26 Sep)

| | Mainnet | Testnet |
|---|---|---|
| Market | `xyz:TSLA`, builder-deployed (HIP-3) dex `xyz` | `xyz:TSLA` exists (dex `xyz`) |
| Asset id for orders | **110001** | **750001** (read 27 Sep; testnet's dex list is longer) |
| Size step | 0.001 TSLA | 0.001 TSLA |
| Max leverage | 20× | 10× |
| Book | $0.01 spread, 100+ TSLA within 10 levels each side | **empty**: one 0.081 bid at $389.78, next at $260, no asks |
| Open interest, 24 h volume | 125,753 TSLA, $31M | 3 TSLA, $0 |
| Fees | growth mode: all-in taker 0.0045% to 0.009% (90% below the 0.045% base) | |
| Funding | 0.000625% an hour at the time (shorts receive it when positive) | |

The asset id is never hard-coded: each run reads it from that network's own dex list (builder dexes are numbered 100000 + 10000 × the dex's place + the market's index).

**Testnet has no TSLA liquidity.** All 17 TSLA perps on testnet were checked on 26 Sep: none has a two-sided book near the real price. So testnet needs liquidity we provide (below).

**On mainnet it would cost**, for 1.2 TSLA (~$430): fees about 2 × 0.009% × $430 ≈ $0.08, funding over a weekend (65 h) about 0.04% ≈ $0.17, received by the short when funding is positive. Not spent on testnet; recorded so the switch is costed.

## Design, as built

**Exposure** (`hedger/solana.ts`, `hedger/evm.ts`, `hedger/target.ts`). Reads every open position in both Solana vaults, the new one and the first version until its last series is paid, with each version's own account decoder, and in Robinhood Chain's vault once `evm/deployments/robinhood.json` exists (each position the vault has sold, through the RPC the file names; stocks named by the file's feed list). That vault isn't deployed, so its read has run only on a local chain, in `npm run evm:cycle`. Positions whose open has passed no longer count, whether or not the keeper has settled them yet. Only TSLA is hedged: positions on other stocks are listed as not hedged.

**Where it runs.** Testnet by default (`HYPERLIQUID_NETWORK=testnet`). The reference price is always mainnet's `xyz:TSLA` mid, read from the public endpoint: that's the price the research checked against Pyth, and testnet's own oracle and mark drift from it (on 26 Sep testnet's oracle was $372.59 and its mark $389.89, against mainnet's $371.87).

**Target** (`hedger/target.ts`, `hedger/plan.ts`). The model's delta at the reference price, in TSLA, rounded to the market's size step. A **dead band** stops churn: trade only when the target and the current short differ by more than max(0.01 TSLA, $10 of notional). A **notional cap** (`HEDGE_MAX_NOTIONAL`, $1,500 by default, about what 500 mock USDC of margin carries at 3×) bounds what the account can hold. Above the cap the hedge is partial, and the app says so.

**Orders** (`hedger/hyperliquid.ts`, `hedger/send.ts`). Immediate-or-cancel limit orders at the mid ± 0.2%, so a thin moment can't fill far away. Buy-backs are reduce-only. Isolated margin at 3× (`HEDGE_LEVERAGE`), set only when an order opens a position, since the margin mode can't change once one is open; a short is liquidated only after a rise of about 30%.

**Schedule.** `npm run hedger -- --every 300` runs every 5 minutes, and 1 second after each open, when the target for that open falls to zero, so the buy-back trades at the opening price. It's safe to run more often: it only trades the gap to the target. A failed run is logged and retried; Ctrl-C stops it.

**Liquidity on testnet** (`hedger/quotes.ts`, `npm run hedger:quoter`). A second testnet account rests a bid and an ask in `xyz:TSLA` at mainnet's mid, 2 bps each side (rounded away from the mid, so they never cross), 5 TSLA a side, enough for the hedger's largest trade down to $300 a share. Every minute it keeps a quote that is unfilled and within 1 bp of the new price, cancels the rest, then places what's missing. Stopping it cancels every quote, so none rests at a stale price. Its quotes are good-till-cancelled rather than add-liquidity-only: testnet's stray bid at $389.78 crosses any ask near the real price, and an add-liquidity-only ask would be refused, leaving the hedger's buy-backs nothing to fill against. The hedger's orders are real HyperCore orders; on testnet they fill against those quotes, or against a stray order that happens to be better. This is our own liquidity, and the app says so.

**Accounts and keys.** You create two wallets and share their addresses:
- the **hedge account**: deposits 5 USDC on mainnet (this unlocks testnet's faucet, 1,000 mock USDC), claims the faucet, and sends part of it to the quoting account. The 5 USDC isn't traded; it stays in the mainnet account.
- the **quoting account**: testnet only, holds mock USDC.

Each approves an **API wallet** (Hyperliquid's "agent" key): a separate key that signs orders for the account. The scripts read those keys only from the shell (`HEDGER_AGENT_KEY`, `QUOTER_AGENT_KEY`), never from a file, never print them, and refuse a key that is the account's own. On testnet nothing of value is at stake; before any mainnet use, confirm in Hyperliquid's docs that an API wallet can't withdraw.

**Signing** (`hedger/msgpack.ts`, `hedger/hyperliquid.ts`, `hedger/exchange.ts`). Our own signer with viem, no SDK added: EIP-712 over a msgpack hash of the action (Hyperliquid's "L1 action" scheme), checked against the signatures in the tests of Hyperliquid's Python SDK (orders, an action for a vault, a scheduled cancel) and its Rust SDK (an immediate-or-cancel order and a cancel). Leverage changes follow the field order both SDKs' code uses, but neither has a test signature for one, so the exchange checks it on first use. The answers `/exchange` gives are read as Hyperliquid's docs and the Rust SDK's response types describe them; a status neither describes stops the run, and the next run reads the account afresh. Each request's nonce is the time in milliseconds, strictly increasing within a run.

**Plan mode.** `npm run hedger -- --plan` and `npm run hedger:quoter -- --plan` read everything and print it (exposure per open, the target, the short held, the order it would send; the book, the account's resting quotes, and the cancels and quotes it would send), send nothing and need no key. Both have run against the live vaults and Hyperliquid's public endpoints.

**In the app.** The Vault page shows the hedge from `GET /api/hedge`, which reads the same state through the same code, public endpoints only, no key on the server: mainnet's price, the short the open protection calls for, the short held, each open's positions and the short for it, and, once `HEDGE_ACCOUNT` is set, the account's value, P&L, margin and a link to it on Hyperliquid's explorer, and its trades and funding over the last 7 days. Those come from Hyperliquid's `userFillsByTime` and `userFunding`, which take no dex and cover every market, so they're filtered to `xyz:TSLA`; testnet accepted both requests for an account with no trades, and what they return for a builder dex's market is seen only once the hedge trades. A single `npm run hedger -- --plan` with `HEDGE_ACCOUNT` prints the same. Until the account exists the page says the hedge isn't running.

## Build steps

1. Exposure and target, pure and tested: delta across both vaults, dead band, cap, rounding. **Done.**
2. Order building and signing, with signature test vectors; asset id from the dex list, not hard-coded. **Done.**
3. `--plan` mode against devnet and mainnet's public endpoints. **Done, run live 27 Sep.**
4. The testnet quoter: quotes at mainnet's mid, cancels and replaces every minute, with its own `--plan`. **Done, plan run live 27 Sep.**
5. Backtest rebalancing overnight on the cached 15-minute `xyz:TSLA` candles, against the static hedge. **Done**; results above.
6. Live on testnet, by you: the 5 USDC deposit and faucet claim, the transfer to the quoting account, both API wallets approved; then `--plan` with both addresses, the quoter, one real rebalance, and scheduled runs across one close and open. **Not started.** The send path is written and tested against Hyperliquid's documented answers and the Rust SDK's response types.
7. Vault page panel and `/api/hedge`. **Done**; shows "not running yet" until step 6.
8. README: move the hedger from Next to Built only after step 6 has run across an open.

Not yet checked against the exchange, so step 6 checks them first: the leverage action's shape, the exact answers `/exchange` gives, whether a reduce-only buy-back under $10 is refused by the minimum order value, the fills and funding records for `xyz:TSLA`, and the explorer link's format. Isolated margin is allowed by `xyz:TSLA`'s metadata (read 27 Sep on both networks): it sets no margin restriction, while most of `xyz`'s other markets are isolated-only; the first leverage change confirms it.

## Decisions

1. **Testnet, with mock USDC.** Decided 26 Sep. Mainnet only for the 5 USDC deposit and public prices.
2. **When to write the code.** Started 27 Sep, ahead of the Perps hackathon's window (from Oct 2), which is "perpetuals and prediction markets **on Solana**", so a hedger on Hyperliquid may not count as its in-window work anyway. Colosseum's Hyperliquid track gets more time before Oct 12.
3. **Signing.** Our own signer, tested against the Python SDK's vectors, rather than a TypeScript SDK (decided 27 Sep).
4. **The two wallets** (open): you create them and share the addresses; you make the deposit and approve the API wallets yourself.
5. **Before depositing:** the deposit screen shows Hyperliquid's minimum. It's understood to be 5 USDC, with smaller deposits lost, and bridging from Arbitrum needs a little ETH there for gas. Check both on the screen before sending; not yet confirmed in the docs.
6. **Mainnet cap, for later.** At 3× a short needs a third of its notional as margin: $500 of notional needs about $200, $1,000 about $400.

## What we'll claim, and what we won't

- Will, once it has run: "the vault's exposure is hedged on Hyperliquid (HyperCore testnet) in `xyz:TSLA`, sized by the same model that prices it, at mainnet's price, filling against our own quoting account because testnet has no TSLA liquidity", with the account's trades linkable, and only where the recorded fills show it.
- Will, now: "in a backtest over 36 nights, rebalancing hourly cut the spread of the vault's nightly results by a third to two-thirds, mostly from one night when TSLA fell through the night; for protection far below the close it added noise on quiet nights." And, as research only: "sizing the hedge for the part of the move still to come, measured on earlier nights, cut it further, to about a half to two-thirds."
- Won't: that it hedges real money or trades against a real market (it doesn't, on testnet); that the hedge removes the vault's risk (the numbers above say it trims it), or that Hyperliquid's weekend price predicts the open (it doesn't; research/results).
