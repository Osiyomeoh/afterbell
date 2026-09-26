import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";

import { afterbellPositionsAbi, afterbellVaultAbi, testUsdAbi } from "@root/evm/client/abi";
import { evmChain, type EvmDeployment, type EvmPosition, type EvmSeries } from "@root/evm/client/vault";
import { chainlinkReader } from "@root/evm/keeper/keeper";
import { claimUnits } from "@root/solana/keeper/plan";

import type { PoolState, PositionRow, SeriesRow, VaultState } from "./chain";
import { evmDeployment } from "./evmDeployment";
import type { LedgerRow } from "./ledger";

type EvmVaultState = VaultState & { ledger: LedgerRow[]; pool: PoolState };

// The contract's SeriesState enum, in order.
const STATES = ["open", "settled", "voided"] as const;

const TTL_MS = 10_000;
let cache: { at: number; state: Promise<EvmVaultState> } | null = null;

/**
 * The Robinhood Chain vault in the same shape as the Solana one: its series
 * and unpaid positions (each under whoever holds its NFT, who is paid), its
 * ledger (paid positions stay on-chain here, so what each series paid comes
 * straight from state), and its underwriters' pool. Shared by every visitor
 * and refreshed at most every 10 seconds. Null until deployed.
 */
export function evmVaultState(): Promise<EvmVaultState> | null {
  const d = evmDeployment();
  if (!d) return null;
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const state = load(d);
    cache = { at: Date.now(), state };
    state.catch(() => (cache = null));
  }
  return cache.state;
}

