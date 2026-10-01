# Protect every night: a design

Status, 28 September: **live on Robinhood Chain mainnet** (renewer `0x710Df188d43F6778E84C83025ee589c292544627`): `evm/src/AfterbellRenewer.sol` with Foundry tests (unit and fuzz), the client (`evm/client/renewer.ts`), the keeper's renewal step (`evm/keeper/renew.ts`, run by `npm run evm:keeper`), the checkout option and the list on My protection, and a standing-order round in `npm run evm:cycle`. It was deployed with `script/DeployRenewer.s.sol`, and its address is in `evm/deployments/robinhood.json`. **Solana is still a design**: the program upgrade needs about 4 SOL of buffer rent.

## What the holder gets

Today a holder buys protection one opening at a time, and has to come back every night. "Protect every night" is set once:

- the stock and how many shares (or at most how many);
- where protection starts and how deep it goes, as percentages below the price (for example 2% to 10%);
- the most they'll pay for one night;
- until when (a date, or a number of nights).

After each open, once the vault has settled and rolled, a keeper buys the next night's protection for them at the quoter's price, if that price is within their cap. The NFT lands in their wallet and pays them as it does today. A night the price is above the cap is skipped, and the app says so. They can stop it at any time.

What doesn't change: the quoter signs every price; the vault's rules (one opening per round, the pool's risk limits) apply to every renewal; settlement and payout are untouched.

## Robinhood Chain: a renewer beside the vault

The vault went live on mainnet on 28 September and can't be upgraded, so renewal is a separate contract, `AfterbellRenewer`, and the vault doesn't change.

The vault's `buy` requires `msg.sender == q.buyer` and mints the NFT to the buyer (`_mint`, so no receiver hook). So the renewer is the buyer:

1. The holder approves TestUSD to the renewer and calls `setOrder(feed, maxShares, startBps, depthBps, maxPremium, until)`.
2. After the roll, anyone calls `renew(holder, quote, signature)` with a quote the quoter signed for `buyer = renewer`.
3. The renewer checks the order:
   - it's active;
   - `q.openTs` is later than the last opening it bought for;
   - `q.shares ≤ maxShares` and `q.premium ≤ maxPremium`;
   - `q.upper` and `q.lower` sit within a tolerance of the order's percentages below the feed's latest Chainlink answer.
4. It pulls the premium from the holder, calls `vault.buy`, and transfers the NFT to the holder in the same transaction. Payouts follow the NFT, so they reach the holder.

Anyone can call `renew`, because the order's checks, not the caller, protect the holder. At worst someone else triggers a renewal the holder already asked for.

**Knock-on:**
- **Buyer in the vault's record:** positions bought this way record the renewer as `buyer`. The app already lists an unpaid Robinhood Chain position under whoever holds its NFT, so a renewed position shows on the holder's My protection.
- **Quotes:** the quote API already signs for any EVM address.

**Tests:**
- Forge unit and fuzz tests (`test/Renewer.t.sol`).
- An invariant suite (`test/RenewerInvariant.t.sol`), random sequences of orders set, replaced and cancelled, renewals within the order and outside it from any caller, and nights settled and rolled:
  - a holder never pays more than `maxPremium` a night, nor for more than `maxShares`, and is charged exactly the premium;
  - nothing renews twice for one opening, even across a cancel and a new order, nor after the order ends;
  - every NFT ends with the holder, and the renewer keeps neither NFTs nor money.
  Removing the premium cap or the once-per-opening check makes the matching invariant fail.
- Slither in CI, as for the vault. Its four findings on the renewer are reviewed and explained in `evm/slither.db.json`, so CI fails on anything new; the deployed contract's source stays as deployed.

## Solana: new instructions in vault v2

v2 is upgradeable (authority GZP4), so renewal goes into the program:

- **`set_order`** (the holder signs): creates an `Order` account at `[b"order", vault, holder, feed]` with the same fields. In the same transaction, an SPL `approve` lets the order account move up to `maxPremium × nights` of the holder's TestUSD.
- **`cancel_order`** (the holder signs): closes the order and revokes the approval.
- **`buy_for`** (anyone signs, as the fee and rent payer): the same checks and accounts as `buy`, except for three things:
  - The quote is signed for `buyer = holder`, so `quote_message` and the quoter don't change.
  - The premium moves with the order account as the delegate.
  - The NFT goes to the holder's associated account.
  - It then checks the order: active, a later opening than the last one bought, shares and premium within the caps.

**What the program can't check:**
- **The strikes:** it has no price at purchase time, so it can't check them against the price. The keeper picks them from the order's percentages and the reference price the app uses. The premium cap bounds what a bad pick could cost the holder.
- **Rent:** the payer covers each position's rent (its account, mint and the holder's NFT account). That's free on devnet; on mainnet it would go into the premium or come from a deposit on the order.

**Tests:** LiteSVM tests beside the existing ones:
- a renewal within the caps;
- one above the premium cap refused;
- a second one for the same opening refused;
- cancel then renew refused;
- the NFT in the holder's wallet and paid to them.

The user upgrades the program with GZP4, after the open series has settled.

## Keeper

Renewal is one more step after `process` and `roll`. For each active order:

1. Price the order's protection with the same reference price as the app.
2. Get a signed quote from `/api/quote`, with the buyer set to the renewer on Robinhood Chain and the holder on Solana.
3. Skip it if the premium is above the cap, and log "skipped: price above the cap".
4. Otherwise send `renew` or `buy_for`.

`--plan` prints what it would renew and at what price, and sends nothing.

## App and agents

- **Checkout:** a checkbox, "Protect every night until …, at most $… a night". It sets the order and the approval in the purchase's transaction.
- **My protection:** lists the order and each night's result (bought, skipped and why), with a Stop button.
- **MCP:** a `set_order` tool, so an agent can set it up for a wallet under its own spending cap.

## Effort

| Part | Work |
|---|---|
| Robinhood Chain renewer | Contract, unit and invariant tests, Slither: about a day |
| Solana program | Three instructions, the Order account, LiteSVM tests, upgrade: a day to a day and a half |
| Keeper and app | The renew step, the checkout option, My protection: about a day |

## Decisions

- **[Decide]** Build it at all, and when. Recommendation: after the 2 October deliveries campaign, which needs no new contract.
- **[Decide]** Which chain first. Recommendation: Solana, where the app's users are and a purchase needs no real money; the Robinhood Chain renewer after.
- **[Decide]** The cap: a dollar amount per night (proposed; easy to read) or a share of the most it can pay.
- **[Decide]** A fee for renewing. Proposed: none while it's test money.
