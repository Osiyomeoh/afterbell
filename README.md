# Afterbell

**Protection for tokenized stocks until the next open, on the chain where you hold them, hedged on Hyperliquid.**

Tokenized stocks trade 24/7; the stock doesn't. Whatever happens while the exchange is shut lands all at once on the next opening print, and a token holder has no put to buy. Afterbell sells that put: a fixed premium, a fixed maximum payout, settled on the first oracle price at or after the 09:30 ET open.

Built for Colosseum's Crypto World's Fair (September to October 2026). Design: [docs/design.md](docs/design.md).

## Status

| | |
|---|---|
| **Built** | `research/`: the evidence the design rests on (below). `pricing/`: put-spread pricing from the history of openings (exact under the model), an out-of-sample backtest, and signed quotes for both vaults (EIP-712 and ed25519). `evm/`: the Robinhood Chain vault (buy against a signed quote, settle on Chainlink's round in force at the open, claim, void). `solana/`: the Solana vault (the same against an ed25519-signed quote, settled on the first Pyth print at or after the open). `quoter/`: the quote service's core, which prices protection until the next open and signs it for either vault. `app/`: the web app. Protect prices live in the browser with the quoter's own code; My protection lists a wallet's positions and claims them; Vault shows collateral, locked payouts and every series. It has market, quote, vault and positions endpoints, and a devnet purchase has gone through with a quote the endpoint signed. A TypeScript client, setup script, purchase smoke test and keeper (settle on Pyth's first print after the open, void, claim) for the Solana vault; a full cycle (sell, open, settle, claim) passes on a local validator. **The Solana vault is live on devnet** (addresses below), and a purchase priced and signed by the quote service has gone through. 62 TypeScript tests, 35 Foundry tests (2 fuzz), 4 fork tests against Chainlink's live TSLA feed, 16 Rust unit tests and 24 LiteSVM tests of the compiled program |
| **Next** | Run the keeper on devnet after Monday 28 September's open to settle and claim the first series; hosting the app; deploy the EVM vault to Robinhood Chain mainnet with test collateral (waiting on the deploy wallet) |
| **Planned** | Hyperliquid hedger, app, MCP tool. Dates and cut line in the design doc |

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

## Solana vault

[`solana/programs/afterbell-vault`](solana/programs/afterbell-vault) is the same vault in Anchor. A Solana program can't afford to verify an ed25519 signature itself, so the buyer's transaction carries a call to Solana's native Ed25519 program right before `buy`: the runtime rejects the whole transaction if the signature is bad, and `buy` reads that instruction (through the instructions sysvar) to check it verified this exact quote with the vault's quoter key, with the key, signature and message all inside it. Each position's address derives from the quote's nonce, so a quote buys once. Settlement is permissionless and takes the first Pyth price at or after the open: a fully Wormhole-verified `PriceUpdateV2` with `prev_publish_time < open <= publish_time <= open + window` and a confidence check. A series nobody can settle voids after a delay and refunds every premium.

```bash
cd solana
anchor build --arch v0              # SBPF v0, which every cluster and LiteSVM run
cargo test -p afterbell-vault       # unit tests, then LiteSVM tests of the compiled program
```

After deploying, [`solana/scripts/setup.ts`](solana/scripts/setup.ts) creates a TestUSD mint with no value, initializes the vault, allows the TSLA feed and deposits 100,000 TestUSD, then records the addresses in `solana/deployments/`. It skips any step already done, so it's safe to re-run:

```bash
cd solana && solana program deploy target/deploy/afterbell_vault.so --program-id target/deploy/afterbell_vault-keypair.json --url devnet
cd .. && QUOTER=<quoter pubkey> npm run solana:setup
QUOTER_KEYPAIR=<quoter keypair file> npm run solana:smoke   # buy protection end to end
PYTH_API_KEY=<key> npm run solana:keeper                     # settle due series, void stale ones, claim
```

The keeper ([`solana/keeper`](solana/keeper)) is permissionless. For each series past its open, it fetches the first print at or after the open from Pyth's Hermes. It checks that print with the same rule the program applies, posts it through Pyth's receiver and settles. It voids series nobody could settle within the void delay. Then it claims every finished position into the buyer's own token account, creating that account if the buyer closed it. `npm run solana:cycle` runs a whole cycle on a local validator and checks every payout against the program's math. A local validator has no Pyth receiver, so that run settles on a preloaded price account; posting from Hermes runs on devnet.


**On devnet** (recorded in [`solana/deployments/devnet.json`](solana/deployments/devnet.json)):

| | |
|---|---|
| Program | [`6J5BHSf1yWup7SXae5xS2nzNUbtz7Bq3VpfJTtxr7Dsc`](https://explorer.solana.com/address/6J5BHSf1yWup7SXae5xS2nzNUbtz7Bq3VpfJTtxr7Dsc?cluster=devnet) |
| Vault | [`89oR2SqBFhrZ3sAUN9j6YrS95FpJvxJVAER87DN4dbeW`](https://explorer.solana.com/address/89oR2SqBFhrZ3sAUN9j6YrS95FpJvxJVAER87DN4dbeW?cluster=devnet), 100,000 TestUSD of collateral |
| TestUSD (no value) | [`FDsn8wf4XTYf26vfLp1TNVnaJn2NGFV8tfzten1YajVi`](https://explorer.solana.com/address/FDsn8wf4XTYf26vfLp1TNVnaJn2NGFV8tfzten1YajVi?cluster=devnet) |
| Quoter | `Ajy9Hwcc7FcTfoU9fJbHU4DRTzJDuubdQ3EDRAmMQ9hW` |
| First purchase | [`4azwQAH3…`](https://explorer.solana.com/tx/4azwQAH3Az4h7omEkZRtXxiHzkpFP1WPoU4Pp1Um53ARvwiLopZWzYRgunkB5bU4CGztpXDyVvnVGi8YLBsjojvC?cluster=devnet): 1 TSLA share, protected from $370.32 down to $340.09 until Monday 28 September's open, for 0.87 TestUSD |

The LiteSVM tests run the real Ed25519 program and settle on Pyth price accounts owned by the receiver program, plus forged ones that must be rejected. The TypeScript signer ([`pricing/solanaQuote.ts`](pricing/solanaQuote.ts)) and client ([`solana/client/vault.ts`](solana/client/vault.ts)) are checked against the program with shared vectors: the same quote message, Ed25519 instruction and account addresses. CI runs the unit tests; the LiteSVM tests need the compiled program, so they run locally.

## App

[`app/`](app) is a Next.js app, an npm workspace that imports the quoter and the Solana client from the repo root.

- **Protect** prices protection live in the browser, with the same quoter code the server signs with, as you set shares and where protection starts and stops. It draws the payoff and replays the same protection on every past TSLA opening. Buying takes a signed quote from `POST /api/quote`, then the wallet signs the Ed25519 check and `buy` in one transaction.
- **`GET /api/market`** returns the close, the live price, holidays and the openings history the quoter prices from. It uses Pyth when a key is configured, otherwise Hyperliquid's prices, labelled as such. Hyperliquid's price at the close is a median 2.7 bps from Pyth's.
- **`POST /api/quote`** re-prices on the server, never trusting the browser's numbers. It signs with the quoter key from the environment and refuses if that key isn't the vault's quoter.
- **Test money:** `POST /api/faucet` tops a devnet wallet up to 1,000 TestUSD when it holds less than 100, and sends 0.02 SOL when it has less than 0.01, so a fresh wallet can buy. The faucet key is TestUSD's mint authority and pays for all of it.
- **Solana Action (Blink):** `/api/actions/protect`, found through `/actions.json`, sells protection from 2% to 10% below the price from any wallet or Blink client. "Protect what I hold" reads the wallet's TSLAx and TSLAon on mainnet. A fresh devnet wallet gets test money before the transaction is returned, so one click works from nothing. It has done that on devnet: a new wallet received TestUSD, signed the returned transaction, and bought protection on 3 TSLA ([`2Qq9kXbP…`](https://explorer.solana.com/tx/2Qq9kXbPBH6yacArZRaveT1tNRWnMUhM2y9b3NcQNw8zsbDPb3nj1wzUKqhLhEKS2f3iKt5Z5uKBnsCJbucWdJs4?cluster=devnet)).
- **My protection** and **Vault** read the chain through `GET /api/positions` and `GET /api/vault`, which share one cached read, so visitors don't each hit the RPC. A buyer can claim a settled or voided position themselves; the keeper claims for everyone anyway.

```bash
cp app/.env.example app/.env.local   # then fill in PYTH_API_KEY and the quoter key (file path or contents)
npm run dev --workspace app
QUOTE_URL=http://localhost:3000/api/quote npm run solana:smoke   # buy through the endpoint, as the browser does
```

## Quote service

[`quoter/quoter.ts`](quoter/quoter.ts) turns a request (shares, where protection starts and stops) into a signed quote:

- **Which open.** It finds the next 09:30 ET open from New York's calendar, skipping weekends and the holidays in Pyth's market-hours schedule.
- **Price.** It prices the put spread from the stock's history of openings. During the session it adds the risk of the hours still to trade. The premium is the model's fair value plus a margin (15% by default).
- **Reference price.** In the session, the live price. Outside it, the lower of the last close and Hyperliquid's live `xyz:TSLA`. On weekends the close predicts the open better on average, but on weeknights Hyperliquid's price does better about two-thirds of the time (research above). Taking the lower of the two means a drop since the close is priced in, so nobody can buy protection cheap after one. If the price has moved more than 5% since the close (earnings after the bell, say), sales pause: past openings can't price a move that has already happened.
- **Signature.** It signs for the buyer's vault: EIP-712 for Robinhood Chain, ed25519 for Solana (with the Ed25519 instruction ready to send).
- **Expiry.** Quotes live 60 seconds and always expire at least two minutes before their open.

It's pure: the caller passes the time, market data and keys, so the tests pin every case. The HTTP endpoint comes with the app.

## How we got here

Afterbell started on 24 September 2026 as [Weekend Markets](https://github.com/Osiyomeoh/weekend-markets), a TSLA-only gap-cover prototype on Solana devnet that we entered in the Solana Foundation's Stocklana hackathon. Its settlement rule and pricing model carry over; the vault, the EVM contracts, the Hyperliquid hedge and the multi-chain app are new work for the World's Fair. `research/data/pyth-tsla-gaps.json` is Weekend Markets' record of Pyth's TSLA closes and opens.

## License

MIT
