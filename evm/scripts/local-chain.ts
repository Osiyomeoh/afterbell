/**
 * A local chain for trying the EVM vault: anvil, a Chainlink-style feed, and
 * TestUSD and the vault set up as script/Deploy.s.sol sets them up. Shared by
 * `npm run evm:cycle` and `npm run evm:local`. Needs anvil and `forge build`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createPublicClient, createWalletClient, defineChain, http, type Abi, type Address, type Chain, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { afterbellVaultAbi, testUsdAbi } from "../client/abi";
import type { EvmDeployment } from "../client/vault";

/** Anvil's well-known test keys (public; they only ever hold test funds on a local chain). */
export const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
] as const;

export const mockFeedAbi = [
  { type: "function", name: "push", stateMutability: "nonpayable", inputs: [{ name: "answer", type: "int256" }, { name: "updatedAt", type: "uint256" }], outputs: [{ name: "id", type: "uint80" }] },
] as const;

const artifact = (file: string, name: string) => {
  const j = JSON.parse(readFileSync(join(import.meta.dirname, "..", "out", file, `${name}.json`), "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
};

/** Starts anvil on `port` and waits until it answers. */
export async function startAnvil(port: number): Promise<{ anvil: ChildProcess; chain: Chain; client: PublicClient; rpc: string }> {
  const rpc = `http://127.0.0.1:${port}`;
  const anvil = spawn("anvil", ["--port", String(port), "--silent"], { stdio: "ignore" });
  const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const client = createPublicClient({ chain, transport: http(rpc) });
  for (let i = 0; ; i++) {
    try {
      await client.getChainId();
      return { anvil, chain, client, rpc };
    } catch {
      if (i > 30) throw new Error("anvil didn't start");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/**
 * Deploys a MockFeed, TestUSD and the vault (owned by `ownerKey`, quoted by
 * `quoter`), allows the feed and seeds 100,000 TestUSD, as Deploy.s.sol does.
 */
export async function deployLocalVault(chain: Chain, client: PublicClient, rpc: string, ownerKey: Hex, quoter: Address): Promise<EvmDeployment> {
  const owner = createWalletClient({ chain, transport: http(rpc), account: privateKeyToAccount(ownerKey) });
  const mined = async (hash: Hex) => {
    const r = await client.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`reverted: ${hash}`);
    return r;
  };
  const deploy = async (a: { abi: Abi; bytecode: Hex }, args: unknown[] = []) =>
    (await mined(await owner.deployContract({ abi: a.abi, bytecode: a.bytecode, args }))).contractAddress!;

  const feed = await deploy(artifact("MockFeed.sol", "MockFeed"), [8]);
  const usd = await deploy(artifact("TestUSD.sol", "TestUSD"));
  const vault = await deploy(artifact("AfterbellVault.sol", "AfterbellVault"), [usd, owner.account.address, quoter, 3n * 86_400n, 86_400n]);
  await mined(await owner.writeContract({ address: vault, abi: afterbellVaultAbi, functionName: "allowFeed", args: [feed, true] }));
  for (let i = 0; i < 10; i++) await mined(await owner.writeContract({ address: usd, abi: testUsdAbi, functionName: "mint", args: [owner.account.address, 10_000_000_000n] }));
  await mined(await owner.writeContract({ address: usd, abi: testUsdAbi, functionName: "approve", args: [vault, 100_000_000_000n] }));
  await mined(await owner.writeContract({ address: vault, abi: afterbellVaultAbi, functionName: "deposit", args: [100_000_000_000n] }));
  return { chainId: chain.id, rpc, vault, testUsd: usd, owner: owner.account.address, quoter, feeds: { TSLA: feed } };
}
