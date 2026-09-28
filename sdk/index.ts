/**
 * Afterbell's SDK: the typed API client, and the helpers that turn a signed
 * quote into the purchase its buyer's wallet signs, on Solana or Robinhood
 * Chain. See docs/integrate.md.
 */
export { quoteBook, type BookQuote, type BookQuoteLine } from "./book";
export { AfterbellClient, AfterbellError, referencePrice, strikesBelow, toMarket } from "./client";
export { robinhoodPurchase, toEvmQuote } from "./robinhood";
export { solanaPurchase, toSolanaQuote, type SolanaPurchase } from "./solana";
export type * from "./types";