async function load(d: EvmDeployment): Promise<EvmVaultState> {
  const client = createPublicClient({ chain: evmChain(d), transport: http(d.rpc) });
  const vault = { address: d.vault, abi: afterbellVaultAbi } as const;
  const [next, locked, held, decimals, pool] = await Promise.all([
    client.readContract({ ...vault, functionName: "nextPositionId" }),
    client.readContract({ ...vault, functionName: "locked" }),
    client.readContract({ address: d.testUsd, abi: testUsdAbi, functionName: "balanceOf", args: [d.vault] }),
    client.readContract({ address: d.testUsd, abi: testUsdAbi, functionName: "decimals" }),
    readPool(client, d),
  ]);
  const unit = 10n ** BigInt(decimals);
  // The deployment names each feed it allowed (a local one, mock feeds).
  const symbolOf = (feed: Address) => Object.entries(d.feeds).find(([, a]) => a?.toLowerCase() === feed.toLowerCase())?.[0] ?? feed.slice(0, 10);
  const money = (x: bigint) => Number(x) / Number(unit);
  const dollars8 = (x: bigint) => Number(x) / 1e8;

  const ids = Array.from({ length: Number(next) }, (_, i) => BigInt(i));
  const positions = await Promise.all(
    ids.map(async (id) => {
      const p = (await client.readContract({ ...vault, functionName: "position", args: [id] })) as EvmPosition;
      // Whoever holds the NFT is paid; a paid position's holder no longer matters here.
      const holder = p.closed ? p.buyer : await client.readContract({ address: d.positions, abi: afterbellPositionsAbi, functionName: "ownerOf", args: [id] });
      return { id, p, holder };
    }),
  );

  // One series per feed and open.
  const seriesOf = new Map<string, { key: Hex; feed: Address; openTs: bigint; state: (typeof STATES)[number]; price: bigint; priceTime: number | null }>();
  for (const { p } of positions) {
    const k = `${p.feed}:${p.openTs}`;
    if (seriesOf.has(k)) continue;
    seriesOf.set(k, { key: "0x", feed: p.feed, openTs: p.openTs, state: "open", price: 0n, priceTime: null });
  }
  await Promise.all(
    [...seriesOf.values()].map(async (s) => {
      s.key = await client.readContract({ ...vault, functionName: "seriesKey", args: [s.feed, s.openTs] });
      const { state, price, roundId } = (await client.readContract({ ...vault, functionName: "series", args: [s.key] })) as EvmSeries;
      s.state = STATES[state]!;
      s.price = price;
      // When Chainlink published the round the series settled on.
      if (s.state === "settled") s.priceTime = Number((await chainlinkReader(client, s.feed).round(roundId))?.updatedAt ?? 0) || null;
    }),
  );

  const rows = positions.map(({ id, p, holder }) => {
    const s = seriesOf.get(`${p.feed}:${p.openTs}`)!;
    const row: PositionRow = {
      address: id.toString(),
      series: s.key,
      symbol: symbolOf(s.feed),
      buyer: holder,
      openTs: Number(p.openTs),
      state: s.state,
      shares: Number(p.shares) / 1e6,
      upper: dollars8(p.upper),
      lower: dollars8(p.lower),
      premium: money(p.premium),
      maxPayout: money(p.maxPayout),
      claimable: s.state === "open" ? null : money(claimUnits(s.state, p, s.price, unit)),
      settlementPrice: s.state === "settled" ? dollars8(s.price) : null,
      art: `/api/position-art/${id}`,
    };
    return { row, p };
  });

  // Unlike Solana's, a paid position stays on-chain (marked closed), so series count every sale.
  const series: SeriesRow[] = [...seriesOf.values()]
    .map((s) => {
      const mine = rows.filter((r) => r.row.series === s.key);
      return {
        address: s.key,
        symbol: symbolOf(s.feed),
        openTs: Number(s.openTs),
        state: s.state,
        price: s.state === "settled" ? dollars8(s.price) : null,
        publishTime: null,
        positions: mine.length,
        premiums: mine.reduce((t, r) => t + r.row.premium, 0),
        maxPayouts: mine.filter((r) => !r.p.closed).reduce((t, r) => t + r.row.maxPayout, 0),
      };
    })
    .sort((a, b) => b.openTs - a.openTs);

  const ledger: LedgerRow[] = [...seriesOf.values()].map((s) => {
    const mine = rows.filter((r) => r.row.series === s.key);
    const paid = mine.filter((r) => r.p.closed);
    return {
      chain: "robinhood",
      series: s.key,
      symbol: symbolOf(s.feed),
      openTs: Number(s.openTs),
      state: s.state,
      price: s.state === "settled" ? dollars8(s.price) : null,
      priceTime: s.priceTime,
      settleTx: null,
      sales: mine.length,
      premiums: mine.reduce((t, r) => t + r.row.premium, 0),
      maxPayouts: mine.reduce((t, r) => t + r.row.maxPayout, 0),
      paid: paid.reduce((t, r) => t + money(r.p.paid), 0),
      claims: paid.length,
    };
  });

  return {
    ledger,
    pool,
    chainId: d.chainId,
    vault: d.vault,
    collateralMint: d.testUsd,
    collateral: money(held),
    locked: money(locked),
    series,
    positions: rows.filter((r) => !r.p.closed).map((r) => r.row),
  };
}

/** The underwriters' pool: its value and share price, its round, what waits for the roll, and its risk limits. */
async function readPool(client: PublicClient, d: EvmDeployment): Promise<PoolState> {
  const vault = { address: d.vault, abi: afterbellVaultAbi } as const;
  const [round, roundOpenTs, roundNav, nav, supply, pendingDeposits, pendingRedeems, reserved, tips, locked, params] = await Promise.all([
    client.readContract({ ...vault, functionName: "round" }),
    client.readContract({ ...vault, functionName: "roundOpenTs" }),
    client.readContract({ ...vault, functionName: "roundNav" }),
    client.readContract({ ...vault, functionName: "totalAssets" }),
    client.readContract({ ...vault, functionName: "totalSupply" }),
    client.readContract({ ...vault, functionName: "pendingDepositAssets" }),
    client.readContract({ ...vault, functionName: "pendingRedeemShares" }),
    client.readContract({ ...vault, functionName: "reservedAssets" }),
    client.readContract({ ...vault, functionName: "tipsOwed" }),
    client.readContract({ ...vault, functionName: "locked" }),
    client.readContract({ ...vault, functionName: "params" }),
  ]);
  const money = (x: bigint) => Number(x) / 1e6;
  const cap = (roundNav * BigInt(params.maxUtilizationBps)) / 10_000n;
  return {
    round: Number(round),
    roundOpenTs: roundOpenTs === 0n ? null : Number(roundOpenTs),
    nav: money(nav),
    roundNav: money(roundNav),
    shares: money(supply),
    // What a share is worth now, as the contract converts at the roll (assets + 1) / (supply + 1).
    sharePrice: Number(nav + 1n) / Number(supply + 1n),
    pendingDeposits: money(pendingDeposits),
    pendingRedeemShares: money(pendingRedeems),
    reserved: money(reserved),
    tipsOwed: money(tips),
    room: money(cap > locked ? cap - locked : 0n),
    perStock: money((roundNav * BigInt(params.maxFeedBps)) / 10_000n),
    maxUtilizationBps: params.maxUtilizationBps,
    maxFeedBps: params.maxFeedBps,
    keeperTipBps: params.keeperTipBps,
  };
}

