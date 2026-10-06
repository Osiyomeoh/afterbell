# Afterbell: submission

Colosseum's Crypto World's Fair, 2026. Every claim below links to the transaction or page that shows it. A tour by the judging criteria, with the test behind each claim: [docs/JUDGES.md](JUDGES.md).

## In one line

Protection for tokenized stocks until the next 09:30 ET open, settled on-chain by the oracle's opening price, on the chain where you hold them, and hedged on Hyperliquid.

## The problem

Tokenized stocks trade around the clock; the stock doesn't. Whatever happens while the exchange is shut (earnings, deliveries, a jobs report) lands on the token all at once at the next opening print. On 46 TSLA openings this summer, TSLA opened at least 1% below its close 11 times, and 8.8% below once. A holder has nothing to buy against that from the wallet that holds the token, and a lender against tokenized stocks carries the same gap: 1,609 Kamino loans ($6.58M of debt) against tokenized stocks, of which $940,000 becomes liquidatable if the stocks open 15% down together ([/kamino](https://afterbell-nine.vercel.app/kamino)).

## What we built

- **Protection until the next open**, a put spread with a fixed premium and a fixed maximum payout, priced from each stock's own history of openings. Each position is an NFT; whoever holds it is paid.
- **Two vaults, two oracles:**
  - Solana devnet, settled on Pyth's opening print.
  - Robinhood Chain **mainnet**, settled on Chainlink's round in force at the open, for 34 US stocks and funds.
  - Both are underwritten by a pool anyone can join, with risk limits per night and per stock.
- **A hedge on Hyperliquid:** a short in `xyz:TSLA`, sized to what the open protection on both chains stands to pay, traded through the night and bought back at the bell.
- **Protect every night:** a standing order a keeper renews within the holder's price cap, on Robinhood Chain mainnet.
- **Loan-aware protection:**
  - any Kamino borrower's loan: the opening that makes it liquidatable, how often its stocks have opened that far down, and the pricing model's chance of that tonight;
  - auto-cover: protection sized so its payout covers what a liquidating opening leaves over the limit, renewed each night by a sizer the borrower names, within bounds the program enforces;
  - claim-and-repay: the payout repays Kamino in the same transaction. Replayed on TSLA's worst recorded opening against Kamino's xStocks market cloned from mainnet: a loan $266.43 over its limit, cover paid $270.46, and Kamino took it as repayment ([Proof on /kamino](https://afterbell-nine.vercel.app/kamino#proof));
  - a liquidation map of every Kamino loan against tokenized stocks.
- **Private protection:** the premium and the payout as confidential transfers on Helius's Solana Rings, through a desk that buys in its own name.
- **For agents and integrators:** an MCP server (8 tools, hosted with no keys), a Blink, a typed SDK and an OpenAPI description.

## Verify it

[afterbell-nine.vercel.app/verify](https://afterbell-nine.vercel.app/verify) reads the chains as it loads and links each claim to its transaction. In particular:

- **First settlements:** both Solana vaults on 28 Sep, on Pyth's opening print ($368.09). Robinhood Chain on Chainlink's round in force at the 29 Sep open, $359.345 ([tx](https://robinhoodchain.blockscout.com/tx/0x637a6c9b56ee72a5c6b17b36fb95d89efa5091077b855515d020bc5349cb5c2b)).
- **First automatic renewal on mainnet**, 30 Sep: position #2 bought for its holder at $11.52 within their standing order ([tx](https://robinhoodchain.blockscout.com/tx/0xa0b873406c323a81d3a903cbb643daa19049074c1b88fc7cd1c045e6258c59ae)).
- **Hedge:** 16 trades through the first night, bought back at 13:30:03 UTC, +$5.21 closed; 158 trades by 6 Oct, all on Hyperliquid testnet against our own quoting account.
- **Private premium** with no token or amount on-chain ([tx](https://explorer.solana.com/tx/Kku9m8HqTTi222PeVnK1GNK8tBZBYJhbrkdZVibZeSJ4t6T6vnxepcHGTi9UmUrczPDewo5UyFu7WwByaTkqNe5?cluster=devnet)).

## Engineering

- **Tests:**
  - 361 TypeScript tests; 86 Foundry tests, 4 of them fuzz and 7 invariants, over random sequences of every action on the vault and on standing orders;
  - 5 fork tests of settlement against Chainlink's live feed;
  - 82 Rust tests: 23 unit and 59 on the compiled Solana program in LiteSVM, including randomized sequences and a program buying by CPI.
- **Coverage:** the EVM contracts 98% of lines.
- **Security checks:** Slither in CI with every finding fixed or explained; gitleaks over the whole history.
- **No audit yet.** One comes before any real money.
- **Findings published as they came,** including the ones against us:
  - the backtest's gains rest mostly on one night;
  - Chainlink's first Robinhood Chain rounds were 10^8 too large, so that vault voids and refunds rather than settle on them.

## Business

A 10% protocol fee on premiums once real money is allowed (arithmetic: $10M protected on an average night is about $900,000 a year), house underwriting, and protection for whole books sold to wallets, issuers and lending protocols through the SDK. Legal advice and an audit come before mainnet money; no US persons at launch. Full plan: [docs/business.md](business.md).

## Team

Samuel Aleonomoh ([Osiyomeoh](https://github.com/Osiyomeoh)): founder and builder, solo, from the first commit to vaults on two chains and a hedge on a third.

## Links

- App: [afterbell-nine.vercel.app](https://afterbell-nine.vercel.app)
- Verify: [/verify](https://afterbell-nine.vercel.app/verify) · Friday's open: [/event](https://afterbell-nine.vercel.app/event) · Kamino: [/kamino](https://afterbell-nine.vercel.app/kamino) · Private: [/private](https://afterbell-nine.vercel.app/private)
- MCP: `https://afterbell-nine.vercel.app/mcp` · API: `/api/openapi.json`
- Design: [docs/design.md](design.md) · Integrate: [docs/integrate.md](integrate.md)
- Video: [to add]
