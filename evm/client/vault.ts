/**
 * TypeScript client for the EVM vault (evm/src/AfterbellVault.sol) on
 * Robinhood Chain, with viem. `abi.ts` is generated from forge's build
 * output (npm run evm:abi).
 */
import { decodeEventLog, defineChain, type Account, type Address, type Chain, type Hex, type PublicClient, type Transport, type WalletClient } from "viem";

import type { EvmQuote } from "../../pricing/quote";
import { afterbellVaultAbi, testUsdAbi } from "./abi";

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});

/** The chain a deployment lives on: Robinhood Chain, or a local test chain, at the deployment's RPC. */
export function evmChain(d: Pick<EvmDeployment, "chainId" | "rpc">): Chain {
  if (d.chainId === robinhoodChain.id) return { ...robinhoodChain, rpcUrls: { default: { http: [d.rpc] } } };
  return defineChain({ id: d.chainId, name: `Local chain ${d.chainId}`, nativeCurrency: robinhoodChain.nativeCurrency, rpcUrls: { default: { http: [d.rpc] } } });
}

/** Chainlink's Robinhood TSLA / USD feed (proxy) on Robinhood Chain mainnet. */
export const TSLA_FEED: Address = "0x4A1166a659A55625345e9515b32adECea5547C38";

/** A deployment record, as evm/deployments/<name>.json holds it. */
export type EvmDeployment = {
  chainId: number;
  rpc: string;
  vault: Address;
  testUsd: Address;
  owner: Address;
  quoter: Address;
  /** Chainlink feed per stock symbol; Robinhood Chain sells only the stocks listed. */
  feeds: { TSLA: Address } & Partial<Record<string, Address>>;
};

type Wallet = WalletClient<Transport, Chain, Account>;

/**
 * Buys protection with a quote the quoter signed: approves the premium in
 * TestUSD if needed, then calls `buy`. Returns the position id.
 */
export async function buyProtection(
  wallet: Wallet,
  client: PublicClient,
  d: EvmDeployment,
  quote: EvmQuote,
  signature: Hex,
): Promise<{ id: bigint; hash: Hex }> {
  const owner = wallet.account.address;
  const allowance = await client.readContract({ address: d.testUsd, abi: testUsdAbi, functionName: "allowance", args: [owner, d.vault] });
  if (allowance < quote.premium) {
    const approve = await wallet.writeContract({ address: d.testUsd, abi: testUsdAbi, functionName: "approve", args: [d.vault, quote.premium] });
    await client.waitForTransactionReceipt({ hash: approve });
  }
  const hash = await wallet.writeContract({ address: d.vault, abi: afterbellVaultAbi, functionName: "buy", args: [quote, signature] });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`the purchase reverted (${hash})`);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== d.vault.toLowerCase()) continue;
    const event = decodeEventLog({ abi: afterbellVaultAbi, data: log.data, topics: log.topics });
    if (event.eventName === "ProtectionBought") return { id: event.args.id, hash };
  }
  throw new Error(`no ProtectionBought event in ${hash}`);
}

/** TestUSD has no value and anyone may mint it, up to 10,000 per call. */
export async function mintTestUsd(wallet: Wallet, client: PublicClient, d: EvmDeployment, amount: bigint): Promise<Hex> {
  const hash = await wallet.writeContract({ address: d.testUsd, abi: testUsdAbi, functionName: "mint", args: [wallet.account.address, amount] });
  await client.waitForTransactionReceipt({ hash });
  return hash;
}

/** Claims a finished position; anyone may, and the money always goes to its buyer. */
export async function claimProtection(wallet: Wallet, client: PublicClient, d: EvmDeployment, id: bigint): Promise<Hex> {
  const hash = await wallet.writeContract({ address: d.vault, abi: afterbellVaultAbi, functionName: "claim", args: [id] });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`the claim reverted (${hash})`);
  return hash;
}
