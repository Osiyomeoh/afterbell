/** Buying a Robinhood Chain quote from the buyer's own wallet: a permit for the premium and the purchase, in one transaction. */
import type { Account, Address, Chain, Hex, PublicClient, Transport, WalletClient } from "viem";

import { buyProtection } from "../evm/client/vault";
import type { EvmQuote } from "../pricing/quote";

import type { EvmQuoteResponse } from "./types";

/** The signed quote in the contract's types. */
export function toEvmQuote(q: EvmQuoteResponse["evm"]["quote"]): EvmQuote {
  return {
    buyer: q.buyer as Address,
    feed: q.feed as Address,
    openTs: BigInt(q.openTs),
    shares: BigInt(q.shares),
    upper: BigInt(q.upper),
    lower: BigInt(q.lower),
    premium: BigInt(q.premium),
    expiry: BigInt(q.expiry),
    nonce: BigInt(q.nonce),
  };
}

/**
 * Buys the quoted protection from the quote's buyer: the wallet signs a
 * permit for the premium, then sends `buyWithPermit`. The wallet needs the
 * premium in TestUSD, which anyone may mint, and a little ETH for gas.
 * Resolves once mined, with the position's id (its NFT's token id).
 */
export function robinhoodPurchase(wallet: WalletClient<Transport, Chain, Account>, client: PublicClient, r: EvmQuoteResponse): Promise<{ id: bigint; hash: Hex }> {
  if (wallet.account.address.toLowerCase() !== r.evm.quote.buyer.toLowerCase()) throw new Error("the quote was signed for another buyer");
  return buyProtection(wallet, client, r.evm, toEvmQuote(r.evm.quote), r.evm.signature);
}
