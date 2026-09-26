/**
 * Buys protection end to end on a deployed EVM vault: a quote signed by the
 * quote service (or here), TestUSD minted if the buyer is short, approve and
 * `buy`, then the position read back.
 *
 *   BUYER_PRIVATE_KEY=0x… QUOTER_PRIVATE_KEY=0x… npx tsx evm/scripts/smoke-buy.ts
 *   BUYER_PRIVATE_KEY=0x… QUOTE_URL=http://localhost:3000/api/quote npx tsx evm/scripts/smoke-buy.ts
 *
 * RPC_URL      defaults to the deployment's RPC
 * DEPLOYMENTS  defaults to evm/deployments/robinhood.json
 *
 * Keys come from the environment and are only used to sign. It prices from
 * the last recorded close, so run it outside the session.
 */
import { readFileSync } from "node:fs";

import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import data from "../../research/data/pyth-tsla-gaps.json" with { type: "json" };
import type { Opening } from "../../pricing/model";
import type { EvmQuote } from "../../pricing/quote";
import { priceQuote, signForEvm, type PricedProtection } from "../../quoter/quoter";
import { afterbellVaultAbi, testUsdAbi } from "../client/abi";
import { buyProtection, mintTestUsd, robinhoodChain, type EvmDeployment } from "../client/vault";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name}`);
  return v;
}

async function main() {
  const d = JSON.parse(readFileSync(process.env.DEPLOYMENTS ?? "evm/deployments/robinhood.json", "utf8")) as EvmDeployment;
  const rpc = process.env.RPC_URL ?? d.rpc;
  const chain = { ...robinhoodChain, id: d.chainId };
  const buyer = privateKeyToAccount(required("BUYER_PRIVATE_KEY") as Hex);
  const client = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ chain, transport: http(rpc), account: buyer });

  const history = data.gaps as Opening[];
  const reference = history[history.length - 1]!.close;
  const protection = { shares: 1, upper: Math.round(reference * 0.98 * 100) / 100, lower: Math.round(reference * 0.9 * 100) / 100 };

  let priced: PricedProtection;
  let quote: EvmQuote;
  let signature: Hex;
  if (process.env.QUOTE_URL) {
    const res = await fetch(process.env.QUOTE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chain: "robinhood", buyer: buyer.address, ...protection }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`quote endpoint: ${body.error}`);
    if (body.evm.vault.toLowerCase() !== d.vault.toLowerCase()) throw new Error(`the quote is for vault ${body.evm.vault}, not ${d.vault}`);
    const q = body.evm.quote;
    priced = body.priced;
    quote = { ...q, openTs: BigInt(q.openTs), shares: BigInt(q.shares), upper: BigInt(q.upper), lower: BigInt(q.lower), premium: BigInt(q.premium), expiry: BigInt(q.expiry), nonce: BigInt(q.nonce) };
    signature = body.evm.signature;
  } else {
    priced = priceQuote(Math.floor(Date.now() / 1000), { symbol: "TSLA", close: reference, history, annualVol: 0.6, holidays: new Set() }, protection);
    const signed = await signForEvm(priced, buyer.address, { chainId: d.chainId, vault: d.vault, feed: d.feeds.TSLA }, required("QUOTER_PRIVATE_KEY") as Hex);
    quote = signed.quote;
    signature = signed.signature;
  }
  console.log(`quote            1 TSLA share, $${priced.protection.upper} down to $${priced.protection.lower}, open ${new Date(priced.openTs * 1000).toISOString()}`);
  console.log(`premium          $${priced.premium.toFixed(4)} for up to $${priced.maxPayout.toFixed(2)}`);

  const balance = await client.readContract({ address: d.testUsd, abi: testUsdAbi, functionName: "balanceOf", args: [buyer.address] });
  if (balance < quote.premium) await mintTestUsd(wallet, client, d, 1_000_000_000n);

  const { id, hash } = await buyProtection(wallet, client, d, quote, signature);
  console.log(`bought           position ${id} in ${hash}`);
  const p = await client.readContract({ address: d.vault, abi: afterbellVaultAbi, functionName: "positions", args: [id] });
  const locked = await client.readContract({ address: d.vault, abi: afterbellVaultAbi, functionName: "locked" });
  console.log(`position         premium ${p[6]} units, max payout ${p[7]} units; the vault has ${Number(locked) / 1e6} TestUSD locked`);
  if (p[6] !== quote.premium) throw new Error("the position's premium differs from the quote");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
