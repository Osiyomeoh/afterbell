# Building on Afterbell

Afterbell sells protection for a tokenized stock until the next 09:30 ET opening bell: pay a premium once, and if the stock opens below where protection starts, the vault pays the difference per share, down to where it stops. Each position is an NFT; whoever holds it is paid, on the oracle's opening price.

Everything the app does is a public HTTP API, and `sdk/` is a typed TypeScript client for it. This guide shows how a wallet, an app, a protocol or an agent adds that protection for its own users.

Test money only: the vaults hold TestUSD, which has no value. Solana is on devnet; the Robinhood Chain vault is on mainnet with TestUSD as collateral.

- **API:** `https://afterbell-nine.vercel.app/api/…`; every route is described in the OpenAPI document at [`/api/openapi.json`](https://afterbell-nine.vercel.app/api/openapi.json).
- **SDK:** [`sdk/`](../sdk) in this repo (`AfterbellClient`, `solanaPurchase`, `robinhoodPurchase`). It holds no keys.
- **Status:** [`/status`](https://afterbell-nine.vercel.app/status), and `GET /api/status` for a monitor.

## How a purchase works

1. **Price it.** Choose the shares and where protection starts and stops. `protectionBelow` turns percentages below the stock's price into the dollar strikes the API takes.
2. **Get a quote.** `POST /api/quote` prices it from the service's own market data and signs it for one buyer. It's valid for about a minute, and sales for an open stop two minutes before it.
3. **The buyer submits it.** Only the wallet the quote names can use it: on Solana a transaction with the Ed25519 check of the quote and `buy`; on Robinhood Chain `buyWithPermit`. The position arrives in that wallet as an NFT.
4. **The open settles it.** A keeper (anyone may) settles the series on the oracle's price at the open and pays each position to its NFT's holder. Nothing to claim by hand.

## Solana, from a wallet app

```ts
import { Connection } from "@solana/web3.js";
import { AfterbellClient, solanaPurchase } from "./sdk";

const afterbell = new AfterbellClient("https://afterbell-nine.vercel.app");
const connection = new Connection("https://api.devnet.solana.com", "confirmed");

// 10 TSLA, protected from 2% to 10% below the price, until the next open.
const protection = await afterbell.protectionBelow("TSLA", 10, 0.02, 0.1);
const quote = await afterbell.quote({ chain: "solana", symbol: "TSLA", buyer: wallet.publicKey.toBase58(), ...protection });
console.log(`$${quote.priced.premium.toFixed(2)} for up to $${quote.priced.maxPayout.toFixed(2)}`);

const { transaction, blockhash, lastValidBlockHeight } = await solanaPurchase(connection, wallet.publicKey, quote.solana);
const signature = await wallet.sendTransaction(transaction, connection);
await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
```

The buyer pays in TestUSD: `afterbell.faucet(address)` sends a devnet wallet 1,000 TestUSD and a little SOL.

## Robinhood Chain, with viem

```ts
import { AfterbellClient, robinhoodPurchase } from "./sdk";

const protection = await afterbell.protectionBelow("NVDA", 5, 0.02, 0.1);
const quote = await afterbell.quote({ chain: "robinhood", symbol: "NVDA", buyer: walletClient.account.address, ...protection });
const { id, hash } = await robinhoodPurchase(walletClient, publicClient, quote);
```

One transaction: the wallet signs a permit for the premium and the vault takes it with the purchase. The wallet needs the premium in TestUSD, which anyone may mint (`mintTestUsd` in `evm/client/vault.ts`), and a little ETH on Robinhood Chain for gas. `market.robinhood` says which of the 34 stocks are on sale.

## For protocols: a whole book

A vault or lending market holding tokenized stocks carries every stock's opening at once. The gap report shows how each stock in a book has opened, what its worst opening would cost at today's price, and what protecting the book until the next open costs now:

```ts
const report = await afterbell.gapReport({ book: "TSLA:100,NVDA:$25000", start: 2, stop: 10 });
// report.totals: the book's value, tonight's premium, what it pays at most, and every stock's worst night at once.
```

The same report is `GET /api/gap-report?book=TSLA:100,NVDA:$25000` and the MCP tool `gap_report`.

To buy it, `quoteBook` quotes every line for one buyer. A dollar line is sized at the stock's price, and a line that can't be sold says why rather than failing the rest:

```ts
import { quoteBook, robinhoodPurchase } from "./sdk";

const book = await quoteBook(afterbell, { chain: "robinhood", book: "TSLA:100,NVDA:$25000", buyer: walletClient.account.address, start: 0.02, depth: 0.1 });
console.log(`$${book.premium.toFixed(2)} protects the book for up to $${book.maxPayout.toFixed(2)}`);
for (const line of book.lines) {
  if ("error" in line) console.warn(`${line.symbol}: ${line.error}`);
  else await robinhoodPurchase(walletClient, publicClient, line.quote);
}
```

The quotes are signed for the wallet that buys (a treasury or keeper account; `buyWithPermit` takes the premium from the caller), and each lasts about a minute, so buy right after quoting. Robinhood Chain sells all 34 stocks; Solana sells TSLA.

## For agents

The MCP server prices protection, sizes it to a wallet's TSLA, follows positions and returns unsigned transactions for the agent's own wallet:

```sh
claude mcp add --transport http afterbell https://afterbell-nine.vercel.app/mcp
```

Run from the repo instead, it gives the agent a devnet wallet of its own with a spending cap on every purchase:

```sh
claude mcp add afterbell -e AFTERBELL_URL=https://afterbell-nine.vercel.app -- npx tsx agent/server.ts
```

## Following it through

| | |
|---|---|
| A wallet's positions, and what each pays once settled | `afterbell.positions(address)` · `GET /api/positions?owner=` |
| Every series sold, the price it settled on, what it paid | `afterbell.record()` · `GET /api/record` |
| A vault, its underwriters' pool and its series | `afterbell.vault("solana" \| "robinhood")` · `GET /api/vault` |
| The hedge on Hyperliquid | `afterbell.hedge()` · `GET /api/hedge` |
| A position to share, with a preview image | `/p/solana/<position>`, `/p/robinhood/<id>` |

Errors come back as `AfterbellError`, with the API's own message and HTTP status: 409 when the vault can't take the sale now (its pool is still closing out the last opening, or can't cover that much more on the stock tonight), 422 when the protection can't be priced or sold as asked (a stock that vault doesn't sell, strikes the quoter refuses), 503 when a price or the chain can't be read.
