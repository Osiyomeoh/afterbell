/**
 * A whole protection cycle on the EVM vault, on a local chain: deploys the
 * vault and a Chainlink-style feed that replays how TSLA's real feed
 * published around Friday 25 September's open (round 1340 at 23:25 before
 * the bell, round 1341 at $383.8284 3:12 before it, round 1342 2:18 after),
 * sells two positions, rings the bell, and runs the keeper, which must settle
 * on the round in force and pay each buyer what the contract's math says.
 *
 * The public Robinhood Chain RPC keeps no historical state, so a fork at that
 * morning isn't possible; `npx tsx evm/scripts/check-round.ts` checks the
 * keeper picks round 1341 on the real feed, and the forge fork tests settle
 * the contract on it.
 *
 *   npm run evm:cycle      (needs anvil and `forge build`)
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createPublicClient, createTestClient, createWalletClient, defineChain, http, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { signForEvm, type PricedProtection } from "../../quoter/quoter";
import { afterbellVaultAbi, testUsdAbi } from "../client/abi";
import { buyProtection, type EvmDeployment } from "../client/vault";
import { runEvmKeeper } from "../keeper/keeper";

const PORT = 8546;
const RPC = `http://127.0.0.1:${PORT}`;
// Anvil's well-known test keys: owner, quoter, Alice, Bob, keeper.
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
] as const;
const mockFeedAbi = [
  { type: "function", name: "push", stateMutability: "nonpayable", inputs: [{ name: "answer", type: "int256" }, { name: "updatedAt", type: "uint256" }], outputs: [{ name: "id", type: "uint80" }] },
] as const;

function check(ok: boolean, what: string) {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok  ${what}`);
}

const artifact = (file: string, name: string) => {
  const j = JSON.parse(readFileSync(join(import.meta.dirname, "..", "out", file, `${name}.json`), "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
};

async function main() {
  const anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  try {
    const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
    const client = createPublicClient({ chain, transport: http(RPC) });
    for (let i = 0; ; i++) {
      try {
        await client.getChainId();
        break;
      } catch {
        if (i > 30) throw new Error("anvil didn't start");
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const test = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
    await test.setBlockTimestampInterval({ interval: 1 });
    const [owner, , alice, bob, keeper] = KEYS.map((k) => createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(k) }));
    const quoterAddress = privateKeyToAccount(KEYS[1]).address;
    const mined = async (hash: Hex) => {
      const r = await client.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error(`reverted: ${hash}`);
      return r;
    };
    const deploy = async (a: { abi: Abi; bytecode: Hex }, args: unknown[] = []) => (await mined(await owner!.deployContract({ abi: a.abi, bytecode: a.bytecode, args }))).contractAddress!;

    // The vault as script/Deploy.s.sol deploys it, on a replaying feed.
    const feed = await deploy(artifact("MockFeed.sol", "MockFeed"), [8]);
    const usd = await deploy(artifact("TestUSD.sol", "TestUSD"));
    const vault = await deploy(artifact("AfterbellVault.sol", "AfterbellVault"), [usd, owner!.account.address, quoterAddress, 3n * 86_400n, 86_400n]);
    const d: EvmDeployment = { chainId: 31337, rpc: RPC, vault, testUsd: usd, owner: owner!.account.address, quoter: quoterAddress, feeds: { TSLA: feed } };
    await mined(await owner!.writeContract({ address: vault, abi: afterbellVaultAbi, functionName: "allowFeed", args: [feed, true] }));
    for (let i = 0; i < 10; i++) await mined(await owner!.writeContract({ address: usd, abi: testUsdAbi, functionName: "mint", args: [owner!.account.address, 10_000_000_000n] }));
    await mined(await owner!.writeContract({ address: usd, abi: testUsdAbi, functionName: "approve", args: [vault, 100_000_000_000n] }));
    await mined(await owner!.writeContract({ address: vault, abi: afterbellVaultAbi, functionName: "deposit", args: [100_000_000_000n] }));

    // The open is 5 minutes away; the feed has published as TSLA's did before Friday's bell.
    const open = (await client.getBlock()).timestamp + 300n;
    await mined(await owner!.writeContract({ address: feed, abi: mockFeedAbi, functionName: "push", args: [38_184_500_000n, open - 1_405n] }));
    await mined(await owner!.writeContract({ address: feed, abi: mockFeedAbi, functionName: "push", args: [38_382_840_000n, open - 192n] }));

    // Two sales on that open: Alice's pays below $390, Bob's only below $380.
    const sell = async (buyer: typeof alice, shares: number, upper: number, lower: number, premium: number) => {
      await mined(await buyer!.writeContract({ address: usd, abi: testUsdAbi, functionName: "mint", args: [buyer!.account.address, 1_000_000_000n] }));
      const now = Number((await client.getBlock()).timestamp);
      const priced = { protection: { shares, upper, lower }, openTs: Number(open), expiry: now + 60, premium } as PricedProtection;
      const { quote, signature } = await signForEvm(priced, buyer!.account.address, { chainId: 31337, vault, feed }, KEYS[1]);
      return (await buyProtection(buyer!, client, d, quote, signature)).id;
    };
    const aliceId = await sell(alice, 2, 390, 370, 3);
    const bobId = await sell(bob, 1, 380, 360, 1);
    check(true, `sold positions ${aliceId} and ${bobId}`);
    const balance = (who: typeof alice) => client.readContract({ address: usd, abi: testUsdAbi, functionName: "balanceOf", args: [who!.account.address] });
    const [aliceBefore, bobBefore] = [await balance(alice), await balance(bob)];

    // The bell rings, and 2:18 later the feed publishes its next round.
    await test.setNextBlockTimestamp({ timestamp: open + 138n });
    await mined(await owner!.writeContract({ address: feed, abi: mockFeedAbi, functionName: "push", args: [38_076_000_000n, open + 138n] }));
    await test.mine({ blocks: 1 });

    const report = await runEvmKeeper({ client, wallet: keeper!, deployment: d, log: (l) => console.log(`    keeper: ${l}`) });
    check(report.settled.length === 1 && report.settled[0]!.price === 383.8284, "the keeper settled on the round in force at the open ($383.8284), not the one after it");
    const key = await client.readContract({ address: vault, abi: afterbellVaultAbi, functionName: "seriesKey", args: [feed, open] });
    const [state, price] = await client.readContract({ address: vault, abi: afterbellVaultAbi, functionName: "series", args: [key] });
    check(state === 1 && price === 38_382_840_000n, "the contract recorded the series settled at $383.8284");
    check((await balance(alice)) - aliceBefore === 12_343_200n, "Alice received exactly 12.3432 TestUSD: 2 shares × ($390 − $383.8284)");
    check((await balance(bob)) - bobBefore === 0n, "Bob received nothing: $383.83 is above his $380 strike");
    check((await client.readContract({ address: vault, abi: afterbellVaultAbi, functionName: "locked" })) === 0n, "nothing is locked any more");
    const again = await runEvmKeeper({ client, wallet: keeper!, deployment: d });
    check(again.settled.length + again.claimed.length + again.voided.length === 0, "a second keeper run finds nothing to do");
    console.log("PASS");
  } finally {
    anvil.kill();
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
