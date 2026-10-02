# Business outline

An outline to write from in your own words: headings, the points each should make, and the evidence in this repo to draw on. Not text for the submission.

## The customer
- Who holds tokenized stocks overnight and over weekends (xStocks on Solana, Robinhood Chain stock tokens), and who borrows against them (Kamino).
- Which of them feels the gap most: leveraged borrowers near liquidation? Holders through earnings?
- Open question: how many holders, and how much is held, per venue today? (cite live sources)

## The problem
- The token trades 24/7, the stock doesn't; the open reprices it at once, with no put to buy.
- Evidence: `research/` (the gap history and backtest), the Kamino page's liquidation distances.

## The product
- Nightly cover: fixed premium, fixed maximum, settled on the oracle's first print after the open.
- Standing orders, both chains, the hedged pool, agent and MCP access.

## Why now, and why on-chain
- Tokenized stock growth; why a TradFi broker can't sell this on a 24/7 token.

## Alternatives and competitors
- Perps (Hyperliquid) as a hedge: funding, liquidation, margin vs. a capped premium.
- Options venues on-chain; anything selling single-stock cover. Check each one's current status.

## How it makes money
- A spread on each premium vs. the fair price; a fee on underwriters' returns? Which, and why.
- Underwriters' return: premiums net of payouts, from the backtest.

## Risks
- Pricing error on a big gap; oracle and quote-signer trust (see the README's threat model); regulation of selling cover on securities, by jurisdiction.

## Traction and next steps
- What's live (devnet, Robinhood Chain), positions bought and paid, users spoken to.
- The next uncertainty to test, and how: e.g. will Kamino borrowers pay $X a night?
