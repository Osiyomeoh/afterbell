# Judge's tour

Afterbell sells protection for tokenized stocks until the next 09:30 ET open. A holder pays a fixed premium for a fixed maximum payout, and the vault settles on the oracle's opening price: Pyth's first print at or after the open on Solana, Chainlink's round in force at the open on Robinhood Chain. A borrower on Kamino can size that protection to the opening that would liquidate their loan, and repay Kamino with the payout in the same transaction.

Where it stands on 6 October: live on Solana devnet and on Robinhood Chain **mainnet** (with test collateral), hedged on Hyperliquid testnet. 9 openings settled across both chains, 15 positions sold, 1 standing order renewed with no signature from its holder, 158 hedge trades. Every buyer so far is one of our own wallets, and the collateral is test money ([what isn't done](#what-isnt-done)). The live counts are at [/verify](https://afterbell-nine.vercel.app/verify) and [`/api/verify`](https://afterbell-nine.vercel.app/api/verify).

## One command

```bash
npm ci && npm run prove
```

It builds the vault program, starts a local validator with Kamino's xStocks market as mainnet had it (the lending and farms programs and 16 accounts, read on 11 Oct and saved in [`solana/fixtures/kamino`](../solana/fixtures/kamino)), and replays TSLA's worst recorded opening: a TSLAx loan on Kamino, cover sized to it, a settle at the real opening price, and the payout repaying Kamino in the same transaction. It needs Rust and the Solana CLI, and no RPC or wallet. It ends `PASS`, with the loan over its limit by $266.43 without cover and $0 with it.

## Five minutes in a browser

Nothing below needs a wallet of your own, and all of it works at any hour: a quote always prices the next open, and close to an open it moves to the one after.

1. **[/kamino](https://afterbell-nine.vercel.app/kamino).** All of Kamino's loans against tokenized stocks, and the opening gap that liquidates each. Try auto-cover on the sample loan, then read the Proof section at the bottom: TSLA's worst recorded opening replayed against Kamino's own market, and loan-sized cover against all-or-nothing weekend cover on every recorded TSLA opening.
2. **[Protect](https://afterbell-nine.vercel.app).** Click "Use a test wallet": it gets 1,000 TestUSD and buys in one click. The position is an NFT; My protection shows it, with the transaction.
3. **[/verify](https://afterbell-nine.vercel.app/verify).** Every settlement, renewal, hedge trade and private payment, each linked to its transaction, and every payout recomputed from its terms and the oracle's price.
4. **[/backtest](https://afterbell-nine.vercel.app/backtest).** Today's pricing replayed with no look-ahead on every recorded opening of 34 stocks, 1,984 nights, losers included.
5. **From an agent:** `claude mcp add --transport http afterbell https://afterbell-nine.vercel.app/mcp`, then ask it what protecting 10 TSLA until tomorrow's open costs.

## By the judging criteria

### Functionality and code quality

| What | Where it runs | Evidence |
|---|---|---|
| Solana vault (Anchor): signed quotes, a pool anyone underwrites, positions as Token-2022 NFTs, standing orders, a sizer | Solana devnet | [program `J6n3…7RGG`](https://explorer.solana.com/address/J6n3JUafVkx4MpKTnAnZSwTcGFueRrjxgiXWMC4L7RGG?cluster=devnet), [TSLA settled on Pyth's opening print](https://explorer.solana.com/tx/2PUUr6GP3EQGB4VjTq4D5YcauBDvdXXD3DV1H3NEN65aJ6n7TQ76bC57yVfhdoBBw2zpiueykywAm5FcKg8YrUst?cluster=devnet) |
| EVM vault: the same product, an ERC-7540 pool, ERC-721 positions with on-chain art, EIP-2612 buys | Robinhood Chain mainnet, 34 Chainlink feeds allowed | [vault](https://robinhoodchain.blockscout.com/address/0xbd619a58F5D3f4573774aD67105E299a5b9d9Ab5), [TSLA settled on Chainlink's round at the open](https://robinhoodchain.blockscout.com/tx/0xd01d8da478c7942bd00802389a88c738d090558dc9f13a5b1212f3f6797a2936) |
| Standing orders ("protect every night"), renewed by a keeper | Robinhood Chain mainnet; Solana devnet | [renewal with no holder signature](https://robinhoodchain.blockscout.com/tx/0xa0b873406c323a81d3a903cbb643daa19049074c1b88fc7cd1c045e6258c59ae) |
| Kamino claim-and-repay: claim a payout and repay the loan in one transaction | Local validator, Kamino's xStocks market cloned from mainnet and saved in the repo | `npm run prove` ([`gap-replay.ts`](../solana/scripts/gap-replay.ts)), no RPC needed |
| Hedger: a short in Hyperliquid's `xyz:TSLA` sized to what both vaults stand to pay, bought back at the bell | Hyperliquid testnet | [hedger.md](hedger.md), the hedge on [/vault](https://afterbell-nine.vercel.app/vault) |
| Keepers: settle, pay out, roll, renew | Run by the team after each open; a weekday workflow is written and starts once its keeper wallets are set | [`keeper.yml`](../.github/workflows/keeper.yml) |
| Payout audit: recompute every live payout on both chains | GitHub Actions, daily | [`audit.yml`](../.github/workflows/audit.yml), `npm run audit` |

**Tests**

| Suite | Tests | Run |
|---|---:|---|
| TypeScript (pricing, quoter, SDK, hedger, keepers, app logic, agent) | 361 | `npm ci && npm test` |
| Foundry: unit, 4 fuzz, 7 invariants | 86 | `cd evm && forge test` |
| Foundry fork tests against Chainlink's live TSLA feed on Robinhood Chain | 5 | `cd evm && FOUNDRY_PROFILE=fork forge test` |
| Rust unit | 23 | `cd solana && cargo test -p afterbell-vault --lib` |
| Rust, LiteSVM on the compiled program (one randomized-sequence test) | 59 | `npm run solana:test` (builds the program and the cover-desk example, then runs both suites) |
| Playwright against the hosted app, desktop and phone | 6 × 2 | `npm run e2e` |

CI runs all but the fork tests and Playwright on every pull request, plus Slither, which fails on any finding of low severity or above not explained in the source, and gitleaks over the whole history; Playwright runs after each open. Contract coverage is 98% of lines and 83% of branches (`forge coverage --ir-minimum`).

**Claims and the tests that check them.** Each row names the test that fails if the claim is false.

| Claim | Test | Command |
|---|---|---|
| Robinhood Chain settles on Chainlink's round in force at the open, never a later or older one | `test_settle_usesTheRoundInForceAtTheOpen`, `test_settle_rejectsARoundPublishedAfterTheOpen`, `test_settle_rejectsAnOlderRoundThanTheOneInForce`; on the live feed, `test_settlesFridaysOpenOnTheRoundInForce` | `cd evm && forge test --match-test test_settle_` |
| Solana settles on Pyth's first print at or after the open, posted by Pyth | `settles_on_the_first_print_at_or_after_the_open`, `settlement_rejects_the_wrong_print`, `settlement_rejects_a_price_not_posted_by_pyth` | `cd solana && cargo test -p afterbell-vault --test vault settle` |
| A broken feed voids the night and refunds every premium instead of settling it | `test_settle_refusesAPriceOnTheWrongScale`, `test_void_refundsTheWholePremiumAfterTheWindow`; on the live feed's launch-day round, `test_refusesTheLaunchDayPriceOnTheWrongScale`; `an_unsettled_series_voids_after_the_delay_and_refunds_in_full` | `cd evm && forge test --match-test "WrongScale|test_void_"` |
| A payout never exceeds its maximum, is paid once, and goes to whoever holds the NFT | `testFuzz_payoutNeverExceedsTheMaxAndFallsAsThePriceRises`, `test_process_paysWhoeverHoldsTheNFTNow`, `test_process_skipsWhatWasClaimedAndPaysNobodyTwice`, `a_position_is_paid_once` | `cd evm && forge test --match-test "test_process_|testFuzz_payout"` |
| The vault always holds what it owes, across random sequences of every action | `invariant_holdsEverythingItOwes`, `invariant_claimsAreBacked`; `every_property_holds_after_every_step` | `cd evm && forge test --match-contract InvariantTest` |
| Nobody joins the pool before a quiet night or leaves ahead of a loss | `test_redeem_waitsForTheRollAndCantLeaveAheadOfALoss`, `a_bad_night_is_borne_by_those_in_the_pool_not_by_whoever_joins_after` | `cd evm && forge test --match-test test_redeem_` |
| A night locks at most half the pool, and a fifth on one stock | `invariant_withinTheRisklimit`, `test_buy_capsAStockAtItsShareOfThePool`, `a_round_locks_at_most_half_the_pool_and_a_fifth_on_one_stock` | `cd evm && forge test --match-test test_buy_caps` |
| Only the quoter's quote sells, once, to the buyer it names | `test_buy_rejectsATamperedQuote`, `test_buy_rejectsReusedNonce`, `test_buy_rejectsSomeoneElseUsingTheQuote`, `buy_rejects_a_quote_changed_after_signing`, `a_quote_buys_once` | `cd evm && forge test --match-test test_buy_rejects` |
| The quote service signs exactly what each contract checks | "hash to the same EIP-712 digest as the contract" and `test_quoteDigestVector`; "encode exactly the bytes the program rebuilds" | `npx vitest run pricing/quote.test.ts pricing/solanaQuote.test.ts` |
| A standing order renews once per open, within the holder's limits | `test_renewsOncePerOpening`, `invariant_withinTheOrdersLimits`, `an_order_renews_once_per_opening`, `a_renewal_stays_within_the_orders_limits` | `cd evm && forge test --match-contract Renewer` |
| A sizer the holder names re-sizes their order only within the holder's bounds | `the_sizer_resizes_the_order_within_its_bounds`, `a_resize_outside_the_bounds_fails`, `only_the_named_sizer_resizes` | `cd solana && cargo test -p afterbell-vault --test sizer` |
| Loan cover pays back exactly what the opening leaves over the liquidation limit | "pays back exactly the shortfall through the band", "covers one stock falling alone, which liquidates deeper" | `npx vitest run app/src/lib/kaminoCover.test.ts` |
| Another Solana program can buy protection by CPI and be paid | `a_program_buys_protection_and_is_paid` ([cover-desk example](../solana/examples/cover-desk)) | `cd solana && cargo test -p afterbell-vault --test composability` |
| The price is exact under the model | "matches a Monte Carlo simulation of the same mixture", "equals Black-Scholes with zero rates for a single lognormal" | `npx vitest run pricing/pricing.test.ts` |
| Every live payout on both chains matches its terms and the oracle's price | the payout audit, daily in CI | `npm run audit` |

### Potential impact

- **The market is live and it's lent against.** Kamino's three xStocks markets hold $26.7M of tokenized-stock collateral against $7.05M borrowed (read 6 October, [/kamino](https://afterbell-nine.vercel.app/kamino)).
- **The gap liquidates.** Of 1,609 Kamino loans against tokenized stocks ($6.58M of debt, mapped 30 September), 91 loans with $940,000 of debt become liquidatable if the stocks open 15% down together, and 168 with $1.47M at 20%. TSLA opened at least 1% below its close on 11 of 46 recorded openings, and 8.8% below once.
- **What cover does for a loan.** On TSLA's worst recorded opening, a loan of 30 TSLAx with $6,000 borrowed went $266.43 over its liquidation limit. Its auto-cover paid $270.46, and Kamino took it as repayment in the same transaction. Of all 46 recorded TSLA openings, that one (a Thursday) is the only one that liquidates this loan: loan-sized cover pays what it leaves short, and a flat $500 weekend cover triggered at 3% pays nothing, because it isn't a weekend ([Proof on /kamino](https://afterbell-nine.vercel.app/kamino#proof)).
- **Who it reaches.** Holders in the wallet that holds the token, borrowers through Kamino, other programs by CPI, and agents through MCP and the SDK.

### Novelty

- **Settled on the opening print.** The payout is set by where the stock opens, on the oracle each chain already trusts, not by a close-to-close move or a weekend-only trigger. The same product runs on two chains and two oracles, each one's quirks handled in its contract and tested on its live feed.
- **Cover sized to a loan.** Auto-cover reads a Kamino loan, finds the opening that liquidates it, and sizes a band of protection whose payout tracks what that opening leaves over the limit. The holder claims and repays Kamino in one transaction.
- **It renews itself.** A standing order buys cover every night within limits the holder set; a sizer the holder names can re-size it each night as the loan changes, inside bounds the program enforces.
- **A fair pool.** Underwriters join and leave only at the roll, when nothing is at risk, so the share price is exact: no one can join before a quiet night or leave ahead of a loss.
- **Hedged at the bell.** The pool's exposure is offset with a short on Hyperliquid through the night and bought back at the open.

### UX

- One click from no wallet to a position: the test wallet funds itself and buys. On Robinhood Chain a permit makes a purchase one transaction.
- Each position is an NFT, paid to whoever holds it. On Robinhood Chain its image is drawn on-chain from the vault's record: the stock, strikes and cost, then where the stock opened and what it paid.
- A **Repay Kamino** button on My protection, once a payout is due on a Kamino loan.
- Also: a Solana Blink, a private purchase through Helius's Solana Rings ([/private](https://afterbell-nine.vercel.app/private)), share cards for each night, a calendar alert 30 minutes before each close, and a CSV of your history. Playwright checks the app at phone size after each open.

### Open source and composability

- MIT licensed ([LICENSE](../LICENSE)).
- [SDK](../sdk): a typed client for the API, and the purchase a wallet signs on either chain. The API is described at [`/api/openapi.json`](https://afterbell-nine.vercel.app/api/openapi.json), and a test fails if any route is missing from it.
- [MCP server](../agent), hosted with no keys at `/mcp`, or run locally with an agent's own devnet wallet and a spending cap.
- CPI: another Solana program buys protection and is paid ([cover-desk example](../solana/examples/cover-desk)).
- Standards: ERC-721 positions, an ERC-7540 pool, EIP-2612 permits, EIP-712 quotes; Token-2022 NFTs on Solana.
- [docs/integrate.md](integrate.md): a wallet, a lending protocol or an agent adding protection.

### Business plan

The evidence the plan draws on:

- **Pricing holds up.** Over 1,984 nights on 34 stocks, the pricing paid back 46¢ per $1 of premium ([/backtest](https://afterbell-nine.vercel.app/backtest)).
- **The demand is measurable.** The loans above, and the debt each gap would liquidate.
- **Distribution:** lending protocols (Kamino first), wallets through the SDK, and agents through MCP.

The plan itself: [business.md](business.md).

## What isn't done

- **No outside buyers yet.** Every position so far was bought by one of our wallets (`outside: 0` in [`/api/verify`](https://afterbell-nine.vercel.app/api/verify)).
- **Test money only.** Both vaults' collateral is TestUSD. The Robinhood Chain vault runs on mainnet against Chainlink's real feeds; the Solana vault is on devnet.
- **Claim-and-repay** runs against Kamino's market cloned from mainnet. On the live vault it needs collateral in mainnet USDC, and the Repay Kamino button shows only once the vault pays in it.
- **The hedger** trades on Hyperliquid testnet.
- **No external audit.** The checks are the tests, the invariants, Slither and the daily payout audit above.
- **No fee in the contracts yet.**

## Run it yourself

```bash
npm ci && npm test                       # 361 TypeScript tests
cd evm && forge test                     # 86 Foundry tests
npm run solana:test                      # 82 Rust tests, after building the program and the cover-desk example
npm run evm:cycle                        # a full round on a local chain: sell, move an NFT, settle, pay, roll
npm run solana:cycle                     # the same on a local validator
npm run prove                            # TSLA's worst opening against Kamino's market, from the saved snapshot
npm run audit                            # recompute every live payout on both chains
```
