import { useCallback, useEffect, useState } from "react";
import { createPublicClient, createWalletClient, custom, http, numberToHex, type Address, type EIP1193Provider, type Hex } from "viem";

import { testUsdAbi } from "@root/evm/client/abi";
import { buyProtection, claimProtection, evmChain, mintTestUsd, robinhoodChain, type EvmDeployment } from "@root/evm/client/vault";
import type { EvmQuote } from "@root/pricing/quote";

import type { EvmQuoteResponse } from "./api";

/**
 * Buying and claiming on Robinhood Chain with whatever EVM wallet the browser
 * has injected (MetaMask, Rabby, Coinbase Wallet…), through viem.
 */

export class NoEvmWallet extends Error {}
export class NeedsGas extends Error {}

const injected = () => (typeof window === "undefined" ? undefined : (window as unknown as { ethereum?: EIP1193Provider }).ethereum);

function provider(): EIP1193Provider {
  const p = injected();
  if (!p) throw new NoEvmWallet("No EVM wallet found. Install MetaMask, Rabby or another browser wallet, then reload.");
  return p;
}

/** The connected account, kept current as the wallet switches accounts. */
export function useEvmWallet() {
  const [address, setAddress] = useState<Address | null>(null);
  useEffect(() => {
    const p = injected();
    if (!p) return;
    p.request({ method: "eth_accounts" }).then((a) => setAddress(a[0] ?? null), () => {});
    const onChange = (a: readonly Address[]) => setAddress(a[0] ?? null);
    p.on?.("accountsChanged", onChange);
    return () => p.removeListener?.("accountsChanged", onChange);
  }, []);
  const connect = useCallback(async () => {
    const [a] = await provider().request({ method: "eth_requestAccounts" });
    if (!a) throw new NoEvmWallet("The wallet didn't share an account.");
    setAddress(a);
    return a;
  }, []);
  return { address, connect };
}

/** Switches the wallet to the vault's chain, adding it first if the wallet doesn't know it. */
async function switchChain(d: EvmDeployment) {
  const p = provider();
  const chainId = numberToHex(d.chainId);
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    const chain = evmChain(d);
    await p.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: [d.rpc],
          blockExplorerUrls: d.chainId === robinhoodChain.id ? [robinhoodChain.blockExplorers.default.url] : undefined,
        },
      ],
    });
  }
}

function clients(account: Address, d: EvmDeployment) {
  const chain = evmChain(d);
  return {
    wallet: createWalletClient({ account, chain, transport: custom(provider()) }),
    client: createPublicClient({ chain, transport: http(d.rpc) }),
  };
}

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

/** TestUSD is minted in 1,000s when the buyer is short; anyone may mint it, since it has no value. */
const MINT = 1_000_000_000n;

/**
 * Buys the quoted protection: switches to the vault's chain, mints TestUSD if
 * the buyer has too little, then approves and buys. Each step the wallet must
 * confirm is reported through `onStep`.
 */
export async function buyOnRobinhood(account: Address, d: EvmDeployment, r: EvmQuoteResponse, onStep: (step: string) => void): Promise<{ id: bigint; hash: Hex }> {
  onStep("Switch to Robinhood Chain in your wallet");
  await switchChain(d);
  const { wallet, client } = clients(account, d);
  if ((await client.getBalance({ address: account })) === 0n) {
    throw new NeedsGas("This wallet has no ETH on Robinhood Chain to pay gas. A purchase costs about $0.05 in ETH.");
  }
  const quote = toEvmQuote(r.evm.quote);
  const balance = await client.readContract({ address: d.testUsd, abi: testUsdAbi, functionName: "balanceOf", args: [account] });
  if (balance < quote.premium) {
    onStep("Mint 1,000 TestUSD: confirm in your wallet");
    await mintTestUsd(wallet, client, d, MINT);
  }
  onStep("Approve and buy: confirm in your wallet");
  return buyProtection(wallet, client, d, quote, r.evm.signature as Hex);
}

export async function claimOnRobinhood(account: Address, d: EvmDeployment, id: bigint): Promise<Hex> {
  await switchChain(d);
  const { wallet, client } = clients(account, d);
  return claimProtection(wallet, client, d, id);
}

/** A transaction on Robinhood Chain's explorer; none for a local test chain. */
export const evmTxUrl = (d: Pick<EvmDeployment, "chainId">, hash: string) =>
  d.chainId === robinhoodChain.id ? `${robinhoodChain.blockExplorers.default.url}/tx/${hash}` : null;
export const evmAddressUrl = (d: Pick<EvmDeployment, "chainId">, address: string) =>
  d.chainId === robinhoodChain.id ? `${robinhoodChain.blockExplorers.default.url}/address/${address}` : null;
