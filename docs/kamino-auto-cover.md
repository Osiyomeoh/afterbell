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
| Re-sizing an order to the loan each night | Built in the program (`set_sizer` / `remove_sizer` / `resize_order`, 6 tests in `tests/sizer.rs`); the keeper re-sizes before quoting through `renewOrders({ sizeFor })`. The holder names a sizer key and bounds (most shares, shallowest start, deepest depth); the premium cap and allowance stay the holder's. Not yet on devnet: needs a program upgrade. `kaminoSizer` (`solana/keeper/kaminoSize.ts`) reads the holder's own cover from `/api/kamino/cover` and turns its lines into shares at the reference price. |
| Paying toward the loan | **Built, tested locally.** `claimAndRepayInstructions` (solana/client/kamino.ts) puts the vault's `process` for the holder's own position and Kamino's `repay` (from Kamino's SDK) in one transaction. `npm run solana:replay` runs it against Kamino's xStocks market cloned from mainnet: $270.46 paid, and the obligation's USDC debt fell by exactly that. Not yet in the app. |
| Opt-in page | Built (`KaminoAutoCover` on `/kamino#cover`). Connect a wallet, see each loan's gap, cover lines and tonight's price, pick 7/14/30 nights, and set a standing order per stock (cap 1.5× tonight's premium); existing orders listed with a stop. Only the connected wallet is read. Lines over 1,000 shares are skipped and named. Nightly re-sizing waits on the devnet upgrade. |
| A pooled book | **To build.** Per-stock limits on what the vault sells, so one bad night doesn't drain it. The backtest pays 46¢ per $1 overall, but six stocks pay back more than $1. |

## Timing risk

Kamino's liquidators act on the oracle's first price after the open. The vault settles on the price at the
open, but a holder claims afterwards. Until claims repay the loan atomically, the cover makes the borrower
whole after a liquidation; it doesn't prevent one. Atomic repay-on-settle closes that gap, but needs Kamino's
liquidation to wait for the settle, or a keeper that settles and repays in the opening slot.

## Order of work

1. ~~An order-update instruction, plus a keeper step~~ done, wired to `coverPlan` through `kaminoSizer`; left is the devnet upgrade.
2. ~~Opt-in UI on `/kamino`, using the connected wallet only.~~ done.
3. ~~A replay of a real gap~~ done: `npm run solana:replay` replays TSLA's worst recorded opening (23 Jul 2026, −8.8%) against a sample loan on a local validator; the vault pays $270.46 against a $266.43 shortfall.
4. Claim-and-repay in one transaction. Done in the replay; next, a button on /kamino.
5. Per-stock exposure limits in the quoter.
