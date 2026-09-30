# afterbell-sdk

A typed client for [Afterbell](https://afterbell-nine.vercel.app): protection for tokenized stocks until the next 09:30 ET open, settled on-chain by the oracle's opening price, on Solana and Robinhood Chain.

```sh
npm install afterbell-sdk
```

```ts
import { AfterbellClient, solanaPurchase } from "afterbell-sdk";

const api = new AfterbellClient("https://afterbell-nine.vercel.app");
const protection = await api.protectionBelow("TSLA", 10, 0.02, 0.1); // 10 shares, 2% to 10% below
const quote = await api.quote({ chain: "solana", symbol: "TSLA", buyer: wallet.toBase58(), ...protection });
const { transaction } = await solanaPurchase(connection, wallet, quote.solana); // the buyer signs and sends it

const loans = await api.kaminoLoans(borrower); // where each Kamino loan breaks, and cover down to it
```

It holds no keys: a quote is signed by the quote service for the buyer named in it, and only that buyer's wallet can submit it. Test money only (TestUSD) for now.

The full guide, for wallets, protocols and agents: [docs/integrate.md](https://github.com/Osiyomeoh/afterbell/blob/main/docs/integrate.md). MIT licensed.
