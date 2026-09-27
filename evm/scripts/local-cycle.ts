/**
 * A whole round of the EVM vault, on a local chain: deploys the vault and a
 * Chainlink-style feed that replays how TSLA's real feed published around
 * Friday 25 September's open (round 1340 at 23:25 before the bell, round 1341
 * at $383.8284 3:12 before it, round 1342 2:18 after), and underwrites the
 * pool. Then two positions sell, one NFT changes hands and an underwriter
 * queues a deposit before the bell; after it the keeper must settle on the
 * round in force, pay each position to whoever holds its NFT what the
 * contract's math says, collect its tips, and roll the pool, filling the
 * deposit at the pool's value after the night.
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
import { afterbellPositionsAbi, afterbellVaultAbi, testUsdAbi } from "../client/abi";
import { buyProtection, claimFilled, requestDeposit, type EvmSeries } from "../client/vault";
import { evmVault } from "../../hedger/evm";
import { planEvmKeeper, runEvmKeeper } from "../keeper/keeper";
import { ANVIL_KEYS as KEYS, deployLocalVault, mockFeedAbi, startAnvil } from "./local-chain";

const PORT = 8546;
const POOL = 100_000_000_000n;

function check(ok: boolean, what: string) {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok  ${what}`);
}

async function main() {
  const { anvil, chain, client, rpc: RPC } = await startAnvil(PORT);
  try {
    const test = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
    await test.setBlockTimestampInterval({ interval: 1 });
    const [owner, , alice, bob, keeper, carol, dave] = KEYS.map((k) => createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(k) }));
    const mined = async (hash: Hex) => {
      const r = await client.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error(`reverted: ${hash}`);
      return r;
    };

    // The vault as script/Deploy.s.sol deploys it, on a replaying feed, with 100,000 TestUSD underwritten.
    const d = await deployLocalVault(chain, client, RPC, KEYS[0], privateKeyToAccount(KEYS[1]).address);
    const { vault, testUsd: usd } = d;
    const feed = d.feeds.TSLA;
    const read = <T,>(functionName: string, args: unknown[] = []) => client.readContract({ address: vault, abi: afterbellVaultAbi, functionName, args } as never) as Promise<T>;
    check((await read<bigint>("totalAssets")) === POOL && (await read<bigint>("balanceOf", [owner!.account.address])) === POOL, "the pool holds 100,000 TestUSD, and its underwriter 100,000 shares");

    // The open is 5 minutes away; the feed has published as TSLA's did before Friday's bell.
    const open = (await client.getBlock()).timestamp + 300n;
    await mined(await owner!.writeContract({ address: feed, abi: mockFeedAbi, functionName: "push", args: [38_184_500_000n, open - 1_405n] }));
    await mined(await owner!.writeContract({ address: feed, abi: mockFeedAbi, functionName: "push", args: [38_382_840_000n, open - 192n] }));

    // Two sales on that open, each in one transaction with a permit: Alice's pays below $390, Bob's only below $380.
    const mint = async (who: typeof alice, units: bigint) =>
      mined(await who!.writeContract({ address: usd, abi: testUsdAbi, functionName: "mint", args: [who!.account.address, units] }));
    const sell = async (buyer: typeof alice, shares: number, upper: number, lower: number, premium: number) => {
      await mint(buyer, 1_000_000_000n);
      const now = Number((await client.getBlock()).timestamp);
      const priced = { protection: { shares, upper, lower }, openTs: Number(open), expiry: now + 60, premium } as PricedProtection;
      const { quote, signature } = await signForEvm(priced, buyer!.account.address, { chainId: 31337, vault, feed }, KEYS[1]);
      return (await buyProtection(buyer!, client, d, quote, signature)).id;
    };
    const aliceId = await sell(alice, 2, 390, 370, 3);
    const bobId = await sell(bob, 1, 380, 360, 1);
    const holder = (id: bigint) => client.readContract({ address: d.positions, abi: afterbellPositionsAbi, functionName: "ownerOf", args: [id] });
    check((await holder(aliceId)) === alice!.account.address && (await holder(bobId)) === bob!.account.address, `sold positions ${aliceId} and ${bobId}, each an NFT held by its buyer`);
    const hedged = evmVault("Robinhood Chain", client, d);
    const exposed = await hedged.read();
    check(
      JSON.stringify(exposed) === JSON.stringify([2, 1].map((shares, i) => ({ symbol: "TSLA", openTs: Number(open), shares, upper: [390, 380][i], lower: [370, 360][i] }))),
      "the hedger reads both as open TSLA protection: 2 shares from $390 to $370, 1 from $380 to $360",
    );

    // Before the bell, Alice sells her position to Carol, and Dave asks to underwrite 1,000.
    await mined(await alice!.writeContract({ address: d.positions, abi: afterbellPositionsAbi, functionName: "transferFrom", args: [alice!.account.address, carol!.account.address, aliceId] }));
    check((await holder(aliceId)) === carol!.account.address, "Alice's NFT now belongs to Carol");
    await mint(dave, 1_000_000_000n);
    await requestDeposit(dave!, client, d, 1_000_000_000n);
    check((await read<bigint>("pendingDepositRequest", [0n, dave!.account.address])) === 1_000_000_000n, "Dave's 1,000 waits for the roll, out of the pool's risk until then");

    const balance = (who: typeof alice) => client.readContract({ address: usd, abi: testUsdAbi, functionName: "balanceOf", args: [who!.account.address] });
    const [aliceBefore, bobBefore, carolBefore, keeperBefore] = [await balance(alice), await balance(bob), await balance(carol), await balance(keeper)];

    // Before the bell, the plan waits and knows only each position's cap.
    const early = await planEvmKeeper({ client, deployment: d });
    check(early.series.length === 1 && early.series[0]!.action === "wait" && early.series[0]!.positions.every((p) => p.units === undefined), "before the open, the plan waits");
    check(early.series[0]!.positions.reduce((a, p) => a + p.maxUnits, 0n) === 60_000_000n, "the plan caps the payouts at 60 TestUSD: 2 × $20 + 1 × $20");
    check(early.rollBlocked?.includes("sells until its open") === true, "and the pool can't roll while the round is selling");

    // The bell rings, and 2:18 later the feed publishes its next round.
    await test.setNextBlockTimestamp({ timestamp: open + 138n });
    await mined(await owner!.writeContract({ address: feed, abi: mockFeedAbi, functionName: "push", args: [38_076_000_000n, open + 138n] }));
    await test.mine({ blocks: 1 });

    // After it, the plan names the round and each payout, the contract accepts the settle in simulation, and nothing is sent.
    const plan = await planEvmKeeper({ client, deployment: d });
    const [planned] = plan.series;
    check(planned?.action === "settle" && planned.round?.price === 383.8284 && planned.note === undefined, "the plan would settle on the round in force ($383.8284), and the contract accepts it in simulation");
    check(planned!.positions.find((p) => p.id === aliceId)?.holder === carol!.account.address, "the plan pays Alice's position to Carol, who holds it");
    check(plan.rollBlocked === null, "the plan would roll the pool after paying out");
    const plannedUnits = new Map(planned!.positions.map((p) => [p.id, p.units]));
    const key = await read<Hex>("seriesKey", [feed, open]);
    check((await read<EvmSeries>("series", [key])).state === 0 && (await balance(carol)) === carolBefore, "planning sent nothing: the series is open, Carol unpaid");

    const report = await runEvmKeeper({ client, wallet: keeper!, deployment: d, log: (l) => console.log(`    keeper: ${l}`) });
    check(report.settled.length === 1 && report.settled[0]!.price === 383.8284, "the keeper settled on the round in force at the open ($383.8284), not the one after it");
    const s = await read<EvmSeries>("series", [key]);
    check(s.state === 1 && s.price === 38_382_840_000n, "the contract recorded the series settled at $383.8284");
    check((await balance(carol)) - carolBefore === 12_343_200n && (await balance(alice)) === aliceBefore, "Carol, holding Alice's NFT, received exactly 12.3432 TestUSD: 2 shares × ($390 − $383.8284)");
    check((await balance(bob)) - bobBefore === 0n, "Bob received nothing: $383.83 is above his $380 strike");
    check(report.paid.length === plannedUnits.size && report.paid.every((c) => plannedUnits.get(c.id) === c.units), "the keeper paid exactly what the plan said it would");
    check(report.tips === 80_000n && (await balance(keeper)) - keeperBefore === 80_000n, "the vault paid the keeper 0.08 TestUSD in tips: 2% of the 4 in premiums");
    check((await read<bigint>("locked")) === 0n && (await read<bigint>("tipsOwed")) === 0n, "nothing is locked or owed any more");
    check((await hedged.read()).length === 0, "and the hedger reads nothing open");

    // The roll: the pool kept the premiums less the payout and the tips, and Dave's deposit buys shares at that value.
    check(report.rolled?.round === 2n && (await read<bigint>("round")) === 3n, "the keeper rolled the pool from round 2 into round 3");
    const nav = POOL + 4_000_000n - 80_000n - 12_343_200n;
    const daveShares = (1_000_000_000n * (POOL + 1n)) / (nav + 1n);
    check((await read<bigint>("totalAssets")) === nav + 1_000_000_000n, "the pool is worth 99,991.5768 after the night (premiums 4, tips 0.08, payout 12.3432), plus Dave's 1,000");
    check((await read<bigint>("maxMint", [dave!.account.address])) === daveShares, `Dave's 1,000 bought ${Number(daveShares) / 1e6} shares at the pool's value after the night`);
    const filled = await claimFilled(dave!, client, d);
    check(filled.shares === daveShares && (await read<bigint>("balanceOf", [dave!.account.address])) === daveShares, "Dave claimed them");

    // The NFT shows the payout, drawn on-chain.
    const uri = await client.readContract({ address: d.positions, abi: afterbellPositionsAbi, functionName: "tokenURI", args: [aliceId] });
    const meta = JSON.parse(Buffer.from(uri.split(",")[1]!, "base64").toString());
    const svg = Buffer.from(meta.image.split(",")[1], "base64").toString();
    check(svg.includes("TSLA") && svg.includes("Opened at $383.83") && svg.includes("paid $12.34"), "Carol's NFT reads TSLA, opened at $383.83, paid $12.34");

    const again = await runEvmKeeper({ client, wallet: keeper!, deployment: d });
    check(again.settled.length + again.paid.length + again.voided.length === 0 && again.rolled === null, "a second keeper run finds nothing to do");
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
