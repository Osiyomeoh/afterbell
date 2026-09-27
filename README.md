# Afterbell

**Protection for tokenized stocks until the next open, on the chain where you hold them, hedged on Hyperliquid.**

Tokenized stocks trade 24/7; the stock doesn't. Whatever happens while the exchange is shut lands all at once on the next opening print, and a token holder has no put to buy. Afterbell sells that put: a fixed premium, a fixed maximum payout, settled on the first oracle price at or after the 09:30 ET open.

Built for Colosseum's Crypto World's Fair (September to October 2026). Design: [docs/design.md](docs/design.md).

## Status

**Built and tested**

- `research/`: the evidence the design rests on (below).
- `pricing/`: put-spread pricing from the history of openings (exact under the model), an out-of-sample backtest, and signed quotes for both vaults (EIP-712 and ed25519).
- `quoter/`: the quote service's core. It prices protection until the next open from New York's calendar and Pyth's holidays, and signs it for either vault. Stocks are data (`quoter/stocks.ts`), and each is priced from its own openings, read the way its vault settles. Solana settles on Pyth, and the Pyth key reads TSLA and QQQ (the Nasdaq-100), so those two use Pyth's openings; QQQ goes on sale on devnet once its feed is allowed on the vault. Robinhood Chain settles on Chainlink, which publishes 34 US stocks and funds there, so each of the 34 is priced from Chainlink's own rounds: the round in force at 16:00 ET and at 09:30 ET: 67 openings since 23 June for most (DELL's feed started on 20 July, USAR's on 2 July), with the volatility measured from the same closes. Outside the session the live price is Hyperliquid's perp (31 have one; for SPY, QQQ, SLV and USO it's the index perp through the ratio of the two at the close) or, for CLSK, IONQ and RGTI, Chainlink's latest round.
- `solana/`: the Solana vault, its TypeScript client, setup script and keeper. It sells against an ed25519-signed quote and settles on the first Pyth print at or after the open, and, like the EVM vault, it is underwritten by a pool anyone can join, each position is an NFT (Token-2022) paid to whoever holds it, and it has the same risk limits and keeper tips. That version is tested on the compiled program and runs on a local validator, where a full round passes (sell, move and burn NFTs, open, settle, pay the holders, roll, fill a deposit) and the app and agent run end to end. **It's deployed on devnet**, to a new program, and its pool is underwritten with 100,000 TestUSD; nothing has been bought from it there yet. The first version (no pool; positions as accounts), which sold through the app's endpoint, the Blink and an MCP agent, still runs on devnet until its Monday positions are paid out; the app switches after that.
- `evm/`: the Robinhood Chain vault, its viem client and keeper. It sells the same protection, settled on Chainlink's round in force at the open, and it is underwritten by a pool anyone can join: deposits and withdrawals are requested and filled at the pool's exact value once each opening is paid out (ERC-7540). Each position is an NFT paid to whoever holds it. Risk limits cap each night and each stock, keepers earn a tip for paying positions out, and a permit makes buying one transaction. Settlement is tested against Chainlink's live TSLA feed in forge fork tests; the rest runs on a local chain, where a full round passes (sell, move an NFT, open, settle, pay the holder, roll, fill a deposit). The deploy script allows all 34 Chainlink feeds. Not deployed yet.
- `app/`: the web app, for both chains. Protect prices any of the 34 stocks live with the quoter's own code, My protection lists and claims positions, Vault shows collateral and every series, and Track record shows what each series took in, settled on and paid out. It also has a devnet faucet and the Blink. On both chains a position is an NFT and anyone can underwrite the pool; on Robinhood Chain (any injected EVM wallet) buying is one transaction. Buying, settling, paying out, depositing and withdrawing have run end to end against a local chain, and on Solana against a local validator. It goes live on each chain when that vault is deployed.
- `agent/`: Afterbell as an MCP server, hosted (no keys) and local (the agent's own devnet wallet with a spending cap).
- Tests: 256 TypeScript (including a check of every stock's Chainlink history, that TSLA's agrees with Pyth's, and the hedger's signatures against Hyperliquid's own SDK), 74 Foundry (3 fuzz and 4 invariants), 5 fork tests of settlement against Chainlink's live TSLA feed, 23 Rust unit and 42 LiteSVM tests of the compiled Solana program (including randomized sequences). CI also runs Slither on the EVM contracts.

**Next:** run the keeper on devnet after Monday 28 September's open to settle and claim the first series, then switch the app to the new Solana vault. Deploy the EVM vault to Robinhood Chain mainnet; the app's Robinhood flow is ready for it. Host the app.

**Written, not trading yet:** the Hyperliquid hedger ([below](#hedge-on-hyperliquid)). It sizes a short in Hyperliquid's `xyz:TSLA` to what the protection the vaults have sold (both Solana vaults, and Robinhood Chain's once it's deployed) stands to pay per $1 fall, from the model that prices it, rebalances overnight and buys it back at the open. Its plan mode reads the live vaults and Hyperliquid and prints the order it would send, and the Vault page shows the same. Sending is written and tested against Hyperliquid's documented answers but hasn't traded: it runs on Hyperliquid testnet once its accounts exist.

**Planned:** dates and the cut line are in the design doc.

This section changes as parts ship. Nothing is listed as built until it runs and is tested.

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
PYTH_API_KEY=<key> npx tsx research/refresh-openings.ts [QQQ]   # append a stock's latest openings from Pyth (--from YYYY-MM-DD builds a new one)
npx tsx research/robinhood-stocks.ts          # the stocks Chainlink publishes on Robinhood Chain, with their Pyth schedule and Hyperliquid perp
npx tsx research/chainlink-openings.ts [NVDA ...]   # each one's openings from Chainlink's rounds (no key; slow the first time, the public RPC is rate-limited)
```

Chainlink's Robinhood Chain feeds published their first day and a half (22 June 00:00 to 23 June 13:48 UTC) with 16 decimals while reporting 8, so AAPL's first round reads $29.6 billion. The histories leave those rounds out, and the EVM vault refuses to settle on a price more than 10 times from the strikes a series sold, so a round like that voids the series and refunds every premium instead of settling it at nothing. A fork test replays TSLA's round in force at the 23 June open ($392.72 read as $39.3 billion) and checks exactly that.

The app extends the recorded openings with any since, from each stock's settlement source, every hour, so it never prices from a stale history.

## EVM vault (Robinhood Chain)

[`evm/src/AfterbellVault.sol`](evm/src/AfterbellVault.sol) sells protection against a quote the quoter signs (EIP-712) and locks the maximum payout. Each position is an NFT ([`AfterbellPositions`](evm/src/AfterbellPositions.sol)) minted to the buyer, and its payout goes to whoever holds it when it's paid, so a position can be sold, lent against or held by another contract. The NFT's image is drawn on-chain ([`PositionArt`](evm/src/PositionArt.sol)) from the vault's record: the stock, strikes and cost while the position is open, then where the stock opened and what it paid.

A series settles on the Chainlink round in force at the open: the settler passes a round id and the contract checks that the next round in the same phase came after the open, or that there is none. A series nobody can settle within a day voids and refunds every premium. A price more than 10 times from the strikes the series sold (above ten times its highest upper strike, or below a tenth of its lowest lower one) is refused as a broken feed, so that series voids too; a real opening doesn't come near either bound. Anyone can then pay the positions out with `process`, in batches, and is paid the keeper's tip on each: 2% of its premium, or nothing on a voided position, which gets its whole premium back. `claim` pays out a single position the same way, so a holder need not wait for the keeper.

- **The pool.** Anyone can underwrite the vault, and the pool's shares are the vault's own ERC-20. It follows ERC-7540: deposits and withdrawals are requests, filled at the next roll and then claimed. A round covers one opening; the first sale after a roll fixes which (the quoter's signature vouches that it's a real one). The pool rolls once that opening has passed and every position the round sold is paid out, or at any time if it sold nothing. At that moment nothing is at risk, so the price of a share is exact: nobody can join just before a quiet night or leave just ahead of a loss, and a deposit never dilutes the underwriters already in. The owner can't withdraw the pool; an owner who deposited leaves the way any underwriter does.
- **Risk limits.** A round may lock at most half the pool's value at its roll, and at most a fifth of it on any one stock. The owner can change the limits and timings, but a change waits for the next roll, so a round runs to the end on the rules it started with. `capacity(feed)` says how much more a stock can sell tonight.
- **One transaction.** TestUSD takes EIP-2612 permits, so `buyWithPermit` takes a signature for the premium instead of an approval beforehand, and `requestDepositWithPermit` does the same for a deposit.

Collateral is [`TestUSD`](evm/src/TestUSD.sol), a token with no value, so the vault can run on mainnet against the real feed without real money. The vault is 20,967 bytes, built with Solidity's IR pipeline (the limit is 24,576).

```bash
cd evm
forge test                          # unit, fuzz and invariant tests, offline
FOUNDRY_PROFILE=fork forge test     # settlement against Chainlink's live TSLA feed on Robinhood Chain
```

The invariant tests drive the vault through random sequences of purchases, NFT transfers, settlements and voids, payouts and claims, deposit and withdrawal requests and their claims, and rolls, and after each sequence check that the vault holds everything it owes, that every unpaid position's maximum and tip is still locked, that no position was paid more than its maximum (or other than its premium when voided), that underwriters' claims are backed, and that no round locks more than its limit. The fork tests settle Friday 25 September's open on the real round in force and refuse the round after it, the round before it, a round that doesn't exist and the launch-day price on the wrong scale. CI runs Slither and fails on any finding of low severity or above that isn't explained in the source. Run locally on this code, it reports none: two findings were fixed, and the rest carry a comment saying why each is safe. The TypeScript signer ([`pricing/quote.ts`](pricing/quote.ts)) and the contract are checked against the same EIP-712 digest vector.

[`evm/client/vault.ts`](evm/client/vault.ts) buys with viem: it signs a permit for the premium and calls `buyWithPermit` in one transaction, returning the NFT's id. It also requests deposits (with a permit) and withdrawals and claims filled requests. It uses ABIs generated from forge's build (`npm run evm:abi`). The quote endpoint signs Robinhood Chain quotes once `evm/deployments/robinhood.json` exists, and refuses to sign a sale the vault would reject (the last opening not rolled yet, or more than the pool can cover on that stock). The first version of the vault, without the pool, was bought from on a local fork of Robinhood Chain mainnet against the live feed, with a quote signed locally and with one the app's endpoint signed. This version has been bought from through the endpoint on a local chain only; its only test against the live feed is the fork tests above.

The app buys, underwrites and claims on Robinhood Chain from any injected EVM wallet (MetaMask, Rabby…), with viem and no wallet library. It switches the wallet to Robinhood Chain (adding it if needed), mints TestUSD if the wallet is short, and buys with a permit in one transaction; the position's NFT shows on the page and in My protection. The Vault page shows the pool (its value, the price of a share, the round, the room left on each stock and the keeper's tip) and lets anyone request a deposit or a withdrawal and claim it once filled. `npm run evm:local` stands in for the chain until the vault is deployed: anvil with the vault on a mock feed, recorded in `evm/deployments/local.json`. Against it, in a browser: a purchase minted the position's NFT; after the mock feed published $355 before the open, the keeper settled the series, paid the NFT's holder $15.32 and rolled the pool; a 1,000 TestUSD deposit was filled at that roll as 1,000.133041 shares, claimed, withdrawn at the next roll and paid back as $1,000.00.

The EVM keeper ([`evm/keeper`](evm/keeper)) settles each due series on Chainlink's round in force at the open. It finds that round by binary search over the feed's current phase, then checks it as the contract will, including the bound on the price. It voids series nobody could settle within the settle window, pays every finished position out to its NFT's holder with `process`, 50 at a time, collecting the tips, and rolls the pool once the round is paid out (or when the round sold nothing and requests are waiting). On the live feed it picks round 1341 ($383.8284, published 09:26:48 ET) for Friday 25 September's open, the round the fork tests settle on. With `--plan` it sends nothing and needs no key: it lists what it would settle (on which round), void, pay or leave waiting, who holds each position and what the contract's own `payoutAt` would pay them, and whether the pool could roll; it also simulates each settlement, so the contract itself confirms it would accept it.

`npm run evm:cycle` runs a whole round on a local chain, with a feed that replays that morning's rounds. An underwriter seeds the pool, two buyers get NFTs, one NFT changes hands, and a second underwriter asks to deposit 1,000 mid-round. The keeper settles at $383.8284, pays the NFT's new holder 12.3432 TestUSD (2 shares × ($390 − $383.8284)), earns 0.08 in tips (2% of 4 in premiums) and rolls the pool, which fills the deposit as 1,000.084239 shares at the pool's value after the night. The run checks every payout, that the keeper paid exactly what the plan said, that the NFT's image reads the outcome, and that the hedger reads both positions as open protection until they're paid.

```bash
anvil --fork-url https://rpc.mainnet.chain.robinhood.com                  # a local fork, then deploy with anvil's test keys
BUYER_PRIVATE_KEY=0x… QUOTE_URL=http://localhost:3000/api/quote npx tsx evm/scripts/smoke-buy.ts
npx tsx evm/scripts/check-round.ts [open]                                  # the round the keeper would settle on (read-only)
npm run evm:cycle                                                         # sell, open, settle, pay out and roll on a local chain
npm run evm:local                                                         # a local chain for the app's Robinhood flow (then EVM_DEPLOYMENT_FILE, QUOTER_EVM_KEY)
KEEPER_PRIVATE_KEY=0x… npm run evm:keeper                                 # settle, void, pay holders and roll the pool on the deployed vault
npm run evm:keeper -- --plan                                              # read-only, no key: what it would settle on and pay
```

## Solana vault

[`solana/programs/afterbell-vault`](solana/programs/afterbell-vault) is the same vault in Anchor: the same sale against a signed quote, and the same pool, NFT positions, risk limits and keeper tips as the EVM vault, with the differences Solana asks for.

A Solana program can't afford to verify an ed25519 signature itself, so the buyer's transaction carries a call to Solana's native Ed25519 program right before `buy`: the runtime rejects the whole transaction if the signature is bad, and `buy` reads that instruction (through the instructions sysvar) to check it verified this exact quote with the vault's quoter key, with the key, signature and message all inside it. Each position's address derives from the quote's nonce, so a quote buys once. Settlement is permissionless and takes the first Pyth price at or after the open: a fully Wormhole-verified `PriceUpdateV2` with `prev_publish_time < open <= publish_time <= open + window` and a confidence check. As on Robinhood Chain, a price more than 10 times from the strikes the series sold is refused. A series nobody can settle voids after a delay and refunds every premium. Anyone can then pay the positions out with `process` and earns the keeper's tip on each: 2% of its premium, or nothing on a voided position, which gets its whole premium back.

- **Positions are Token-2022 NFTs.** `buy` mints one to the buyer, with a supply of one and the mint authority removed at once, and writes its name ("Afterbell #7 TSLA") and the position's address as metadata on the mint itself. A program sees only the accounts a transaction passes it, so `process` takes three per position: the position; the token account holding its NFT, which proves who holds it (the one account holding the only token); and that holder's TestUSD account, the only place the payout can go. Token-2022 lets a holder burn an NFT. Then nobody could be paid and the round could never end, so the position's own mint, with a supply of zero, can stand in for the holder: the position closes paying nobody, and its payout stays in the pool. A Solana program can't draw an image on request, so each NFT's metadata points at the app, which draws the same card as the EVM contract from the position's accounts (a test holds the two to the same SVG, byte for byte).
- **The pool.** The same rules as on Robinhood Chain: deposits and withdrawals are requests filled at the next roll, a round covers one opening, and the pool rolls once that opening has passed and every position the round sold is paid out. The shares are a Token-2022 token the vault mints. A program can't loop over a list of series, so the vault counts the positions the round sold and hasn't paid out, and rolls when the count is zero. Each roll records the pool's value in an account of its own, and a request is filled at its round's value the next time its owner touches it. The owner can't withdraw the pool.
- **Risk limits.** At most half the pool per round and a fifth per stock, measured at the roll; changes wait for the next roll.
- **No permit needed.** A token transfer on Solana is signed inside the transaction that makes it, so buying (the Ed25519 check and `buy`) and depositing are already one transaction each.

```bash
cd solana
anchor build --arch v0              # SBPF v0, which every cluster and LiteSVM run
cargo test -p afterbell-vault       # unit tests, then LiteSVM tests of the compiled program
```

The LiteSVM tests run the real Ed25519 and Token-2022 programs and settle on Pyth price accounts owned by the receiver program, plus forged ones that must be rejected. They cover sales, settlement, payouts to whoever holds each NFT, burned NFTs, the pool's rounds and the risk limits. A randomized test runs 64 seeded sequences of 60 random steps (sales, NFT transfers and burns, settlements and voids, payouts, deposits and withdrawals and their claims, rolls) and after every step checks the four properties the EVM invariant tests check: the vault holds everything it owes; what is locked and tipped is exactly the unpaid positions', and every paid position got what its series owed it; underwriters' claims are backed; and no round or stock is over its limit. The TypeScript signer ([`pricing/solanaQuote.ts`](pricing/solanaQuote.ts)) and client ([`solana/client/vault.ts`](solana/client/vault.ts)) are checked against the program with shared vectors: the same quote message, Ed25519 instruction and account addresses. CI builds the program, with Solana's tools downloaded at a pinned version and checked against their sha256, and runs its unit and LiteSVM tests.

After deploying, [`solana/scripts/setup.ts`](solana/scripts/setup.ts) creates a TestUSD mint with no value (or takes an existing one, `MINT`), initializes the vault with its share token and the address its NFTs' art is served from (`ART_URI`), allows a feed for each stock the Pyth key reads (TSLA and QQQ) and underwrites the pool with 100,000 TestUSD (a request, a roll and a claim), then records the addresses in `solana/deployments/`. It skips any step already done, so it's safe to re-run:

```bash
cd solana && solana program deploy target/deploy/afterbell_vault.so --program-id target/deploy/afterbell_vault-keypair.json --url devnet
cd .. && QUOTER=<quoter pubkey> ART_URI=<app>/api/position-art/solana/ npm run solana:setup
QUOTER_KEYPAIR=<quoter keypair file> npm run solana:smoke   # buy protection end to end
PYTH_API_KEY=<key> npm run solana:keeper                     # settle due series, void stale ones, pay each NFT's holder, roll the pool
PYTH_API_KEY=<key> npm run solana:keeper -- --plan           # read-only: what it would settle on, pay and whether the pool could roll
npm run solana:cycle                                         # a whole round on a local validator
PORT=3000 npm run solana:local                               # a local vault left running for the app, with a round to pay out
```

The keeper ([`solana/keeper`](solana/keeper)) is permissionless. For each series past its open, it fetches the first print at or after the open from Pyth's Hermes. It checks that print as the program will (timing, the confidence limit, the bound on the price), so it never pays to post a print the program would reject, then posts it through Pyth's receiver and settles. It voids series nobody could settle within the void delay. Then it pays every finished position out to whoever holds its NFT with `process`, seven to a transaction, creating the holder's TestUSD account if they have none and forfeiting a position whose NFT was burned, collects the tips, and rolls the pool once the round is paid out (or when it sold nothing and requests are waiting). With `--plan` it sends nothing and needs no wallet: it lists each series it would settle, void or leave waiting, the print it would settle on, who holds each position and what it would be paid, and whether the pool could roll.

`npm run solana:cycle` runs a whole round on a local validator. The pool is underwritten with 100,000 TestUSD and three buyers get NFTs. Before the open one sells hers to another wallet, one burns hers and one closes his TestUSD account, and an underwriter asks to deposit 1,000. The keeper settles at $360, pays the NFT's new holder 20 TestUSD (2 shares × ($370 − $360)), forfeits the burned one to the pool, earns 0.05 in tips (2% of 2.5 in premiums) and rolls the pool, which fills the deposit as 1,000.17553 shares at the pool's value after the night. The run checks every payout against the program's math and that the keeper paid exactly what the plan said. A local validator has no Pyth receiver, so it settles on a preloaded price account; posting from Hermes has run on devnet with the first version. `npm run solana:local` leaves a vault like that running, with a settled round waiting to be paid out, and prints the environment to run the app against it.

**On devnet** (recorded in [`solana/deployments/devnet.json`](solana/deployments/devnet.json)). The program keeps an upgrade authority, the deployer's key, so a bug found on devnet can be fixed in place. Its NFTs' art address is still the local app's: each NFT keeps the address it was minted with, so it has to point at the hosted app before the first sale there.

| | |
|---|---|
| Program | [`J6n3JUafVkx4MpKTnAnZSwTcGFueRrjxgiXWMC4L7RGG`](https://explorer.solana.com/address/J6n3JUafVkx4MpKTnAnZSwTcGFueRrjxgiXWMC4L7RGG?cluster=devnet), upgradeable by `GZP4hLs8gqxPNuRtsAkzbWiZQKYch8m6hyDDuSyJXZde` |
| Vault | [`E5JGqm7LdPMTtA661B3XZiT7kbBcgm9E9BtJmasLGvoX`](https://explorer.solana.com/address/E5JGqm7LdPMTtA661B3XZiT7kbBcgm9E9BtJmasLGvoX?cluster=devnet), a pool underwritten with 100,000 TestUSD |
| Pool shares (Afterbell Pool, BELLPOOL) | [`3BXDveNKiJKnagz9geNL9Y9QBmuhyjd21QbeGbgig7Wd`](https://explorer.solana.com/address/3BXDveNKiJKnagz9geNL9Y9QBmuhyjd21QbeGbgig7Wd?cluster=devnet) |
| TestUSD (no value) | [`FDsn8wf4XTYf26vfLp1TNVnaJn2NGFV8tfzten1YajVi`](https://explorer.solana.com/address/FDsn8wf4XTYf26vfLp1TNVnaJn2NGFV8tfzten1YajVi?cluster=devnet), the same as the first version's |
| Quoter | `Ajy9Hwcc7FcTfoU9fJbHU4DRTzJDuubdQ3EDRAmMQ9hW` |

**The first version** (recorded in [`solana/deployments/devnet-v1.json`](solana/deployments/devnet-v1.json)). It sells the same protection and settles the same way, but its collateral is the authority's rather than a pool's, and a position is an account that a claim closes. The new version is a new program, so this one's positions and history stay readable.

| | |
|---|---|
| Program | [`6J5BHSf1yWup7SXae5xS2nzNUbtz7Bq3VpfJTtxr7Dsc`](https://explorer.solana.com/address/6J5BHSf1yWup7SXae5xS2nzNUbtz7Bq3VpfJTtxr7Dsc?cluster=devnet) |
| Vault | [`89oR2SqBFhrZ3sAUN9j6YrS95FpJvxJVAER87DN4dbeW`](https://explorer.solana.com/address/89oR2SqBFhrZ3sAUN9j6YrS95FpJvxJVAER87DN4dbeW?cluster=devnet), 100,000 TestUSD of collateral |
| TestUSD (no value) | [`FDsn8wf4XTYf26vfLp1TNVnaJn2NGFV8tfzten1YajVi`](https://explorer.solana.com/address/FDsn8wf4XTYf26vfLp1TNVnaJn2NGFV8tfzten1YajVi?cluster=devnet) |
| Quoter | `Ajy9Hwcc7FcTfoU9fJbHU4DRTzJDuubdQ3EDRAmMQ9hW` |
| First purchase | [`4azwQAH3…`](https://explorer.solana.com/tx/4azwQAH3Az4h7omEkZRtXxiHzkpFP1WPoU4Pp1Um53ARvwiLopZWzYRgunkB5bU4CGztpXDyVvnVGi8YLBsjojvC?cluster=devnet): 1 TSLA share, protected from $370.32 down to $340.09 until Monday 28 September's open, for 0.87 TestUSD |

## App

[`app/`](app) is a Next.js app, an npm workspace that imports the quoter and the Solana client from the repo root.

- **Protect** prices protection live in the browser, with the same quoter code the server signs with, as you set shares and where protection starts and stops. It draws the payoff and replays the same protection on every past opening of the stock. Buying takes a signed quote from `POST /api/quote`, then the wallet signs the Ed25519 check and `buy` in one transaction, and the position arrives as an NFT. A switch sells the same protection on Robinhood Chain instead (`/?chain=robinhood` opens it there), settled by Chainlink, where the position is an NFT bought in one transaction. A picker chooses the stock (`/?symbol=NVDA`); one only Robinhood Chain can settle opens on that chain.
- **`GET /api/market?symbol=`** returns the close, the live price, holidays and the openings history the quoter prices from, and every stock covered with the chains that can settle it. For TSLA and QQQ it uses Pyth when a key is configured, otherwise Hyperliquid's prices, labelled as such; for the rest, Chainlink's close and Hyperliquid's live price. Hyperliquid's price at the close is a median 2.7 bps from Pyth's.
- **`POST /api/quote`** re-prices on the server, never trusting the browser's numbers. It signs with the quoter key from the environment and refuses if that key isn't the vault's quoter. On either chain it also refuses a sale the vault would reject: before the last opening is rolled, or beyond what the pool can cover on that stock.
- **Test money:** `POST /api/faucet` tops a devnet wallet up to 1,000 TestUSD when it holds less than 100, and sends 0.02 SOL when it has less than 0.01, so a fresh wallet can buy. The faucet key is TestUSD's mint authority and pays for all of it.
- **Solana Action (Blink):** `/api/actions/protect`, found through `/actions.json`, sells protection from 2% to 10% below the price from any wallet or Blink client. "Protect what I hold" reads the wallet's TSLAx and TSLAon on mainnet. A fresh devnet wallet gets test money before the transaction is returned, so one click works from nothing. It has done that on devnet: a new wallet received TestUSD, signed the returned transaction, and bought protection on 3 TSLA ([`2Qq9kXbP…`](https://explorer.solana.com/tx/2Qq9kXbPBH6yacArZRaveT1tNRWnMUhM2y9b3NcQNw8zsbDPb3nj1wzUKqhLhEKS2f3iKt5Z5uKBnsCJbucWdJs4?cluster=devnet)).
- **Track record** (`GET /api/record`) lists every series either vault has sold: sales, premiums, the oracle price and time it settled on, and what it paid out. Both vaults keep paid positions on-chain with what they paid, so the ledger reads state, and on Solana it takes each settlement's transaction from the program's events. The first Solana version's claims closed its position accounts, so its history comes from its events (`ProtectionBought`, `SeriesSettled`, `Claimed`) in the vault's transactions, read once each and cached. Below that, the same pricing replayed on every recorded TSLA opening, each priced only from the openings before it.
- **How it works** and **For wallets and agents**, on the home page, explain the product and give the Blink and MCP addresses for whatever host the app runs on.
- **My protection** and **Vault** read each chain through `GET /api/positions` (a Solana or EVM address) and `GET /api/vault` (`?chain=robinhood` for Robinhood Chain), which share one cached read per chain, so visitors don't each hit the RPC. My protection lists the positions whose NFTs the wallet holds, with each NFT's image: on Robinhood Chain the one drawn on-chain (`GET /api/position-art/<id>`), on Solana the same card drawn from the position's accounts (`GET /api/position-art/solana/<position>` is the metadata each NFT points at, and `/image` the image). A holder can pay out a settled or voided position themselves (on Solana that's `process` for their own position, so they take the keeper's tip too); the keepers pay everyone anyway. The Vault page shows each chain's pool and lets anyone underwrite it (`GET /api/underwriter?owner=` reads an underwriter's shares and requests, for a Solana or EVM address).
- **The hedge**, on the Vault page (`GET /api/hedge`): mainnet's `xyz:TSLA` price, the short the open protection calls for, each open's positions and the short for it, and the short held. It reads the same state as the hedger's plan mode, through public endpoints only; the server holds no key. Until the hedge account exists (`HEDGE_ACCOUNT`, an address) it says the hedge isn't running.
- **Solana, on a local validator** (`npm run solana:local`): the routes and pages, the Blink and the agent ran against the new vault. A holder whose position opened at $355 paid it out to themselves with the app's claim code ($50.00, plus the $0.40 tip), after which its NFT's image read "paid $50.00"; the keeper paid the rest and rolled; the Blink and the quote endpoint then sold Monday's open; a 250 TestUSD deposit was filled at a roll and claimed, and 100 shares were withdrawn at the next roll for $99.97. The test browser has no Solana wallet, so the app's browser code for buying, claiming and underwriting was run from a script signing with a test key.

```bash
cp app/.env.example app/.env.local   # then fill in PYTH_API_KEY and the quoter key (file path or contents)
npm run dev --workspace app
QUOTE_URL=http://localhost:3000/api/quote npm run solana:smoke   # buy through the endpoint, as the browser does
```

## For agents

Afterbell is also an MCP server, so an AI agent can protect a portfolio the way a person does on the site. Both servers price and sign through the app's own routes. `market` and `quote_protection` take any of the 34 stocks (`symbol`, TSLA by default); buying goes through the Solana vault, so it works for the stocks on sale there, and sizing to a wallet's holdings reads tokenized TSLA only.

- **Hosted, `/mcp`** (Streamable HTTP, stateless, no keys). Its tools are `market`, `quote_protection`, `protect_portfolio`, `protection_transaction`, `positions` and `vault`. Buying returns an unsigned transaction for the caller's own wallet, and a fresh devnet wallet is sent test money first.
- **Local, `agent/server.ts`** (stdio). It gives the agent its own devnet wallet, created on first use outside the repo, and a spending cap per purchase (`AGENT_MAX_SPEND`). It adds `wallet`, `get_test_funds`, `buy_protection` and `claim`, and its `protect_portfolio` sizes protection to what a mainnet wallet holds and buys it. `claim` pays out the positions whose NFTs the agent holds.

```bash
claude mcp add --transport http afterbell http://localhost:3000/mcp                  # hosted
claude mcp add afterbell -e AFTERBELL_URL=http://localhost:3000 -- npx tsx agent/server.ts   # local, with its own wallet
AFTERBELL_URL=http://localhost:3000 npm run agent:smoke                                # both, through a real MCP client
```

On devnet, the smoke run went end to end on both servers with the first Solana version, and on a local validator with the new one. The local agent was refused a purchase above its cap, then bought protection on 2 TSLA. The hosted server returned a transaction that a fresh wallet signed and sent.

## Quote service

[`quoter/quoter.ts`](quoter/quoter.ts) turns a request (shares, where protection starts and stops) into a signed quote:

- **Which open.** It finds the next 09:30 ET open from New York's calendar, skipping weekends and the holidays in Pyth's market-hours schedule.
- **Price.** It prices the put spread from the stock's history of openings. During the session it adds the risk of the hours still to trade. The premium is the model's fair value plus a margin (15% by default).
- **Reference price.** In the session, the live price. Outside it, the lower of the last close and Hyperliquid's live price for the stock (`xyz:TSLA`, say). On weekends the close predicts the open better on average, but on weeknights Hyperliquid's price does better about two-thirds of the time (research above). Taking the lower of the two means a drop since the close is priced in, so nobody can buy protection cheap after one. If the price has moved more than 5% since the close (earnings after the bell, say), sales pause: past openings can't price a move that has already happened.
- **Signature.** It signs for the buyer's vault: EIP-712 for Robinhood Chain, ed25519 for Solana (with the Ed25519 instruction ready to send).
- **Expiry.** Quotes live 60 seconds and always expire at least two minutes before their open.

It's pure: the caller passes the time, market data and keys, so the tests pin every case. The HTTP endpoint comes with the app.

## Hedge on Hyperliquid

Written and tested; **it hasn't traded yet.** Plan and results: [docs/hedger.md](docs/hedger.md).

[`hedger/`](hedger) holds a short in Hyperliquid's `xyz:TSLA` perp equal to the vaults' delta: how much more the open protection pays for each $1 TSLA falls, from the same openings model the quoter prices with. Protection sold raises it, a fall toward the strikes raises it further, and at the open those positions stop counting and the short is bought back. It reads every open position in both Solana vaults, and in Robinhood Chain's once its deployment file exists; that read is checked on a local chain by `npm run evm:cycle`.

- **Where.** Hyperliquid testnet, with mock USDC, at mainnet's price; sending on mainnet is refused. Testnet's TSLA book is empty, so a second account of ours rests a bid and an ask at mainnet's mid, and the hedger's orders fill against it. That's our own liquidity, and the app says so.
- **Orders.** Immediate-or-cancel at the mid ± 0.2%, reduce-only when buying back, isolated 3× margin, only when the short is off its target by more than 0.01 TSLA or $10, and capped at $1,500 of TSLA by default. It runs every 5 minutes and 1 second after each open.
- **Signing.** Our own signer (EIP-712 over a msgpack hash of the action), checked against the signatures in Hyperliquid's Python SDK tests. The scripts take only an API wallet's key, from the shell, and refuse the account's own.
- **Backtest.** Over 36 nights, rebalancing the short hourly cut the spread of the vault's nightly results by a third to two-thirds, mostly from one night when TSLA fell through the night on Hyperliquid; for protection far below the close it added noise on quiet nights. Tables: [research/results/hedge-backtest.md](research/results/hedge-backtest.md).
- **Checked live:** both plan modes, against the devnet vaults and Hyperliquid's public endpoints. **Not yet:** anything sent, since the testnet accounts don't exist yet.

```bash
npm run hedger -- --plan          # the short the vaults call for, the short held, and the order; sends nothing, needs no key
npm run hedger:quoter -- --plan   # the testnet quotes it would rest, against the book
npm run hedger:backtest           # writes research/results/hedge-backtest.md
```

## How we got here

Afterbell started on 24 September 2026 as [Weekend Markets](https://github.com/Osiyomeoh/weekend-markets), a TSLA-only gap-cover prototype on Solana devnet that we entered in the Solana Foundation's Stocklana hackathon. Its settlement rule and pricing model carry over; the vault, the EVM contracts, the Hyperliquid hedge and the multi-chain app are new work for the World's Fair. `research/data/pyth-tsla-gaps.json` is Weekend Markets' record of Pyth's TSLA closes and opens.

## License

MIT