/** One underwriter's stake: shares held and their value, what waits for the roll, and what the last roll filled. */
export async function evmUnderwriter(owner: Address) {
  const d = evmDeployment();
  if (!d) return null;
  const client = createPublicClient({ chain: evmChain(d), transport: http(d.rpc) });
  const vault = { address: d.vault, abi: afterbellVaultAbi } as const;
  const [shares, pendingDeposit, pendingRedeem, claimableDeposit, claimableShares, claimableRedeem, claimableAssets, testUsd] = await Promise.all([
    client.readContract({ ...vault, functionName: "balanceOf", args: [owner] }),
    client.readContract({ ...vault, functionName: "pendingDepositRequest", args: [0n, owner] }),
    client.readContract({ ...vault, functionName: "pendingRedeemRequest", args: [0n, owner] }),
    client.readContract({ ...vault, functionName: "maxDeposit", args: [owner] }),
    client.readContract({ ...vault, functionName: "maxMint", args: [owner] }),
    client.readContract({ ...vault, functionName: "maxRedeem", args: [owner] }),
    client.readContract({ ...vault, functionName: "maxWithdraw", args: [owner] }),
    client.readContract({ address: d.testUsd, abi: testUsdAbi, functionName: "balanceOf", args: [owner] }),
  ]);
  const value = await client.readContract({ ...vault, functionName: "convertToAssets", args: [shares] });
  const money = (x: bigint) => Number(x) / 1e6;
  return {
    shares: money(shares),
    value: money(value),
    testUsd: money(testUsd),
    pendingDeposit: money(pendingDeposit),
    pendingRedeemShares: money(pendingRedeem),
    claimableDeposit: money(claimableDeposit),
    claimableShares: money(claimableShares),
    claimableRedeemShares: money(claimableRedeem),
    claimableAssets: money(claimableAssets),
  };
}

/**
 * Why the vault would refuse this sale, or null if it would take it: the quote
 * route asks before signing, so a buyer never pays gas for a sure revert. The
 * round sells one opening at a time, and each sale must fit the pool's limits.
 */
export async function evmSaleError(q: { feed: Address; openTs: bigint; shares: bigint; upper: bigint; lower: bigint }): Promise<string | null> {
  const d = evmDeployment();
  if (!d) return "the Robinhood Chain vault isn't deployed yet";
  const client = createPublicClient({ chain: evmChain(d), transport: http(d.rpc) });
  const vault = { address: d.vault, abi: afterbellVaultAbi } as const;
  const [roundOpenTs, room, maxPayout] = await Promise.all([
    client.readContract({ ...vault, functionName: "roundOpenTs" }),
    client.readContract({ ...vault, functionName: "capacity", args: [q.feed] }),
    client.readContract({ ...vault, functionName: "payoutAt", args: [q.shares, q.upper, q.lower, 0n] }),
  ]);
  if (roundOpenTs !== 0n && roundOpenTs !== q.openTs) {
    return "the pool is still closing out its last opening; it sells the next one once its keeper rolls it";
  }
  if (maxPayout > room) return `the pool can cover at most $${(Number(room) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} more on this stock tonight; try fewer shares or a narrower range`;
  return null;
}
