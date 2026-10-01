/**
 * Buys protection end to end on a deployed, set-up vault: the quote service
 * prices and signs a quote, and the buyer sends the Ed25519 check plus `buy`.
 * Then it reads the position back and checks the buyer holds its NFT. Proves
 * the pricing, the signer, the client and the program agree on a real cluster.
 *
 *   QUOTER_KEYPAIR=~/.config/solana/afterbell-quoter.json npm run solana:smoke
 *   QUOTE_URL=http://localhost:3100/api/quote npm run solana:smoke
 *
 * QUOTE_URL      take the signed quote from the app's quote endpoint instead
 *                of signing here (then QUOTER_KEYPAIR isn't needed)
 * RPC_URL        defaults to devnet
 * ANCHOR_WALLET  the buyer, defaults to ~/.config/solana/id.json; if it's the
 *                TestUSD mint authority, it mints itself TestUSD when short
 * DEPLOYMENTS    defaults to solana/deployments/devnet.json (from setup.ts)
 *
 * Keys are only loaded to sign, never printed. It prices from the last
 * recorded close, so run it outside the session; the app uses live prices.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import anchor from "@anchor-lang/core";
import { getAccount, getMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";

import data from "../../research/data/pyth-tsla-gaps.json" with { type: "json" };
import type { Opening } from "../../pricing/model";
import type { SolanaQuote } from "../../pricing/solanaQuote";
import { priceQuote, signForSolana, type PricedProtection } from "../../quoter/quoter";
import { buyInstructions, getProgram, positionAddress, PROGRAM_ID, token2022Account } from "../client/vault";

import { loadKeypair } from "./common";

async function main() {
  const rpc = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const d = JSON.parse(readFileSync(process.env.DEPLOYMENTS ?? "solana/deployments/devnet.json", "utf8"));
  const buyer = loadKeypair(process.env.ANCHOR_WALLET ?? join(homedir(), ".config/solana/id.json"));

  const connection = new Connection(rpc, "confirmed");
  const program = getProgram(connection, new anchor.Wallet(buyer));
  const vault = new PublicKey(d.vault);
  const mint = new PublicKey(d.collateralMint);

  const history = data.gaps as Opening[];
  const reference = history[history.length - 1]!.close;
  const protection = {
    shares: 1,
    upper: Math.round(reference * 0.98 * 100) / 100,
    lower: Math.round(reference * 0.9 * 100) / 100,
  };
  let priced: PricedProtection;
  let signed: { quote: SolanaQuote; ed25519Data: Uint8Array };
  if (process.env.QUOTE_URL) {
    // The app's quote endpoint prices with live market data and signs.
    const res = await fetch(process.env.QUOTE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chain: "solana", buyer: buyer.publicKey.toBase58(), ...protection }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`quote endpoint: ${body.error}`);
    if (body.solana.vault !== d.vault) throw new Error(`the quote is for vault ${body.solana.vault}, not ${d.vault}`);
    const q = body.solana.quote;
    const hexBytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
    priced = body.priced;
    signed = {
      quote: { feedId: hexBytes(q.feedId), openTs: BigInt(q.openTs), shares: BigInt(q.shares), upper: BigInt(q.upper), lower: BigInt(q.lower), premium: BigInt(q.premium), expiry: BigInt(q.expiry), nonce: hexBytes(q.nonce) },
      ed25519Data: Uint8Array.from(Buffer.from(body.solana.ed25519Data, "base64")),
    };
  } else {
    // Price and sign here, as the quote service does.
    const quoterPath = process.env.QUOTER_KEYPAIR;
    if (!quoterPath) throw new Error("set QUOTER_KEYPAIR to the quoter's keypair file, or QUOTE_URL to the app's quote endpoint");
    const quoter = loadKeypair(quoterPath);
    if (quoter.publicKey.toBase58() !== d.quoter) throw new Error(`the vault's quoter is ${d.quoter}, not ${quoter.publicKey.toBase58()}`);
    const now = Math.floor(Date.now() / 1000);
    priced = priceQuote(now, { symbol: "TSLA", close: reference, history, annualVol: 0.6, holidays: new Set() }, protection);
    // A Solana keypair file holds the 32-byte seed followed by the public key.
    signed = signForSolana(priced, buyer.publicKey.toBase58(), { programId: PROGRAM_ID.toBase58(), vault: d.vault, feedId: d.feeds.TSLA.feedId }, quoter.secretKey.slice(0, 32));
  }
  console.log(`quote            1 TSLA share, $${priced.protection.upper} down to $${priced.protection.lower}, open ${new Date(priced.openTs * 1000).toISOString()}`);
  console.log(`premium          $${priced.premium.toFixed(4)} for up to $${priced.maxPayout.toFixed(2)} (${(priced.probabilityOfPayout * 100).toFixed(1)}% chance it pays)`);

  // Fund the buyer with TestUSD if it can mint and is short.
  const buyerToken = await getOrCreateAssociatedTokenAccount(connection, buyer, mint, buyer.publicKey);
  if (buyerToken.amount < signed.quote.premium) {
    const mintInfo = await getMint(connection, mint);
    if (!mintInfo.mintAuthority?.equals(buyer.publicKey)) throw new Error(`the buyer holds too little TestUSD (${buyerToken.amount} units)`);
    await mintTo(connection, buyer, mint, buyerToken.address, buyer, 1_000_000_000n);
  }

  const tx = new Transaction().add(
    ...(await buyInstructions(program, { buyer: buyer.publicKey, vault, collateralMint: mint, buyerToken: buyerToken.address, quote: signed.quote, ed25519Data: signed.ed25519Data })),
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [buyer], { commitment: "confirmed" });
  console.log(`bought           ${sig}`);

  const position = await program.account.position.fetch(positionAddress(vault, signed.quote.nonce));
  const v = await program.account.vault.fetch(vault);
  const held = (await getAccount(connection, new PublicKey(d.vaultToken))).amount;
  console.log(`position         premium ${position.premium.toString()} units, max payout ${position.maxPayout.toString()} units`);
  console.log(`vault            ${Number(held) / 1e6} TestUSD held, ${Number(v.locked.toString()) / 1e6} locked`);
  if (position.premium.toString() !== signed.quote.premium.toString()) throw new Error("the position's premium differs from the quote");
  const nft = await getAccount(connection, token2022Account(buyer.publicKey, position.mint), "confirmed", TOKEN_2022_PROGRAM_ID);
  console.log(`NFT              #${position.number.toString()}, mint ${position.mint.toBase58()}, held by the buyer`);
  if (nft.amount !== 1n) throw new Error("the buyer doesn't hold the position's NFT");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  if (e?.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
