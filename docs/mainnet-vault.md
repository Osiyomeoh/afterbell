# A mainnet USDC vault, and a live protected loan

How to run the Solana vault on mainnet with USDC, buy cover on your own Kamino loan, and repay the loan with the payout in one transaction. Nothing here has been run yet. Every step that signs or spends is yours to run.

The hosted site stays on devnet throughout. The mainnet vault is driven from the app running on your machine.

## Decide first

- **SOL.** Deploying the program locks its rent: 3.73 SOL at today's size, or 4.06 SOL with `--max-len 800000` to leave room for upgrades (read from mainnet, 6 Oct). Closing the program returns the rent, but then J6n3… can never be deployed on mainnet again. Allow about 0.1 SOL more for the vault's accounts, positions and fees. GZP4 holds 0 SOL on mainnet today.
- **USDC.** You fund the pool yourself.
  - The vault lets one stock carry at most 20% of the pool (`maxFeedBps`), so the pool needs at least 5× the most your cover can pay.
  - One TSLA share, covered from the close down to 10% below, pays at most about $36. That needs a $200 pool.
  - Your premiums go into your own pool, so the money only moves between your own wallets.
- **Anyone can deposit.**
  - Buying needs a quote signed by the vault's quoter, so nobody can buy if the quoter key never leaves your machine.
  - Depositing into the pool (`request_deposit`) is open to any wallet, and the program has no pause. Once the repo is public, a stranger could underwrite your covers with real USDC.
  - Either accept that for a short run, or have the mainnet build take deposits from the vault's authority only. That's a small program change with a test, and it has to be made before deploying.
- **The quoter.** Use a fresh key that stays on your machine (step 3) rather than the hosted quoter, Ajy9…. A quote names the program, the vault and the buyer, so the hosted site can't sell from this vault either way. A separate key keeps it that way.
- **What to claim.** Say "a mainnet run with the team's own money". There are still no outside buyers and no outside capital.

## What was checked (6 Oct)

