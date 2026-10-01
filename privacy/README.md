# Private protection (devnet, alpha)

A holder buys Afterbell protection without showing the chain what they protected or what they paid.

1. The holder moves a round amount of TestUSD into a private balance on Helius's Solana Rings. This is public, but it doesn't show the premium.
2. The holder pays the premium to the desk as a confidential transfer: the two wallets are visible, the token and amount aren't.
3. The desk buys the protection in its own name, with its own TestUSD, on a fresh quote.
4. After the open, the desk pays the holder what the protection paid, from its private float, as another confidential transfer.

Only the desk's book (`runs/*.json`) says which position is whose, so **the holder trusts the desk**. A trustless version would have the vault take premiums from, and pay into, a private escrow, which Solana Rings supports in programs.

```sh
pnpm install                                  # Node 24; builds @heliuslabs/zolana from Git (pinned)
pnpm desk buy --shares 1 --throwaway          # two new keys in memory; no payout later
HOLDER_KEYPAIR=… DESK_KEYPAIR=… pnpm desk buy --shares 1
HOLDER_KEYPAIR=… DESK_KEYPAIR=… pnpm desk payout runs/<file>.json   # after the open
```

Test money and SOL for fees come from Afterbell's faucet. `SOLANA_RPC` sets the devnet RPC (public by default); Helius's devnet indexer and prover are built in. `featured.json` is the run the app's `/private` page shows.

- `rings.ts`: deposits, confidential transfers and private balances, through `@heliuslabs/zolana` (v0.3.0-alpha).
- `book.ts`: what the desk owes each holder (tested in the repo's suite).
- `desk.ts`: the command.

This package has its own install (pnpm, Node 24) and isn't part of the npm workspace, so the repo's CI doesn't type-check `rings.ts` or `desk.ts`. `pnpm check` does.
