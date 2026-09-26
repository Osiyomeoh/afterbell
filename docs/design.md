# Afterbell: design

Protection for tokenized stocks until the next open, sold on the chain where you hold them, hedged on Hyperliquid.

Status (26 Sep): the Solana vault is live on devnet, with the app, quote endpoint, faucet, Blink, keeper and MCP server built on it. The EVM vault, its client, its keeper and the app's Robinhood Chain flow are built and tested on a fork and a local chain, waiting on a mainnet deploy. The app's track record covers both vaults. The hedger is planned. The README keeps the built/planned split current.

## Problem

Tokenized stocks (xStocks and Ondo on Solana, Stock Tokens on Robinhood Chain) trade 24/7. The stock trades 32.5 regular-session hours a week. News that lands while the exchange is shut reaches the price all at once at the next opening print. A holder of the token has no put to buy: listed options need a brokerage account and don't cover a token in a wallet, and a perp short on Hyperliquid needs a separate account, margin, funding and liquidation risk, and gives up the upside.

## Product

A holder picks a stock, a size (or "what my wallet holds"), where protection starts and how far down it goes. They see a fixed premium and a fixed maximum payout, pay once, and the position settles on the first oracle price at or after the next 09:30 ET open. Payout is `shares × clamp(start − open, 0, start − floor)`: a put spread. It never pays more than the covered position loses.

Customers, in order:

1. Holders on Solana and Robinhood Chain (web app, Solana Action).
2. Agents managing tokenized-stock portfolios (MCP tool `protect_portfolio`).
3. Later: apps and lending protocols that hold tokenized stocks and want protection for a whole book.

## Components

| Component | Where | Role |
|---|---|---|
| Pricing engine and quote service | TypeScript | Prices the put spread from the stock's history of openings (Weekend Markets' kernel model, backtested) until the next open, signs quotes for either vault |
| EVM vault | Robinhood Chain, Solidity | Sells protection against a signed quote (EIP-712), locks the maximum payout, settles on Chainlink's round in force at the open, pays claims |
| Solana vault | Solana, Anchor | The same against an ed25519-signed quote, settled on the first Pyth print at or after the open |
| Keepers | TypeScript | Permissionless: settle each due series (Pyth's first print posted through its receiver; Chainlink's round in force found by binary search), void the unsettleable, claim every position to its buyer. The Solana keeper can also plan a run: what it would settle on and pay, sending nothing |
| Hedger (planned) | TypeScript, Hyperliquid | Sums open protection across vaults, shorts the matching `xyz:` perp at the close, closes the hedge at the open |
| App | Next.js | Protect with a Solana / Robinhood Chain switch (live pricing, payoff, backtest, "protect what I hold"); My protection, Vault and Track record for both chains; a devnet faucet and a Solana Action. Planned: the live hedge |
| MCP server | TypeScript | Hosted (no keys, returns unsigned transactions) and local (the agent's own devnet wallet, capped spend): `protect_portfolio`, `quote_protection` and read tools |

### Why a vault and fixed quotes (not Weekend Markets' pools)

Weekend Markets sold cover as stakes in parimutuel YES/NO pools. The payout was an estimate until betting closed, and liquidity came from operator seeding. A vault that sells against a signed quote gives the buyer a fixed price and payout, and its capacity comes from collateral plus the hedge, not from seeded pools. Settlement keeps Weekend Markets' rule.

### Pricing reference: protecting against informed buyers

Outside the session, protection is priced from the lower of the last close and Hyperliquid's live price, and sales pause after a move of more than 5% since the close. Pricing only from the close would leak edge: on weeknights, and 5.5 hours before the open on weekends, Hyperliquid's price beats the close as a predictor of the open about two-thirds of the time (research/results/multi-weekend-proof.md). Anyone watching it could buy underpriced protection after a drop. Using the lower price makes protection dearer after a drop and never cheaper after a rise. The pause covers moves the history of openings can't price, such as earnings after the bell.

### Settlement: the first print at or after the open

- Solana: a Pyth `PriceUpdateV2`, Wormhole-verified by Pyth's receiver, with `prev_publish_time < open_ts <= publish_time <= open_ts + window` (Weekend Markets' rule and tests).
- Robinhood Chain: Chainlink's 24/5 tokenized-equity feed (token price = stock price × the token's `uiMultiplier`). It pushes a round on a 0.5% move or daily, so the contract settles on **the round in force at the open**: the settler passes round `r`; the contract requires `updatedAt(r) <= open_ts`, and either `updatedAt(r+1) > open_ts` in the same phase or `r` is still the latest round. A round older than a set age at the open (a stale feed, an oracle pause for a corporate action) voids instead of settling. Measured precision: 19.5 bps median, 44.5 bps worst, against Pyth's open (research/results/chainlink-settlement.md). Settling on the first round *after* the open would be ~61 bps off, because a new round only fires once the price has moved 0.5%.
- If no valid price arrives within the window (a halt, a missed holiday), the protection voids and the premium is refunded.

