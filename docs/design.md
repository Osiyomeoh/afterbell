# Afterbell: design

Protection for tokenized stocks until the next open, sold on the chain where you hold them, hedged on Hyperliquid.

Status: design. Only `research/` is built; everything else here is planned. The README keeps the built/planned split current.

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
| Pricing engine | TypeScript | Prices the put spread from the stock's history of openings (Weekend Markets' kernel model, backtested), signs quotes |
| EVM vault | Robinhood Chain, Solidity | Sells protection against a signed quote (EIP-712), locks the maximum payout, settles on Chainlink's first round at or after the open, pays claims |
| Solana vault | Solana, Anchor | The same against an ed25519-signed quote, settled on the first Pyth print at or after the open |
| Hedger | TypeScript, Hyperliquid | Sums open protection across vaults, shorts the matching `xyz:` perp at the close, closes the hedge at the open |
| App | Next.js | Protect (holdings across chains, one ticket), Vault (collateral per chain, live hedge), Track record |
| MCP server | TypeScript | `protect_portfolio` and read tools for agents |

### Why a vault and fixed quotes (not Weekend Markets' pools)

Weekend Markets sold cover as stakes in parimutuel YES/NO pools. The payout was an estimate until betting closed, and liquidity came from operator seeding. A vault that sells against a signed quote gives the buyer a fixed price and payout, and its capacity comes from collateral plus the hedge, not from seeded pools. Settlement keeps Weekend Markets' rule.

### Settlement: the first print at or after the open

- Solana: a Pyth `PriceUpdateV2`, Wormhole-verified by Pyth's receiver, with `prev_publish_time < open_ts <= publish_time <= open_ts + window` (Weekend Markets' rule and tests).
- Robinhood Chain: Chainlink. The settler passes a round id; the contract checks `updatedAt(round) >= open_ts` and `updatedAt(previous round) < open_ts` within the same phase, so nobody can pick a later, friendlier round.
- If no valid price arrives within the window (a halt, a missed holiday), the protection voids and the premium is refunded.

## Evidence (research/, reproducible)

`npm run proof` and `npx tsx research/proof-multi.ts`, Hyperliquid candles cached in `research/data`.

1. **Hyperliquid tracks the prints we settle on.** Its xyz:TSLA price is a median 2.7 bps from Pyth's 16:00 ET close and 4.1 bps from Pyth's 09:30 ET open (46 sessions). A hedge opened at the close and closed at the open follows the settlement price to within a few bps.
2. **Hyperliquid's weekend price does not predict Monday's open.** Across six xyz markets (TSLA, NVDA, AAPL, COIN, MSTR, XYZ100) and 84 weekends, its price on Saturday and Sunday was further from Monday's open than Friday's close was (error 7% to 15% larger). It starts to help from Monday pre-market (25% of the close's error removed at 04:00 ET). Overnight on weekdays it helps earlier (19% at 21:30 ET, 34% at 04:00 ET, 342 nights).

Design consequences: price protection from the history of openings, centred on the close, not from the weekend tape; hedge at the close, where Hyperliquid matches the close. A hedge put on during the weekend enters at a noisy price, which costs variance, not bias.

## Chains and tracks

Colosseum's form asks for every chain integrated. We select only chains that are integrated and deployed:

- **Solana**: Solana vault, Pyth settlement, Solana Action, agents.
- **Robinhood Chain**: EVM vault for Stock Tokens, Chainlink settlement.
- **Hyperliquid**: the hedge book (testnet orders on an `xyz`/`felix` TSLA perp) and live prices.
- **Arbitrum**: only if Colosseum confirms one project can win more than one chain-track prize (a one-day redeploy of the EVM vault).

## Plan (Lagos dates, deadline Oct 11 23:59)

| Dates | Work |
|---|---|
| Sep 26 | Repo, research proof, checks: Chainlink stock feeds on Robinhood Chain testnet, Hyperliquid testnet order |
| Sep 27 | Pricing engine: put-spread pricing from the openings model, quote format and signing (EIP-712 and ed25519), tests |
| Sep 28 to Oct 1 | EVM vault on Robinhood Chain: buy, settle on the first Chainlink round, claim, void; Foundry tests; testnet deploy |
| Oct 2 to 5 | Solana vault inside the Perps hackathon window: buy against an ed25519 quote, Pyth settlement, claim, void; LiteSVM tests; devnet deploy |
| Oct 4 to 6 | Hedger on Hyperliquid testnet; exposure across vaults; tests |
| Oct 6 to 8 | App (Protect, Vault, Track record), MCP `protect_portfolio`, Solana Action; Perps submission Oct 8 |
| Oct 9 | Buffer, traction push |
| **cut line** | Below: Arbitrum, vault shares for outside depositors, stocks beyond TSLA (Pyth entitlement), Solami side track |
| Oct 10 to 11 | Video, deck, README, form, submit |

Running alongside: weekly update videos (Sep 28, Oct 5), Superteam Nigeria sessions, users and letters of intent, a teammate.

## Open questions

- Can one project win more than one chain-track prize? (Decides Arbitrum.)
- Are Chainlink's stock feeds live on Robinhood Chain testnet, and at what heartbeat?
- Hyperliquid testnet access for the hedger's wallet.
- Perps hackathon rules: start date, eligibility of work that is also entered at Colosseum.
