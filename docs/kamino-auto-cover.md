# Kamino auto-cover

Kamino borrowers who post tokenized stocks (xStocks) as collateral are exposed to one specific risk: the stock
opens far below the close, and the loan is liquidated at the bell before they can act. Auto-cover buys
protection for them before each close, sized to that loan, so the payout repays the part of the debt that
the opening pushes over the limit.

## Sizing

For a loan with stock collateral worth S, liquidation threshold t (Kamino's limit ÷ deposits), debt D and
limit L, a gap g = (L − D) / (t × S) makes it liquidatable if every stock opens that far down. Below g, each
further point takes t × S off the limit, so the shortfall at an opening x is t × S × (x − g).

Cover on t × S of stock that starts paying at g pays exactly that shortfall, down to g + depth (10% by
default, never past 50%). Every stock's cover starts at the gap for all of them together. One stock falling
alone liquidates deeper, so that case is covered too, with some margin.

- Code: `app/src/lib/kaminoCover.ts` (`coverPlan`, `coverPayout`, `shortfall`), tested in `kaminoCover.test.ts`.
- Quote: `GET /api/kamino/cover?wallet=` gives each loan's plan and the gap report's price for it.

Loans are skipped, with a reason, when:

- the stocks can't liquidate the loan within 50%;
- the loan is liquidatable already;
- none of its stocks are priced.

## What exists, what's left

| Piece | State |
| --- | --- |
| Reading a wallet's obligations, the gap that liquidates them | Built (`/kamino`, `kaminoLoans.ts`) |
| Sizing the cover to the shortfall | Built, tested |
| Quote for the cover | Built (`/api/kamino/cover`) |
| Standing orders a keeper renews within a price cap | Built (Solana `order`, `solana/keeper/renew.ts`) |
| Re-sizing an order to the loan each night | Built in the program (`set_sizer` / `remove_sizer` / `resize_order`, 6 tests in `tests/sizer.rs`); the keeper re-sizes before quoting through `renewOrders({ sizeFor })`. The holder names a sizer key and bounds (most shares, shallowest start, deepest depth); the premium cap and allowance stay the holder's. Not yet on devnet: needs a program upgrade. Left: a `sizeFor` that reads the opted-in obligation and turns `coverPlan`'s lines into shares (notional ÷ close). |
| Paying toward the loan | **To build.** Today the payout goes to the holder's wallet. Next: an option to settle into a Kamino `repay` for the obligation, in the same transaction as the claim. |
| Opt-in page | **To build.** On `/kamino`: connect a wallet, see its cover and price, set an order (cap, end date). Only the connected wallet's loans are shown. |
| A pooled book | **To build.** Per-stock limits on what the vault sells, so one bad night doesn't drain it. The backtest pays 46¢ per $1 overall, but six stocks pay back more than $1. |

## Timing risk

Kamino's liquidators act on the oracle's first price after the open. The vault settles on the price at the
open, but a holder claims afterwards. Until claims repay the loan atomically, the cover makes the borrower
whole after a liquidation; it doesn't prevent one. Atomic repay-on-settle closes that gap, but needs Kamino's
liquidation to wait for the settle, or a keeper that settles and repays in the opening slot.

## Order of work

1. ~~An order-update instruction, plus a keeper step~~ done; left is wiring `coverPlan` into `sizeFor` and the devnet upgrade.
2. Opt-in UI on `/kamino`, using the connected wallet only.
3. Claim-and-repay in one transaction.
4. Per-stock exposure limits in the quoter.
