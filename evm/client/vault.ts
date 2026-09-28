/**
 * TypeScript client for the EVM vault (evm/src/AfterbellVault.sol) on
 * Robinhood Chain, with viem. `abi.ts` is generated from forge's build
 * output (npm run evm:abi).
 */
import {
  decodeEventLog,
  defineChain,
  parseSignature,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";

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
  /** The positions' NFT contract, which the vault deploys. */
  positions: Address;
  testUsd: Address;
  owner: Address;
  quoter: Address;
  /** Chainlink feed per stock symbol; Robinhood Chain sells only the stocks listed. */
  feeds: { TSLA: Address } & Partial<Record<string, Address>>;
};

/** A position as `AfterbellVault.position(id)` returns it. */
export type EvmPosition = {
  buyer: Address;
  feed: Address;
  openTs: bigint;
  shares: bigint;
  upper: bigint;
  lower: bigint;
  premium: bigint;
  maxPayout: bigint;
  tip: bigint;
  paid: bigint;
  closed: boolean;
};

/** A series as `AfterbellVault.series(key)` returns it: state 0 open, 1 settled, 2 voided. */
export type EvmSeries = {
  state: number;
  price: bigint;
  roundId: bigint;
  lowestLower: bigint;
  highestUpper: bigint;
  locked: bigint;
  processed: number;
};

type Wallet = WalletClient<Transport, Chain, Account>;

const mined = async (client: PublicClient, hash: Hex, what: string) => {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${what} reverted (${hash})`);
  return receipt;
};

/** An EIP-2612 permit from the wallet for the vault to take `value` TestUSD, valid for ten minutes. */
/** The two addresses a purchase or deposit needs: a quote response carries them too. */
export type VaultAddresses = Pick<EvmDeployment, "vault" | "testUsd">;

export async function signPermit(wallet: Wallet, client: PublicClient, d: VaultAddresses, value: bigint) {
  const owner = wallet.account.address;
  const [[, name, version, chainId, verifyingContract], nonce] = await Promise.all([
    client.readContract({ address: d.testUsd, abi: testUsdAbi, functionName: "eip712Domain" }),
    client.readContract({ address: d.testUsd, abi: testUsdAbi, functionName: "nonces", args: [owner] }),
  ]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const signature = await wallet.signTypedData({
    account: wallet.account,
    domain: { name, version, chainId, verifyingContract },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: { owner, spender: d.vault, value, nonce, deadline },
  });
  const { r, s, v, yParity } = parseSignature(signature);
  return { deadline, v: Number(v ?? BigInt(yParity + 27)), r, s };
}

/**
 * Buys protection with a quote the quoter signed, in one transaction: the
 * wallet signs a permit for the premium and the vault takes it with the buy.
 * Returns the position id, which is also its NFT's token id.
 */
export async function buyProtection(
  wallet: Wallet,
  client: PublicClient,
  d: VaultAddresses,
  quote: EvmQuote,
  signature: Hex,
): Promise<{ id: bigint; hash: Hex }> {
  const p = await signPermit(wallet, client, d, quote.premium);
  const hash = await wallet.writeContract({
    address: d.vault,
    abi: afterbellVaultAbi,
    functionName: "buyWithPermit",
    args: [quote, signature, p.deadline, p.v, p.r, p.s],
  });
  const receipt = await mined(client, hash, "the purchase");
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== d.vault.toLowerCase()) continue;
    const event = decodeEventLog({ abi: afterbellVaultAbi, data: log.data, topics: log.topics });
    if (event.eventName === "ProtectionBought") return { id: event.args.id, hash };
  }
  throw new Error(`no ProtectionBought event in ${hash}`);
}

/** TestUSD has no value and anyone may mint it, up to 10,000 per call. */
export async function mintTestUsd(wallet: Wallet, client: PublicClient, d: VaultAddresses, amount: bigint): Promise<Hex> {
  const hash = await wallet.writeContract({ address: d.testUsd, abi: testUsdAbi, functionName: "mint", args: [wallet.account.address, amount] });
  await mined(client, hash, "the mint");
  return hash;
}

/** Pays one finished position to whoever holds its NFT; anyone may, and the caller gets the keeper's tip. */
export async function claimProtection(wallet: Wallet, client: PublicClient, d: EvmDeployment, id: bigint): Promise<Hex> {
  const hash = await wallet.writeContract({ address: d.vault, abi: afterbellVaultAbi, functionName: "claim", args: [id] });
  await mined(client, hash, "the claim");
  return hash;
}

// ------------------------------------------------------------------ the pool

/** Asks to put `assets` TestUSD into the pool at the next roll (one transaction, with a permit). */
export async function requestDeposit(wallet: Wallet, client: PublicClient, d: EvmDeployment, assets: bigint): Promise<Hex> {
  const p = await signPermit(wallet, client, d, assets);
  const hash = await wallet.writeContract({
    address: d.vault,
    abi: afterbellVaultAbi,
    functionName: "requestDepositWithPermit",
    args: [assets, wallet.account.address, p.deadline, p.v, p.r, p.s],
  });
  await mined(client, hash, "the deposit request");
  return hash;
}

/** Asks to take `shares` out of the pool at the next roll. */
export async function requestRedeem(wallet: Wallet, client: PublicClient, d: EvmDeployment, shares: bigint): Promise<Hex> {
  const me = wallet.account.address;
  const hash = await wallet.writeContract({ address: d.vault, abi: afterbellVaultAbi, functionName: "requestRedeem", args: [shares, me, me] });
  await mined(client, hash, "the redemption request");
  return hash;
}

/** Claims what the last roll filled: the shares a deposit bought and the assets a redemption is owed. */
export async function claimFilled(wallet: Wallet, client: PublicClient, d: EvmDeployment): Promise<{ shares: bigint; assets: bigint; hashes: Hex[] }> {
  const me = wallet.account.address;
  const vault = { address: d.vault, abi: afterbellVaultAbi } as const;
  const [depositAssets, redeemShares, shares, assets] = await Promise.all([
    client.readContract({ ...vault, functionName: "maxDeposit", args: [me] }),
    client.readContract({ ...vault, functionName: "maxRedeem", args: [me] }),
    client.readContract({ ...vault, functionName: "maxMint", args: [me] }),
    client.readContract({ ...vault, functionName: "maxWithdraw", args: [me] }),
  ]);
  const hashes: Hex[] = [];
  if (depositAssets > 0n) {
    const hash = await wallet.writeContract({ ...vault, functionName: "deposit", args: [depositAssets, me, me] });
    hashes.push((await mined(client, hash, "the share claim")).transactionHash);
  }
  if (redeemShares > 0n) {
    const hash = await wallet.writeContract({ ...vault, functionName: "redeem", args: [redeemShares, me, me] });
    hashes.push((await mined(client, hash, "the withdrawal")).transactionHash);
  }
  return { shares: depositAssets > 0n ? shares : 0n, assets: redeemShares > 0n ? assets : 0n, hashes };
}
