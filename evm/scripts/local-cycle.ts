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
import { createTestClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { signForEvm, type PricedProtection } from "../../quoter/quoter";
import { afterbellVaultAbi, testUsdAbi } from "../client/abi";
import { buyProtection } from "../client/vault";
import { runEvmKeeper } from "../keeper/keeper";
import { ANVIL_KEYS as KEYS, deployLocalVault, mockFeedAbi, startAnvil } from "./local-chain";

const PORT = 8546;

function check(ok: boolean, what: string) {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok  ${what}`);
}

async function main() {
  const { anvil, chain, client, rpc: RPC } = await startAnvil(PORT);
  try {
    const test = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
    await test.setBlockTimestampInterval({ interval: 1 });
    const [owner, , alice, bob, keeper] = KEYS.map((k) => createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(k) }));
    const mined = async (hash: Hex) => {
      const r = await client.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error(`reverted: ${hash}`);
      return r;
    };

    // The vault as script/Deploy.s.sol deploys it, on a replaying feed.
    const d = await deployLocalVault(chain, client, RPC, KEYS[0], privateKeyToAccount(KEYS[1]).address);
    const { vault, testUsd: usd } = d;
    const feed = d.feeds.TSLA;

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
