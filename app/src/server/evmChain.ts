import { createPublicClient, http, type Address, type Hex } from "viem";

import { afterbellVaultAbi, testUsdAbi } from "@root/evm/client/abi";
import { evmChain, type EvmDeployment } from "@root/evm/client/vault";
import { chainlinkReader } from "@root/evm/keeper/keeper";
import { claimUnits } from "@root/solana/keeper/plan";

import type { PositionRow, SeriesRow, VaultState } from "./chain";
import { evmDeployment } from "./evmDeployment";
import type { LedgerRow } from "./ledger";

type EvmVaultState = VaultState & { ledger: LedgerRow[] };

// The contract's SeriesState enum, in order.
const STATES = ["open", "settled", "voided"] as const;

const TTL_MS = 10_000;
let cache: { at: number; state: Promise<EvmVaultState> } | null = null;

/**
 * The Robinhood Chain vault in the same shape as the Solana one: its series
 * and unclaimed positions, plus its ledger (claimed positions stay on-chain
 * here, so what each series paid comes straight from state). Shared by every
 * visitor and refreshed at most every 10 seconds. Null until deployed.
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
  const [next, locked, held, decimals] = await Promise.all([
    client.readContract({ ...vault, functionName: "nextPositionId" }),
    client.readContract({ ...vault, functionName: "locked" }),
    client.readContract({ address: d.testUsd, abi: testUsdAbi, functionName: "balanceOf", args: [d.vault] }),
    client.readContract({ address: d.testUsd, abi: testUsdAbi, functionName: "decimals" }),
  ]);
  const unit = 10n ** BigInt(decimals);
  const money = (x: bigint) => Number(x) / Number(unit);
  const dollars8 = (x: bigint) => Number(x) / 1e8;

  const ids = Array.from({ length: Number(next) }, (_, i) => BigInt(i));
  const positions = await Promise.all(ids.map(async (id) => ({ id, p: await client.readContract({ ...vault, functionName: "positions", args: [id] }) })));

  // One series per feed and open.
  const seriesOf = new Map<string, { key: Hex; feed: Address; openTs: bigint; state: (typeof STATES)[number]; price: bigint; priceTime: number | null }>();
  for (const { p } of positions) {
    const k = `${p[1]}:${p[2]}`;
    if (seriesOf.has(k)) continue;
    seriesOf.set(k, { key: "0x", feed: p[1], openTs: p[2], state: "open", price: 0n, priceTime: null });
  }
  await Promise.all(
    [...seriesOf.values()].map(async (s) => {
      s.key = await client.readContract({ ...vault, functionName: "seriesKey", args: [s.feed, s.openTs] });
      const [state, price, roundId] = await client.readContract({ ...vault, functionName: "series", args: [s.key] });
      s.state = STATES[state]!;
      s.price = price;
      // When Chainlink published the round the series settled on.
      if (s.state === "settled") s.priceTime = Number((await chainlinkReader(client, s.feed).round(roundId))?.updatedAt ?? 0) || null;
    }),
  );

  const rows = positions.map(({ id, p }) => {
    const s = seriesOf.get(`${p[1]}:${p[2]}`)!;
    const row: PositionRow = {
      address: id.toString(),
      series: s.key,
      buyer: p[0],
      openTs: Number(p[2]),
      state: s.state,
      shares: Number(p[3]) / 1e6,
      upper: dollars8(p[4]),
      lower: dollars8(p[5]),
      premium: money(p[6]),
      maxPayout: money(p[7]),
      claimable:
        s.state === "open" ? null : money(claimUnits(s.state, { shares: p[3], upper: p[4], lower: p[5], premium: p[6] }, s.price, unit)),
      settlementPrice: s.state === "settled" ? dollars8(s.price) : null,
    };
    return { row, closed: p[8] };
  });

  // Unlike Solana's, a claimed position stays on-chain (marked closed), so series count every sale.
  const series: SeriesRow[] = [...seriesOf.values()]
    .map((s) => {
      const mine = rows.filter((r) => r.row.series === s.key);
      return {
        address: s.key,
        openTs: Number(s.openTs),
        state: s.state,
        price: s.state === "settled" ? dollars8(s.price) : null,
        publishTime: null,
        positions: mine.length,
        premiums: mine.reduce((t, r) => t + r.row.premium, 0),
        maxPayouts: mine.filter((r) => !r.closed).reduce((t, r) => t + r.row.maxPayout, 0),
      };
    })
    .sort((a, b) => b.openTs - a.openTs);

  const ledger: LedgerRow[] = [...seriesOf.values()].map((s) => {
    const mine = rows.filter((r) => r.row.series === s.key);
    const claimed = mine.filter((r) => r.closed);
    return {
      chain: "robinhood",
      series: s.key,
      openTs: Number(s.openTs),
      state: s.state,
      price: s.state === "settled" ? dollars8(s.price) : null,
      priceTime: s.priceTime,
      settleTx: null,
      sales: mine.length,
      premiums: mine.reduce((t, r) => t + r.row.premium, 0),
      maxPayouts: mine.reduce((t, r) => t + r.row.maxPayout, 0),
      paid: claimed.reduce((t, r) => t + (r.row.claimable ?? 0), 0),
      claims: claimed.length,
    };
  });

  return {
    ledger,
    chainId: d.chainId,
    vault: d.vault,
    collateralMint: d.testUsd,
    collateral: money(held),
    locked: money(locked),
    series,
    positions: rows.filter((r) => !r.closed).map((r) => r.row),
  };
}
