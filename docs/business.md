# Afterbell: business plan

30 September 2026. Figures from this repo are reproducible from it; market figures name their source and date.

## In one paragraph

Tokenized stocks trade around the clock, but the stock itself opens at 09:30 ET, and whatever happened while the exchange was shut lands on the token all at once. Afterbell sells protection until that open: pay once, and if the stock opens below your level, the vault pays the difference on every share, down to a floor, settled by the oracle's price at the open. Underwriters fund the vault and earn the premiums, and a short on Hyperliquid offsets part of what the vault could pay out. It runs on Solana (Pyth) and Robinhood Chain (Chainlink), and covers 34 US stocks and funds.

## Where it stands (28 September)

Everything below runs on test money: TestUSD, which has no value, and Hyperliquid's testnet.

- **Live on three chains.** The Solana vault on devnet, settled by Pyth; the Robinhood Chain vault on mainnet, settled by Chainlink, for 34 stocks; the hedge on Hyperliquid. The app is hosted at [afterbell-nine.vercel.app](https://afterbell-nine.vercel.app), with a Blink, an MCP server for agents, a typed SDK and an OpenAPI description of the API.
- **First settlements, 28 September.** Both Solana vaults settled their series for Monday's open on Pyth's opening print, $368.09, and paid out: two of the six positions paid, $4.46 in all, on $16.88 of premiums.
- **The hedge traded through the night and closed at the bell.** A short in Hyperliquid's `xyz:TSLA`, sized to the open protection and adjusted every five minutes, bought back at 13:30:03 UTC: 16 trades, +$5.21 closed, $0.32 in fees.
- **The book, after one opening:** underwriting +$12.42 (premiums less payouts), hedge +$4.90, together +$17.32. One opening proves the machinery, not the economics.
- **The first Robinhood Chain purchase**, 28 September: 10 TSLA protected from $352.16 to $323.41 for $17.37. The hedger picked it up and opened a 2.029 TSLA short two minutes later, so protection sold on one chain is hedged on another. It settled on Chainlink's round in force at Tuesday's open, $359.345 (Pyth's opening print that day: $358.49), and paid nothing, since TSLA opened above its level. The Robinhood Chain keeper runs by hand for now, so it settled a day late.
- **"Protect every night" on Robinhood Chain**, 30 September: the first renewal was skipped because Thursday's price, $22.85, was above the holder's $20.91 cap. That's the cap doing its job.
- **No outside users yet.** Every purchase so far is the team's. The first night aimed at outside users is Friday 2 October (below).

## The customer and the problem

**Holders of tokenized stocks.** RWA.xyz counted 4.0 million holders of tokenized stocks and $3.14 billion of them distributed on-chain on 27 September 2026, led by Ondo ($869M), bStocks ($762M) and xStocks ($569M) ([rwa.xyz/stocks](https://app.rwa.xyz/stocks)). A count by assets under management put the market at $4.43 billion on 15 September, up 390% since January ([Seoul Economic Daily, 27 Sep](https://en.sedaily.com/finance/2026/09/27/tokenized-stocks-jump-fivefold-in-2026-as-us-venues-prepare)). The two counts differ in method; both say the market grew several times over this year.

**The gap is real and frequent.** On the 46 TSLA openings from 22 July to 25 September 2026 (`research/data/pyth-tsla-gaps.json`, Pyth's closes and opening prints), TSLA opened at least 1% below its close 11 times, at least 2% below twice, and 8.8% below once (23 July, the morning after Tesla reported its second-quarter results after the close on 22 July). The median gap either way was 0.7%. A holder often knows which night to worry about: earnings come out after the close, and Tesla's second-quarter deliveries came out at about 09:05 ET on 2 July, before the open. Its third-quarter deliveries are expected before the open on Friday 2 October, and the app says which protection covers them.

**A holder has nothing good to buy today:**

| Alternative | Why it doesn't fit |
|---|---|
| A listed put | Needs a brokerage account, trades only in the session, and can't be bought against a token in a wallet |
| A perp short (Hyperliquid) | A second account, margin, funding and liquidation risk, and it gives up the upside the holder wants to keep |
| Selling before the close | Gives up any gap up, pays two spreads and may be a taxable sale |
| Doing nothing | The whole gap lands on them |

Afterbell is one purchase with a fixed price and a fixed maximum payout, from the wallet that holds the token, and "protect what I hold" sizes it to what that wallet holds.

**Underwriters** are the other side: they deposit into the vault's pool, earn the premiums, and pay what the protection pays. Risk limits cap each night at 50% of the pool and 20% on any one stock, measured at the pool's value when the round started. Deposits and withdrawals fill at the pool's exact value once each night is paid out, so nobody joins or leaves at a stale price.

**Later: apps and agents.** Wallets, lending protocols that take tokenized stocks as collateral, and agents that manage a portfolio. The MCP server already lets an agent price and buy protection for a wallet.

## What it costs and what it pays

Pricing is the model's fair value, from the stock's own history of openings, plus a 15% margin. For TSLA, replayed on 36 openings (5 August to 25 September, each priced only from the openings before it; `pricing/backtest.ts`):

| Protection | Premium per night, as a share of the stock price | Premium as a share of the most it can pay | Nights it paid | Paid back per $1 of premium |
|---|---|---|---|---|
| 2% to 10% below the close | 0.36% on average (0.23% to 0.74%) | 4.5% | 1 of 36 | 15¢ |
| 1% to 5% below | 0.36% (0.27% to 0.62%) | 8.9% | 8 of 36 | 58¢ |

On this sample, buyers paid more than they got back, which is where the underwriters' return comes from. It's a small, calm sample: the 8.8% night falls before it (in the history the replay prices from), so tail protection was priced for a night that didn't come again. The price is the lever: the margin, and how much weight the model gives the worst nights, set how good a deal it is for each side. We publish the running figure (paid back per $1 of premium, from the track record) rather than a promise, and tune the margin toward 70¢ to 85¢ over a year once there are enough nights to measure it.

**The hedge.** In a backtest over the same 36 nights, a short in Hyperliquid's `xyz:TSLA`, rebalanced hourly overnight, cut the spread of the vault's nightly results by 38% (2% to 10%) and 62% (1% to 5%). Most of that came from one night, 3 to 4 September, when TSLA fell through the night on Hyperliquid (`research/results/hedge-backtest.md`). A steadier pool can sell more protection on the same capital.

## How Afterbell makes money

**Today it doesn't.** Every premium goes to the pool, less a 2% tip to whoever pays positions out. That's deliberate for a hackathon build on test money. Ways to earn, in the order we'd add them:

1. **A protocol fee on each premium**, taken at the sale like the keeper's tip and sent to a treasury. We'll charge 10%, the rate the arithmetic below uses: low enough that the premium stays mostly the underwriters', which is what keeps the pool funded. At 10% of the premium: 0.36% of the protected value per night × 250 nights × 10% ≈ 9% a year of the average value protected each night. So $10 million protected on an average night would bring in about $900,000 a year. That's arithmetic, not a forecast: we have no paying users yet. Adding it changes both vaults, so it lands in the next contract versions.
2. **House underwriting.** The team seeds the pool and earns what any underwriter earns, hedged on Hyperliquid.
3. **Protection for a whole book**, sold to wallets, issuers and lending protocols through the quote service (the SDK's `quoteBook` quotes a book in one call). The same protocol fee applies, with no separate charge per quote, so integrating costs a partner nothing until their users buy.

## Go to market

**Now to 11 October (the hackathon).** Test money only: Solana devnet and a valueless TestUSD. The goal is the first outside users, which we don't have yet. The first series settled on 28 September (above).
- **Blinks.** The Solana Action sells protection from any wallet or Blink client, and a fresh wallet is sent test money first, so one click works from nothing. A Blink can be posted anywhere a link can.
- **Agents.** The hosted MCP server holds no keys and returns transactions for the agent's own wallet to sign.
- **Events.** Scheduled news that lands while the exchange is shut. The first campaign is Tesla's third-quarter deliveries, expected before Friday 2 October's open: the app shows when protection for that open goes on sale and how much has sold, and each position has a page to share, with its result once the bell has rung.
- **Community.** Superteam Nigeria sessions, and the weekly update videos.

**After the hackathon: mainnet, small.** In this order, with caps raised only as the track record grows:
1. An audit of both vaults.
2. Robinhood Chain first: its vault covers 34 stocks through Chainlink and is ready to deploy. Then Solana, where Pyth's feeds limit us to TSLA and QQQ until the entitlement grows.
3. Real collateral (USDC), with the pool capped at $50,000 to start and the existing risk limits (each night at most 50% of the pool, each stock at most 20%).
4. The hedger on Hyperliquid mainnet, capped at $5,000 of short.

**The protocol pitch, with real numbers.** Kamino's lending markets hold $29.1M of tokenized stocks as collateral with $6.3M borrowed against it (its public API, 28 September). If each stock repeated its worst recorded opening at once, that collateral would lose about $1.3M; protecting all of it from 2% to 10% below until the next open costs about $94,000, 0.38% a night, for up to $1.96M of cover. The live report is at [/kamino](https://afterbell-nine.vercel.app/kamino).

**Where Kamino's loans break.** We read every loan in those markets that borrows against a tokenized stock: 1,609 loans, $6.58M of debt (30 September; the chain lists them, Kamino's API values them). None can be liquidated today. If every stock opened 10% down together, 45 loans with $84,000 of debt would become liquidatable; at 15%, 91 loans and $940,000; at 20%, 168 loans and $1.47M. That curve is the lender's overnight exposure, and cover sized to each loan's own liquidation price is what flattens it.

**Loan-aware protection.** The same page checks a single borrower's loan. It reads the wallet's Kamino obligations and finds the opening that would make each loan liquidatable, for its stocks falling together and for each one alone. It then counts how many recorded openings went that far and prices protection from 2% below down to exactly that price. That's the product a lending protocol can put beside its "borrow" button: cover sized to your own liquidation price, not a generic band. The protection pays after the open, so it pays back what the gap took rather than preventing the liquidation; we say so on the page.

**Private protection.** Cover sized to a loan tells the chain where that loan breaks, which is worth something to anyone hunting liquidations. So a holder can buy it privately: they pay the premium to Afterbell's desk as a confidential transfer on Helius's Solana Rings, the desk buys the protection in its own name, and it pays the holder the same way after the open. The chain sees the two wallets dealing, never the amount or which position is theirs. It runs on devnet today (29 Sep: the premium's transaction shows no token and no amount); the holder trusts the desk, and making it trustless means the vault paying through a private escrow, after the hackathon.

**Distribution partners to approach (none contacted yet):** wallets that show tokenized stocks (a "protect overnight" button beside the holding), the issuers (Ondo, xStocks, Robinhood), and lending protocols that take tokenized stocks as collateral.

**What we'll measure:** value protected per night, premiums, how many nights each buyer comes back for, the pool's size and return, and how much the hedge cuts the pool's nightly swings.

## Why now

- Tokenized stocks grew several times over in 2026 (above), and each new holder has the same exposure after the close.
- Most of the trading happens while the exchange is shut. Gapguard's research found 72.5% of the dollar volume in Robinhood Chain's tokenized-stock Uniswap v4 pools ($1.29B of $1.78B, 31 Aug to 21 Sep 2026) traded while NYSE was closed ([gapguard/research](https://github.com/Bytethebuilder/gapguard)). Their numbers, not ours.
- Lending against tokenized stocks has started: Kamino holds most of it on Solana, and Kraken's xStocks vaults (14 Sep 2026) borrow against tokenized stocks through it. A leveraged book's worst night is a gap at the open.
- Oracles publish stock prices on-chain on their own schedule: Pyth's equity feeds on Solana, and Chainlink's 24/5 feeds for 35 US equities on Robinhood Chain. So an open can be settled on-chain without trusting us (`research/results/chainlink-settlement.md`: Chainlink's round in force at the open was a median 19.5 bps from Pyth's opening print).
- Hyperliquid's `xyz:` stock perps trade overnight and track the prices we settle on (median 2.7 bps from Pyth's close, 4.1 bps from its open over 46 sessions), so the pool can hedge while the exchange is shut.

## Competition

Besides the holder's alternatives in the table above, several open-source hackathon projects from this month work on the same gap or next to it (read on GitHub, 27 and 28 September 2026):

| Project | What it is | How it differs from Afterbell |
|---|---|---|
| [AfterHours](https://github.com/bchuazw/afterhours) (Arbitrum Open House Singapore, from 14 Sep) | Weekend-gap puts on Robinhood Chain Stock Tokens, one ERC-4626 writer vault per stock, priced on-chain in Stylus from the feed's realized volatility with closed hours weighted up; runs on testnet against a mirror of Chainlink's feed | Weekends only, one chain; a put with no floor; priced from a volatility model rather than from how the stock has actually opened |
| [Recess](https://github.com/valeriusxix/Recess) (Stocklana, from 25 Sep) | Parametric gap cover for TSLA on Solana devnet, settled on Pyth, with a flat premium table (4% of notional for a 2% threshold) and a demo mode that forces prices | One stock, fixed prices not tied to the stock's history, no hedge |
| [Sherwood](https://github.com/xarkgg/sherwood) (Arbitrum Open House Singapore, from 9 Sep; 115 commits, live site) | "Protection Notes" on Robinhood Chain Stock Tokens: a floor as a share of the entry price for 1 to 30 days, settled on Chainlink, from a vault with a 30% per-stock cap; on Robinhood Chain's testnet | The closest product. Longer terms rather than the opening gap; testnet feeds; no hedge; its pricing isn't published |
| [GapTape](https://github.com/aps32221/GapTape) (from 24 Sep) | "A P2P weekend short market with parametric gap insurance"; four commits, no README yet | Too early to compare |
| [Holdline](https://github.com/dmustapha/holdline) (from 25 Sep) | A vault and keeper that repay a Kamino loan backed by tokenized stocks before an overnight gap can liquidate it | The same customer as our protocol pitch, a different tool: it repays a loan, where we pay the gap; the two could work together |
| [Fletcher](https://github.com/nirholas/fletcher) (from 10 Sep) | Splits a Robinhood Chain share into FLOOR and TURBO tokens: a capped first claim and the leveraged rest | A floor by structure, for a holder willing to give up the upside |
| [Gapguard](https://github.com/Bytethebuilder/gapguard) (from 22 Sep) | A Uniswap v4 hook on Robinhood Chain mainnet that charges swaps more while the market is closed | Protects liquidity providers in a pool, not holders; complementary rather than competing |

What we'd point a judge to: the only one of these with settlements already paid on-chain (both Solana vaults' first series, on 28 Sep) and a live hedge; protection for every night, not only weekends; a price taken from the stock's own openings and backtested out of sample; settlement on the exact opening print (Chainlink's round in force at 09:30 ET measured at a median 19.5 bps from Pyth's open, where the first round after it is ~61 bps off); two chains and 34 stocks; a pool with risk limits; and a hedge on Hyperliquid. That others arrived at the same problem this month is evidence the problem is real. We haven't found an on-chain options venue that sells puts on tokenized stocks.

## Why we win

Anyone can write a put spread. What's hard to copy is everything around it:

- **A record that compounds.** Every trading day adds a settled opening, on-chain, with what it took in and what it paid. A newcomer starts at zero; our record starts on 28 September and grows every day.
- **Priced from how each stock actually opens.** The model uses each stock's own history of openings, and the backtest replays every night using only the nights before it. Competitors price from a volatility guess or a fixed table.
- **A hedged book.** The pool's exposure is shorted on Hyperliquid through the night, so it can sell more cover on the same capital. It already hedges protection sold on another chain, within two minutes.
- **Recurring by design.** "Protect every night" is a standing order a keeper renews within the holder's limits: a subscription, where competitors sell one-off notes.
- **Everywhere a holder is.** The app, a Blink, an MCP server for agents, a typed SDK and an OpenAPI description, and a gap report that prices a protocol's whole book. Kamino's $29.1M of tokenized-stock collateral is priced live at /kamino, and any borrower's loan can be checked there: the opening that liquidates it, and protection down to it.
- **Two oracles, two chains, 34 stocks.** Pyth on Solana, Chainlink on Robinhood Chain, with settlement on the exact opening print measured against both.

## Risks

| Risk | What we do about it |
|---|---|
| The model underprices a bad night | A 15% margin; the reference price is the lower of the last close and the live price, so a drop after the close can't buy cheap protection; sales pause if the price has moved more than 5% since the close; per-night and per-stock risk limits; the hedge |
| A bad or missing oracle price | Settlement takes only the first print at or after the open (Pyth) or the round in force at it (Chainlink), within set windows; a price more than 10 times away from the strikes voids the series; a series with no valid price refunds every premium |
| Smart-contract bugs | Invariant tests on both vaults, randomized sequence tests on Solana, Slither in CI. **No audit yet**: one comes before real money |
| Too few underwriters | The house seeds the pool; the hedge makes its returns steadier |
| Regulation | A cash-settled put spread that pays whether or not you hold the stock is a derivative in most places. Legal advice comes before any mainnet money; until then no real collateral; at launch, the app and quote service exclude US persons and sanctioned jurisdictions, and the choice of entity and jurisdiction follows the advice |
| Trust in the quote service | It signs prices but never holds money; the vault settles only on the oracle's price, and anyone can settle and pay out |

## Team

**Samuel Aleonomoh** ([Osiyomeoh](https://github.com/Osiyomeoh)), founder and builder: the vaults, the quote service, the hedger and the app. Built solo, from the first commit to the vaults on three chains.

**How fast we ship.** The work since 26 September is new for this hackathon and is in the git history: both vaults' second versions (the pool, positions as NFTs, risk limits, keeper tips), Solana's deployed to devnet, and the hedger written and tested. Findings were published as they came, including the ones that cut against us (the backtest's gains rest mostly on one night) and a fault in the feeds we settle on (Chainlink's first Robinhood Chain rounds were 10^8 too large; that vault voids and refunds rather than settle on such a price).

## Milestones

| When | What |
|---|---|
| 28 Sep (done) | Both Solana vaults' first series settled on Pyth's $368.09 opening print and paid out; the hedger's first session on Hyperliquid testnet, bought back at the bell; the app hosted; the Robinhood Chain vault deployed on mainnet |
| 30 Sep (done) | The first Robinhood Chain series settled, on Chainlink's round in force at the 29 Sep open ($359.345), a day late because its keeper runs by hand |
| 2 Oct | Tesla's third-quarter deliveries: the first night aimed at outside users |
| 5 to 7 Oct | "Protect every night": a standing order a keeper renews each night, within the holder's price cap |
| By 11 Oct | Every opening settled on schedule; the first Robinhood Chain purchase settled; first outside users |
| After the hackathon | An audit, then mainnet with the capped USDC pool and the protocol fee; conversations with a wallet and a lending protocol |

## The ask

We're applying to Colosseum's accelerator (its standard $250,000 pre-seed) to pay for, in order: an audit of both vaults, legal advice on the product and where to offer it, and seed capital for the first mainnet pool, capped as above. Raising more waits for a mainnet track record worth pricing.
