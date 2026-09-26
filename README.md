# Afterbell

**Protection for tokenized stocks until the next open, on the chain where you hold them, hedged on Hyperliquid.**

Tokenized stocks trade 24/7; the stock doesn't. Whatever happens while the exchange is shut lands all at once on the next opening print, and a token holder has no put to buy. Afterbell sells that put: a fixed premium, a fixed maximum payout, settled on the first oracle price at or after the 09:30 ET open.

Built for Colosseum's Crypto World's Fair (September to October 2026). Design: [docs/design.md](docs/design.md).

## Status

| | |
|---|---|
| **Built** | `research/`: the evidence the design rests on (below). `pricing/`: put-spread pricing from the history of openings (exact under the model), an out-of-sample backtest, and EIP-712 quotes for the EVM vault. `evm/`: the Robinhood Chain vault (buy against a signed quote, settle on Chainlink's round in force at the open, claim, void). 36 TypeScript tests, 35 Foundry tests (2 fuzz), and 4 fork tests against Chainlink's live TSLA feed |
| **Next** | Deploy the vault to Robinhood Chain mainnet with test collateral (waiting on the deploy wallet) |
| **Planned** | Solana vault, Hyperliquid hedger, app, MCP tool. Dates and cut line in the design doc |

This table changes as parts ship. Nothing is listed as built until it runs and is tested.

## Evidence so far

Reproducible from the repo (Hyperliquid candles are cached in `research/data`, since Hyperliquid keeps only its latest ~5,000 candles per interval):

- **Hyperliquid tracks the prices we settle on.** Its `xyz:TSLA` price is a median 2.7 bps from Pyth's 16:00 ET close and 4.1 bps from Pyth's 09:30 ET open, over 46 sessions. A hedge opened at the close and closed at the open follows the settlement price.
- **Hyperliquid's weekend price does not predict Monday's open.** Across six markets (TSLA, NVDA, AAPL, COIN, MSTR, XYZ100) and 84 weekends, its Saturday and Sunday prices were further from Monday's open than Friday's close was. It starts to help from Monday pre-market. So Afterbell prices protection from the history of openings, not from the weekend tape.
- **Chainlink on Robinhood Chain can settle the open to about 20 bps.** Its TSLA feed's round in force at 09:30 ET is a median 19.5 bps (worst 44.5) from Pyth's opening print on 46 openings. The first round after 09:30 is ~61 bps off, because the feed only publishes on a 0.5% move, so the vault settles on the round in force.

Full tables: [research/results/tsla-weekend-proof.md](research/results/tsla-weekend-proof.md) (Pyth opens), [research/results/multi-weekend-proof.md](research/results/multi-weekend-proof.md) (six markets) and [research/results/chainlink-settlement.md](research/results/chainlink-settlement.md) (Chainlink).

```bash
npm install
npm test                          # unit tests
npm run proof                     # Hyperliquid vs Pyth on every TSLA opening
npx tsx research/proof-multi.ts   # six markets, Hyperliquid prices only
npx tsx research/chainlink.ts     # Chainlink's TSLA feed on Robinhood Chain vs Pyth's open
npx tsx pricing/report.ts         # protection backtest on every TSLA opening
```

## EVM vault (Robinhood Chain)

[`evm/src/AfterbellVault.sol`](evm/src/AfterbellVault.sol) sells protection against a quote the quoter signs (EIP-712), locks the maximum payout, and settles on the Chainlink round in force at the open: the settler passes a round id and the contract checks that the next round in the same phase came after the open, or that there is none. A series nobody can settle within a day voids and refunds every premium. Claims can be triggered by anyone and always pay the buyer. Collateral is [`TestUSD`](evm/src/TestUSD.sol), a token with no value, so the vault can run on mainnet against the real feed without real money.

```bash
cd evm
forge test                          # unit and fuzz tests, offline
FOUNDRY_PROFILE=fork forge test     # settlement against Chainlink's live TSLA feed on Robinhood Chain
```

The TypeScript signer ([`pricing/quote.ts`](pricing/quote.ts)) and the contract are checked against the same EIP-712 digest vector.

## How we got here

Afterbell started on 24 September 2026 as [Weekend Markets](https://github.com/Osiyomeoh/weekend-markets), a TSLA-only gap-cover prototype on Solana devnet that we entered in the Solana Foundation's Stocklana hackathon. Its settlement rule and pricing model carry over; the vault, the EVM contracts, the Hyperliquid hedge and the multi-chain app are new work for the World's Fair. `research/data/pyth-tsla-gaps.json` is Weekend Markets' record of Pyth's TSLA closes and opens.

## License

MIT
