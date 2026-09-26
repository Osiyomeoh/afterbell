# Afterbell

**Protection for tokenized stocks until the next open, on the chain where you hold them, hedged on Hyperliquid.**

Tokenized stocks trade 24/7; the stock doesn't. Whatever happens while the exchange is shut lands all at once on the next opening print, and a token holder has no put to buy. Afterbell sells that put: a fixed premium, a fixed maximum payout, settled on the first oracle price at or after the 09:30 ET open.

Built for Colosseum's Crypto World's Fair (September to October 2026). Design: [docs/design.md](docs/design.md).

## Status

| | |
|---|---|
| **Built** | `research/`: the evidence the design rests on (below), with tests |
| **Planned** | Pricing engine, EVM vault on Robinhood Chain, Solana vault, Hyperliquid hedger, app, MCP tool. Dates and cut line in the design doc |

This table changes as parts ship. Nothing is listed as built until it runs and is tested.

## Evidence so far

Reproducible from the repo (Hyperliquid candles are cached in `research/data`, since Hyperliquid keeps only its latest ~5,000 candles per interval):

- **Hyperliquid tracks the prices we settle on.** Its `xyz:TSLA` price is a median 2.7 bps from Pyth's 16:00 ET close and 4.1 bps from Pyth's 09:30 ET open, over 46 sessions. A hedge opened at the close and closed at the open follows the settlement price.
- **Hyperliquid's weekend price does not predict Monday's open.** Across six markets (TSLA, NVDA, AAPL, COIN, MSTR, XYZ100) and 84 weekends, its Saturday and Sunday prices were further from Monday's open than Friday's close was. It starts to help from Monday pre-market. So Afterbell prices protection from the history of openings, not from the weekend tape.

Full tables: [research/results/tsla-weekend-proof.md](research/results/tsla-weekend-proof.md) (Pyth opens) and [research/results/multi-weekend-proof.md](research/results/multi-weekend-proof.md) (six markets).

```bash
npm install
npm test                          # unit tests
npm run proof                     # Hyperliquid vs Pyth on every TSLA opening
npx tsx research/proof-multi.ts   # six markets, Hyperliquid prices only
```

## How we got here

Afterbell started on 24 September 2026 as [Weekend Markets](https://github.com/Osiyomeoh/weekend-markets), a TSLA-only gap-cover prototype on Solana devnet that we entered in the Solana Foundation's Stocklana hackathon. Its settlement rule and pricing model carry over; the vault, the EVM contracts, the Hyperliquid hedge and the multi-chain app are new work for the World's Fair. `research/data/pyth-tsla-gaps.json` is Weekend Markets' record of Pyth's TSLA closes and opens.

## License

MIT
