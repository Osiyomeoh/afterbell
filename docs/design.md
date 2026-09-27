# Afterbell: design

Protection for tokenized stocks until the next open, sold on the chain where you hold them, hedged on Hyperliquid.

Status (27 Sep): the Solana vault is live on devnet, with the app, quote endpoint, faucet, Blink, keeper and MCP server built on it. The EVM vault is at v2: an underwriters' pool, positions as NFTs, risk limits, keeper tips and one-transaction buys. It, its client, its keeper and the app's Robinhood Chain flow are built and tested on a local chain, and its settlement against the live feed in fork tests; it waits on a mainnet deploy. The Solana vault's second version has the same (NFT positions as Token-2022 tokens), built and tested on the compiled program and run with the app on a local validator. It's deployed on devnet with its pool underwritten, next to the first version, and the app switches to it after Monday's first settlement. The app's track record covers both vaults. The hedger on Hyperliquid is written and tested, and its plan mode and the Vault page read the live vaults and prices; it hasn't traded yet, which waits on its testnet accounts (docs/hedger.md). The README keeps the built/planned split current.

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
| EVM vault | Robinhood Chain, Solidity | Sells protection against a signed quote (EIP-712; with a permit, in one transaction) as an NFT, within the pool's risk limits; locks the maximum payout, settles on Chainlink's round in force at the open, pays each NFT's holder. Underwritten by a pool anyone can join (ERC-7540) |
| Solana vault | Solana, Anchor | The same sale against an ed25519-signed quote, settled on the first Pyth print at or after the open, with the same pool, NFT positions (Token-2022), risk limits and tips. Both run on devnet: the second since 27 Sep, and the first (collateral without pool shares, positions as accounts) until its Monday positions are paid out |
| Keepers | TypeScript | Permissionless: settle each due series (Pyth's first print posted through its receiver; Chainlink's round in force found by binary search), void the unsettleable, pay every position out to its NFT's holder, earning the keeper's tip, then roll the pool. Both can plan a run: what they would settle on and pay, sending nothing |
| Hedger (written, not trading yet) | TypeScript, Hyperliquid | Reads open protection from both Solana vaults, and Robinhood Chain's once deployed, and holds a short in `xyz:TSLA` equal to its delta under the pricing model, rebalanced every 5 minutes and bought back at the open. On Hyperliquid testnet at mainnet's price, filling against our own quoting account (testnet's book is empty). Plan: docs/hedger.md |
| App | Next.js | Protect with a Solana / Robinhood Chain switch (live pricing, payoff, backtest, "protect what I hold"); My protection, Vault and Track record for both chains; each chain's pool (deposit, withdraw) and each position's NFT; a devnet faucet and a Solana Action; the hedge, on the Vault page |
| MCP server | TypeScript | Hosted (no keys, returns unsigned transactions) and local (the agent's own devnet wallet, capped spend): `protect_portfolio`, `quote_protection` and read tools |

### Why a vault and fixed quotes (not Weekend Markets' pools)

Weekend Markets sold cover as stakes in parimutuel YES/NO pools. The payout was an estimate until betting closed, and liquidity came from operator seeding. A vault that sells against a signed quote gives the buyer a fixed price and payout, and its capacity comes from what underwriters deposit (and later the hedge), not from an operator seeding each market. Settlement keeps Weekend Markets' rule.

### Underwriting: the pool, rounds and risk limits (vault v2)

Built on both chains, the same way except where noted under "On Solana".

- **A pool anyone can join.** Underwriters deposit collateral for shares (the vault's own ERC-20) and earn the premiums net of payouts. The owner can't withdraw it; an owner who deposited leaves like anyone else.
- **Deposits and withdrawals wait for the roll (ERC-7540).** The pool's liability during a round depends on the coming open. If shares were priced continuously, an underwriter could join on a night that looks quiet, or leave ahead of a gap they see coming on Hyperliquid, and take value from the others. So deposits and withdrawals are requests, filled at the next roll and then claimed. The pool rolls once the round's opening has passed and every position it sold is paid out (or at any time if it sold nothing). Nothing is at risk then, so a share's price is exactly what the pool holds: a deposit never dilutes the underwriters already in. During a round, `totalAssets()` counts every open position at its maximum payout, so it errs low.
- **One opening per round.** The first sale after a roll fixes the round's opening, and every later sale must be for the same one. The contract can't know the exchange's holidays; the quoter's signature vouches that the opening is real.
- **Risk limits, fixed for the round.** A round may lock at most 50% of the pool's value at its roll, and at most 20% of it on any one stock. Both are measured against the value at the roll, so they can't move within a round, and changes to them (and to the settlement timings) wait for the next roll. So even a night on which every position pays its maximum costs the pool at most half its value, spread over at least three stocks. `capacity(feed)` gives the room left, and the quote endpoint won't sign a sale beyond it.
- **Positions are NFTs.** Each sale mints an ERC-721 to the buyer, and the payout goes to whoever holds it when it's paid, so protection can be sold, lent against or held by another contract. The image is drawn on-chain from the vault's record and keeps the outcome after payment.
- **Keepers are paid.** `process` pays a settled or voided series' positions out in batches, to each NFT's holder, and pays the caller 2% of each premium, set aside at the sale. A voided position gets its whole premium back, with no tip. Anyone can settle, pay out and roll, so none of it depends on our keeper running.
- **One transaction.** The collateral takes EIP-2612 permits, so buying and requesting a deposit need no approval first.
- **No upgrades.** The EVM vault is immutable: no proxy and no diamond, so the rules can't change under an open position. It is 20,967 bytes, built with Solidity's IR pipeline (the limit is 24,576). The Solana program, on devnet, keeps an upgrade authority (the deployer's key), so a bug found there can be fixed in place; the README says so.
- **Checked by invariants.** Random sequences of every action (sales, NFT transfers, settlements and voids, payouts, deposits and withdrawals, rolls) must keep the vault holding everything it owes, every unpaid position locked, every payout within its maximum and every round within its limit. Slither runs in CI. The Solana program's randomized sequences check the same four properties after every step.
- **On Solana.** The shares and the position NFTs are Token-2022 tokens the vault mints; each NFT carries its name and position on the mint. A program sees only the accounts it's passed and can't loop over a list of series, so the vault counts the round's unpaid positions and rolls when the count is zero; each roll's value is an account of its own, and a request fills at it the next time its owner touches it. Paying a position out takes the account holding its NFT, which proves the holder, and the holder's collateral account. A holder can burn a Token-2022 NFT, which would leave a position nobody can be paid and a round that can't end, so the position's mint with a supply of zero stands in for the holder and the payout stays in the pool. The image comes from the app, drawn from the position's accounts as the EVM contract draws it, since a program can't answer a request for it. No permit: a transfer is signed inside the transaction that makes it.

### Pricing reference: protecting against informed buyers

Outside the session, protection is priced from the lower of the last close and Hyperliquid's live price, and sales pause after a move of more than 5% since the close. Pricing only from the close would leak edge: on weeknights, and 5.5 hours before the open on weekends, Hyperliquid's price beats the close as a predictor of the open about two-thirds of the time (research/results/multi-weekend-proof.md). Anyone watching it could buy underpriced protection after a drop. Using the lower price makes protection dearer after a drop and never cheaper after a rise. The pause covers moves the history of openings can't price, such as earnings after the bell.

### Settlement: the first print at or after the open

- Solana: a Pyth `PriceUpdateV2`, Wormhole-verified by Pyth's receiver, with `prev_publish_time < open_ts <= publish_time <= open_ts + window` (Weekend Markets' rule and tests).
- Robinhood Chain: Chainlink's 24/5 tokenized-equity feed (token price = stock price × the token's `uiMultiplier`). It pushes a round on a 0.5% move or daily, so the contract settles on **the round in force at the open**: the settler passes round `r`; the contract requires `updatedAt(r) <= open_ts`, and either `updatedAt(r+1) > open_ts` in the same phase or `r` is still the latest round. A round older than a set age at the open (a stale feed, an oracle pause for a corporate action) voids instead of settling. Measured precision: 19.5 bps median, 44.5 bps worst, against Pyth's open (research/results/chainlink-settlement.md). Settling on the first round *after* the open would be ~61 bps off, because a new round only fires once the price has moved 0.5%. From their launch until 13:48 UTC on 23 June, the Robinhood feeds published answers 10^8 too large (16 decimals while reporting 8). So the contract also bounds the settlement price by the strikes the series sold: no more than 10 times its highest upper strike, no less than a tenth of its lowest lower strike. Outside that it's a broken feed, and the series voids and refunds rather than settling at nothing (or, for a price far too small, at the maximum). The histories leave those rounds out too. Stock splits aren't handled by the bound (a 2:1 split halves the price); the feed's behaviour around one is still to be checked.
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
| Chainlink stock feeds on Robinhood Chain | Mainnet only: 35 US equity feeds (8 decimals, 0.5% deviation, 24h heartbeat, 24/5); 34 used, SGOV left out. None on testnet (Chainlink's feed directory has no Robinhood testnet list). The list: `research/data/robinhood-stocks.json` (`research/robinhood-stocks.ts`) |
| Pyth entitlement | The quote service's Pyth key reads TSLA and QQQ; other Equity.US feeds answer 403. So Solana sells those two; Robinhood Chain, which needs no key, covers all 34 |
| Pyth on Robinhood Chain | Not deployed (not in Pyth's EVM list; the contract at Pyth's usual address there is something else) |
| Hyperliquid stock perps | Mainnet `xyz:TSLA` (~$48M open interest), testnet `x:TSLA` and `felix:TSLA` exist |
| Hyperliquid testnet funds | The faucet only pays addresses that have deposited on Hyperliquid mainnet |

So a Robinhood Chain vault that settles on a real oracle has to live on mainnet. Plan: deploy it there with a valueless test token as collateral, so settlement is real and no real money is at stake. Decided; it waits on a deploy wallet the user funds with gas.

## Chains and tracks

Colosseum's form asks for every chain integrated. We select only chains that are integrated and deployed:

- **Solana**: Solana vault, Pyth settlement, Solana Action, agents.
- **Robinhood Chain**: EVM vault for Stock Tokens, Chainlink settlement.
- **Hyperliquid**: the hedge (HyperCore testnet orders in `xyz:TSLA`) and live prices.
- **Arbitrum**: only if Colosseum confirms one project can win more than one chain-track prize (a one-day redeploy of the EVM vault).

## Plan (Lagos dates, deadline Oct 11 23:59)

| Dates | Work |
|---|---|
| Sep 26 (done) | Repo, research proof, infrastructure checks; pricing engine and quote signing (EIP-712, ed25519); EVM vault (Foundry and fork tests); Solana vault (LiteSVM tests); Solana devnet deploy; quote service; app (Protect, My protection, Vault, Track record), faucet, Solana Action; Robinhood Chain buying and claiming in the app (against a local chain); keepers for both vaults, each with a read-only plan; MCP server; all 34 Chainlink stocks priced; EVM vault v2 (pool, NFT positions, risk limits, keeper tips, permit buys) with invariant tests and Slither, run in the app against a local chain; Solana vault v2 (the same, with Token-2022 NFTs) with randomized sequence tests, its keeper, and the app and agent on it, run against a local validator |
| Sep 27 (done) | Solana vault v2 deployed to devnet, its pool underwritten with 100,000 TestUSD; the hedger written and tested (sizing, signing, plan mode, the testnet quoter, sending, a backtest, the Vault page), its plan modes run against the live vaults and Hyperliquid |
| Sep 28 | First devnet settlement and claims by the keeper after Monday's open; week-2 update video |
| Sep 28 to Oct 1 | The app switches to Solana vault v2; Robinhood Chain mainnet deploy with test collateral (when the deploy wallet is funded); hosting |
| Oct 2 to 6 | Hedger trading on Hyperliquid testnet across opens (its accounts first) |
| Oct 6 to 8 | Perps submission Oct 8 |
| Oct 9 | Buffer, traction push |
| **cut line** | Below: Arbitrum, Solana stocks beyond TSLA and QQQ (Pyth entitlement), Solami side track. Vault shares for outside depositors started below the line and are now built on both chains (the pool) |
| Oct 10 to 11 | Video, deck, README, form, submit |

Running alongside: weekly update videos (Sep 28, Oct 5), Superteam Nigeria sessions, users and letters of intent, a teammate.

## Open questions

- Can one project win more than one chain-track prize? (Decides Arbitrum.)
- Robinhood Chain vault on mainnet with test collateral: decided (yes); waiting on a funded deploy wallet.
- Hyperliquid testnet access: the hedger's address needs a mainnet deposit first (the user's call).
- Perps hackathon rules: start date, eligibility of work that is also entered at Colosseum.