- **The program address.** J6n3… is free on mainnet. The program ID, and every address derived from it, is the same on every cluster, so the code needs no change.
- **Pyth.** The receiver, Wormhole and push-oracle programs the vault and keeper use (Pyth's pro-compatible set: `rec2HHDD…`, `HDw2E7P8…`, `pyt2F414…`) are deployed on mainnet. The feed IDs are the same ones devnet uses.
- **The keeper.** A run normally settles a series and pays its holders together, which would leave "Repay Kamino" nothing to claim. `npm run solana:keeper -- --no-pay` settles without paying. `npm run solana:cycle` checks it on a local validator.
- **The Repay Kamino button.** It shows only for a vault that pays mainnet USDC (`KAMINO_REPAYABLE_MINT`). It repays the smaller of the payout and the loan's USDC debt, in the same transaction as the claim. The replay on a cloned Kamino market passed: $270.46 paid, debt $6,000 → $5,729.54.
- **Odds.** TSLA opened below its close on 21 of the 46 recorded openings (`research/data/pyth-tsla-gaps.json`). A cover that starts at the close pays on such a night.

## Steps

Set this once in your shell, with a paid or free-tier RPC. The public RPC rate-limits deploys.

```sh
export MAINNET_RPC_URL=<your mainnet RPC>
```

### 1. Build

```sh
cd ~/Documents/afterbell/solana
cargo build-sbf
```

This is the same build as CI's and devnet's.

### 2. Deploy the program

You need the keypair file that first deployed J6n3… on devnet. `--program-id` takes that file here, not the address, because this is a first deploy.

```sh
solana program deploy target/deploy/afterbell_vault.so \
  --program-id target/deploy/afterbell_vault-keypair.json \
  --upgrade-authority ~/.config/solana/id.json \
  --max-len 800000 \
  --with-compute-unit-price 10000 --use-rpc \
  -u "$MAINNET_RPC_URL"
solana program show J6n3JUafVkx4MpKTnAnZSwTcGFueRrjxgiXWMC4L7RGG -u "$MAINNET_RPC_URL"
```

If the deploy stops partway, the buffer holds the SOL:
- the CLI prints a seed phrase for the buffer's keypair, so you can resume with `--buffer`;
- or `solana program close --buffers -u "$MAINNET_RPC_URL"` returns the SOL.

If the program keypair is lost, the program needs a new ID. That changes `declare_id!`, the IDL and the pinned addresses: a code change before deploying.

### 3. A quoter key that stays local

```sh
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/afterbell-mainnet-quoter.json
solana-keygen pubkey ~/.config/solana/afterbell-mainnet-quoter.json
```

### 4. The vault

The authority's wallet must already hold the `SEED` in USDC; setup can't mint it.

```sh
cd ~/Documents/afterbell
RPC_URL="$MAINNET_RPC_URL" OUT=solana/deployments/mainnet.json \
MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v SEED=200 \
QUOTER=<the quoter's public key> \
npx tsx solana/scripts/setup.ts
```

This:
- creates the vault for (your authority, USDC);
- allows the TSLA and QQQ feeds;
- underwrites the pool with the `SEED` (request, roll, claim);
- writes `solana/deployments/mainnet.json`.

That file holds only public addresses, so it can be committed. It may say "TestUSD" in its output; the mint is USDC.

### 5. The loan

In Kamino's app, on the xStocks market:
- deposit a little TSLAx and borrow USDC against it, from the wallet that will buy the cover;
- keep a few dollars of USDC in that wallet for the premium.

Kamino's TSLAx terms are 55% LTV and a 65% liquidation threshold.

### 6. The app, on mainnet, on your machine

Use your usual `app/.env.local` (Pyth key and the rest), plus:

```sh
cd ~/Documents/afterbell/app
SOLANA_DEPLOYMENT_FILE=$HOME/Documents/afterbell/solana/deployments/mainnet.json \
SOLANA_RPC="$MAINNET_RPC_URL" NEXT_PUBLIC_SOLANA_RPC="$MAINNET_RPC_URL" MAINNET_RPC_URL="$MAINNET_RPC_URL" \
QUOTER_SOLANA_KEY_FILE=~/.config/solana/afterbell-mainnet-quoter.json \
npm run dev
```

Leave `FAUCET_SOLANA_KEY_FILE` unset; there's no test money on mainnet.

### 7. Buy, the evening before an opening

Open localhost:3000 and connect the wallet with the loan. On /kamino, paste that wallet to see your loan and the opening that would liquidate it.

Buy TSLA cover for the shares behind it, starting at the close. Quotes stop 2 minutes before the open.

A standing order renews it every night, but the renewals need step 8's `AFTERBELL_URL`, with the local app running.

### 8. After the open: settle, don't pay

The open is 13:30 UTC in October (14:30 in Lagos). Settle within 24 hours of it; after that, the series can be voided and the premiums refunded.

```sh
cd ~/Documents/afterbell
export RPC_URL="$MAINNET_RPC_URL" DEPLOYMENTS=solana/deployments/mainnet.json AFTERBELL_URL=http://localhost:3000
npm run solana:keeper -- --plan     # what it would do; sends nothing
npm run solana:keeper -- --no-pay   # settle on Pyth's first print after the open, and leave the payout to you
```

Both need `PYTH_API_KEY` in the environment, as on devnet.

### 9. Claim and repay

On My protection, press **Repay Kamino**. In one transaction:
1. the payout leaves the vault;
2. it repays your USDC loan on Kamino.

If TSLA opened at or above its close, the cover pays nothing. Buy again for the next opening.

### 10. Close out

- A plain `npm run solana:keeper`, with step 8's environment, closes the positions that paid nothing and rolls the pool.
- Take the pool's USDC back on /vault: request a redemption, then claim it after the roll.
- Note the signatures of the deploy, the vault, the buy, the settlement and the repay, for the README and the submission.

## Timing

Openings before the internal deadline (11 Oct, 23:59 Lagos):

| Opening | Buy cover |
|---|---|
| Wed 7 Oct | Tue 6 evening |
| Thu 8 Oct | Wed 7 evening |
| Fri 9 Oct | Thu 8 evening |

If openings were independent, 21 down openings in 46 would give at least one paying night in three about 5 times in 6.

Monday 12 Oct opens at 06:30 Pacific, before the contest's own deadline, so it's a fourth try.
