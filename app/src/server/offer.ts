import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";

import type { Protection } from "@root/pricing/putSpread";
import {
  DEFAULT_QUOTER_CONFIG,
  priceQuote,
  referencePrice,
  signForSolana,
  type PricedProtection,
  type QuoterConfig,
  type SignedSolanaQuote,
} from "@root/quoter/quoter";
import type { Stock } from "@root/quoter/stocks";
import { buyInstructions, getProgram } from "@root/solana/client/vault";

import { SOLANA_DEPLOYMENT } from "./deployment";
import { keypairFromEnv } from "./env";
import { marketSnapshot, onSolanaVault } from "./market";

export class OfferError extends Error {}

export type SignedOffer = { priced: PricedProtection; signed: SignedSolanaQuote };

/** Prices protection with the server's market data. Pricing problems (a pause, bad strikes) are OfferErrors. */
export async function priceOffer(stock: Stock, protection: Protection, cfg: QuoterConfig = DEFAULT_QUOTER_CONFIG): Promise<PricedProtection> {
  const snap = await marketSnapshot(stock);
  try {
    return priceQuote(Math.floor(Date.now() / 1000), snap.market, protection, cfg);
  } catch (e) {
    throw new OfferError((e as Error).message);
  }
}

/** Prices protection with the server's market data and signs it for `buyer` with the Solana vault's quoter key. */
export async function signedOffer(stock: Stock, buyer: PublicKey, protection: Protection, cfg: QuoterConfig = DEFAULT_QUOTER_CONFIG): Promise<SignedOffer> {
  const d = SOLANA_DEPLOYMENT;
  if (!d) throw new OfferError("the Solana vault v2 isn't deployed yet");
  if (!onSolanaVault(stock)) throw new OfferError(`the Solana vault doesn't sell ${stock.symbol} yet`);
  const quoter = keypairFromEnv("QUOTER_SOLANA_KEY");
  if (!quoter) throw new Error("the quote service has no quoter key configured");
  if (quoter.publicKey.toBase58() !== d.quoter) throw new Error("the configured quoter key isn't this vault's quoter");
  const priced = await priceOffer(stock, protection, cfg);
  const signed = signForSolana(priced, buyer.toBase58(), { programId: d.programId, vault: d.vault, feedId: stock.feedId }, quoter.secretKey.slice(0, 32));
  return { priced, signed };
}

/** Protection from `start` to `depth` below the price protection is priced from, as fractions (0.02 = 2%). */
export async function protectionBelow(stock: Stock, shares: number, start: number, depth: number): Promise<Protection> {
  const snap = await marketSnapshot(stock);
  const now = Math.floor(Date.now() / 1000);
  let reference: number;
  try {
    reference = referencePrice(now, snap.market).price;
  } catch (e) {
    throw new OfferError((e as Error).message);
  }
  const round2 = (v: number) => Math.round(v * 100) / 100;
  return { shares, upper: round2(reference * (1 - start)), lower: round2(reference * (1 - depth)) };
}

const readOnly = (publicKey: PublicKey) => ({
  publicKey,
  signTransaction: () => Promise.reject(new Error("unsigned")),
  signAllTransactions: () => Promise.reject(new Error("unsigned")),
});

/** The unsigned purchase for the buyer's wallet to sign: the Ed25519 check, then `buy`, which mints the position's NFT to the buyer. */
export async function purchaseTransaction(connection: Connection, buyer: PublicKey, offer: SignedOffer): Promise<Transaction> {
  const d = SOLANA_DEPLOYMENT;
  if (!d) throw new OfferError("the Solana vault v2 isn't deployed yet");
  const mint = new PublicKey(d.collateralMint);
  const ixs = await buyInstructions(getProgram(connection, readOnly(buyer)), {
    buyer,
    vault: new PublicKey(d.vault),
    collateralMint: mint,
    buyerToken: getAssociatedTokenAddressSync(mint, buyer),
    quote: offer.signed.quote,
    ed25519Data: offer.signed.ed25519Data,
  });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  return new Transaction({ feePayer: buyer, blockhash, lastValidBlockHeight }).add(...ixs);
}