## Evidence (research/, reproducible)

`npm run proof` and `npx tsx research/proof-multi.ts`, Hyperliquid candles cached in `research/data`.

1. **Hyperliquid tracks the prints we settle on.** Its xyz:TSLA price is a median 2.7 bps from Pyth's 16:00 ET close and 4.1 bps from Pyth's 09:30 ET open (46 sessions). A hedge opened at the close and closed at the open follows the settlement price to within a few bps.
2. **Hyperliquid's weekend price does not predict Monday's open.** Across six xyz markets (TSLA, NVDA, AAPL, COIN, MSTR, XYZ100) and 84 weekends, its price on Saturday and Sunday was further from Monday's open than Friday's close was (error 7% to 15% larger). It starts to help from Monday pre-market (25% of the close's error removed at 04:00 ET). Overnight on weekdays it helps earlier (19% at 21:30 ET, 34% at 04:00 ET, 342 nights).

Design consequences: price protection from the history of openings, centred on the close, not from the weekend tape; hedge at the close, where Hyperliquid matches the close. A hedge put on during the weekend enters at a noisy price, which costs variance, not bias.

3. **Chainlink on Robinhood Chain settles the open to about 20 bps.** `npx tsx research/chainlink.ts` reads every round of the TSLA feed (1,367 since 22 June, ~14 a day) and compares the round in force at 09:30 ET with Pyth's opening print on 46 openings: median 19.5 bps, worst 44.5 bps.

## Infrastructure checks (26 Sep)

| Check | Result |
|---|---|
| Chainlink stock feeds on Robinhood Chain | Mainnet only: TSLA, NVDA, AAPL, SPY, COIN, MSTR (8 decimals, 0.5% deviation, 24h heartbeat, 24/5). None on testnet (Chainlink's feed directory has no Robinhood testnet list) |
| Pyth on Robinhood Chain | Not deployed (not in Pyth's EVM list; the contract at Pyth's usual address there is something else) |
| Hyperliquid stock perps | Mainnet `xyz:TSLA` (~$48M open interest), testnet `x:TSLA` and `felix:TSLA` exist |
| Hyperliquid testnet funds | The faucet only pays addresses that have deposited on Hyperliquid mainnet |

So a Robinhood Chain vault that settles on a real oracle has to live on mainnet. Plan: deploy it there with a valueless test token as collateral, so settlement is real and no real money is at stake. Decided; it waits on a deploy wallet the user funds with gas.

## Chains and tracks

Colosseum's form asks for every chain integrated. We select only chains that are integrated and deployed:

- **Solana**: Solana vault, Pyth settlement, Solana Action, agents.
- **Robinhood Chain**: EVM vault for Stock Tokens, Chainlink settlement.
- **Hyperliquid**: the hedge book (testnet orders on an `xyz`/`felix` TSLA perp) and live prices.
- **Arbitrum**: only if Colosseum confirms one project can win more than one chain-track prize (a one-day redeploy of the EVM vault).

## Plan (Lagos dates, deadline Oct 11 23:59)

| Dates | Work |
|---|---|
| Sep 26 (done) | Repo, research proof, infrastructure checks; pricing engine and quote signing (EIP-712, ed25519); EVM vault (Foundry and fork tests); Solana vault (LiteSVM tests); Solana devnet deploy; quote service; app (Protect, My protection, Vault, Track record), faucet, Solana Action; Robinhood Chain buying and claiming in the app (against a local chain); keepers for both vaults, with a read-only plan for the Solana one; MCP server |
| Sep 28 | First devnet settlement and claims by the keeper after Monday's open; week-2 update video |
| Sep 27 to Oct 1 | Robinhood Chain mainnet deploy with test collateral (waits on the deploy wallet); hosting |
| Oct 2 to 6 | Hedger on Hyperliquid, inside the Perps hackathon window; exposure across vaults; tests |
| Oct 6 to 8 | Hedge shown in the app; Perps submission Oct 8 |
| Oct 9 | Buffer, traction push |
| **cut line** | Below: Arbitrum, vault shares for outside depositors, stocks beyond TSLA (Pyth entitlement), Solami side track |
| Oct 10 to 11 | Video, deck, README, form, submit |

Running alongside: weekly update videos (Sep 28, Oct 5), Superteam Nigeria sessions, users and letters of intent, a teammate.

## Open questions

- Can one project win more than one chain-track prize? (Decides Arbitrum.)
- Robinhood Chain vault on mainnet with test collateral: decided (yes); waiting on a funded deploy wallet.
- Hyperliquid testnet access: the hedger's address needs a mainnet deposit first (the user's call).
- Perps hackathon rules: start date, eligibility of work that is also entered at Colosseum.
