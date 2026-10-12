# Hosting the app

Status, 28 Sep 2026: **hosted on Vercel at [afterbell-nine.vercel.app](https://afterbell-nine.vercel.app)**, deployed from the `hedger` branch's committed files (`git archive` of HEAD, then `vercel deploy --prod`; the project isn't linked to GitHub, so a push doesn't deploy, and the dashboard's Redeploy rebuilds the last upload). The keys below are set in the project's settings by the user, never in the repo. Before that, the production build and `next start` answered 200 locally on every page and read-only route.

## What the host runs

Node 20.9 or later (Next 16's minimum; CI and the local runs use Node 24). The app is an npm workspace that imports the quoter, pricing, both vault clients and the hedger from the repo root, so the host builds from the root:

```bash
npm ci
npm run build --workspace app
npm run start --workspace app -- --port "$PORT"
```

- **Working directory.** The server finds the deployment records relative to `app/` (`../solana/deployments/*.json`, `../evm/deployments/*.json`, read at request time). `npm run … --workspace app` runs from there; `next.config.ts` traces those files into the routes that read them, so a host that bundles only the traced files still ships them.
- **Linux builds.** `package-lock.json` carries the build tool's binding for linux-x64 (glibc) as well as macOS arm64, so `npm ci` needs nothing extra on a usual Linux host.
- **Caches** live in the process: market data 15 s, each vault 10 s, the hedge 15 s, each stock's openings history 1 hour, the track record's settlement transactions once. One long-running server keeps them; on a serverless host each instance keeps its own, which only means more reads of the same public endpoints.
- **Long requests.** The Blink and the hosted MCP route allow up to 60 s (`maxDuration`), since a first purchase waits for the faucet's transactions; the host's plan must allow that.

## Settings

Secrets go in the host's dashboard, never in the repo. Every one is optional for the app to run; without one, the feature it serves says it's unavailable.

| Variable | Secret | What it does | Without it |
|---|---|---|---|
| `PYTH_API_KEY` | yes | Pyth's closing print and live session prices for TSLA and QQQ | Hyperliquid's prices, labelled as such |
| `QUOTER_SOLANA_KEY` | yes | The Solana vault's quoter key, as the keypair file's contents (a JSON array of 64 numbers). It must be the vault's quoter, `Ajy9Hwcc7FcTfoU9fJbHU4DRTzJDuubdQ3EDRAmMQ9hW`; any other is refused | No quotes: `/api/quote`, the Blink ("Quotes are unavailable right now") and the hosted MCP's purchases |
| `FAUCET_SOLANA_KEY` | yes | TestUSD's mint authority (`2h1B…`), same format. Mints test money and pays the faucet's fees and 0.02 SOL drips | No faucet, and a fresh wallet can't buy from the Blink in one click |
| `MAINNET_RPC_URL` | if it holds a key | Solana mainnet RPC for "Protect what I hold" (TSLAx and TSLAon balances) | The public RPC, which rate-limits |
| `QUOTER_EVM_KEY` | yes | The Robinhood Chain vault's quoter key, once that vault is deployed | Robinhood Chain quotes |
| `SITE_URL` | no | The hosted address (`https://…`), **read at build time**, so link previews use the site's own image | Previews point at `http://localhost:3000` |
| `NEXT_PUBLIC_SOLANA_RPC`, `SOLANA_RPC` | no | Solana RPC for the browser (read at build time) and the server; `SOLANA_RPC` also serves the first vault's reads, which are on the same cluster. A devnet RPC with its own key (Helius, say) is worth it on a shared host: the public one answers only about ten transaction reads at a time per address | Devnet's public RPC, which rate-limits |
| `ROBINHOOD_RPC` | no | Robinhood Chain RPC for Chainlink's prices (every stock but TSLA and QQQ, and the Robinhood Chain tab) | The chain's public RPC |
| `HEDGE_ACCOUNT`, `HYPERLIQUID_NETWORK`, `HEDGE_MAX_NOTIONAL` | no | The hedge panel: the hedge account's address (no key), testnet, the cap | "Not running yet" and the short the vaults call for |

Leave `SOLANA_DEPLOYMENT_FILE`, `EVM_DEPLOYMENT_FILE` and the `*_FILE` key variables unset when hosting: they point at local files.

Anyone can use a public faucet. On 27 Sep the faucet key held 0.214 devnet SOL, about 9 fresh wallets' worth at 0.022 each; top it up before sharing the link.

## Which branch

- `main` runs the first Solana vault, whose last positions are paid after Monday 28 Sep's open.
- `solana-v2` (PR #2) and `hedger` (PR #3, on top of it) run the second vault, deployed on devnet with its pool underwritten, plus the hedge panel on `hedger`.

After Monday's payouts and the merges, host `main`. To host before then, host `solana-v2` or `hedger`; the first version's history still shows on the track record either way.

## On Vercel

1. Import the GitHub repository (it's private: grant Vercel access to it).
2. Root Directory `app`, framework Next.js. The app imports from outside `app/`, so keep "Include files outside the root directory in the Build Step" on. Vercel is expected to install from the root's lockfile, since the root is an npm workspace; if the first build can't find a root package or an `@root/…` import, set the Install Command to `cd .. && npm ci`.
3. Production Branch: the branch chosen above.
4. The settings above, `SITE_URL` included (Vercel may fill previews from its own URL without it; setting it keeps the address the one you share).
5. Deploy, then run the checks below.

## On any Node host (Render, Railway, Fly, a VM)

Build and start command as above, `PORT` from the host, the settings as environment variables, a health check on `/`.

## After it's up

1. Open `/`, `/vault` and `/record`; `/api/market?symbol=TSLA` should say where its prices came from, and `/mcp` prints the MCP address for this host. `/api/actions/protect` should describe a price, not "Quotes are unavailable right now".
2. **Before the second vault's first sale, point its NFTs' art at the host.** Each position's NFT records the art address the vault holds when it's minted (today `http://localhost:3100/api/position-art/solana/`), and only NFTs minted after a change get the new one. The program's authority (GZP4) signs a single transaction; setup sees the vault exists and sends only that change:

   ```bash
   QUOTER=Ajy9Hwcc7FcTfoU9fJbHU4DRTzJDuubdQ3EDRAmMQ9hW ART_URI=https://<host>/api/position-art/solana/ npx tsx solana/scripts/setup.ts
   ```

   The address must be at most 128 characters. Setup rewrites `solana/deployments/devnet.json` with it; commit that file.
3. Put the address in the README, the Blink (`https://<host>/api/actions/protect`) and the MCP line (`https://<host>/mcp`) where they're listed for users.
