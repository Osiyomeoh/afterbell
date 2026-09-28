import { PublicKey } from "@solana/web3.js";
import { createPublicClient, http, zeroAddress } from "viem";

import { afterbellVaultAbi, testUsdAbi } from "@root/evm/client/abi";
import { evmChain, type EvmPosition, type EvmSeries } from "@root/evm/client/vault";
import { claimUnits } from "@root/solana/keeper/plan";

import type { ShareView } from "@/lib/share";

import { positionCard } from "./chain";
import { evmDeployment } from "./evmDeployment";

// The EVM contract's SeriesState enum, in order.
const STATES = ["open", "settled", "voided"] as const;

/** A position for its share page, read from its chain; null if there's no such position. */
export async function shareView(chain: string, id: string): Promise<ShareView | null> {
  if (chain === "solana") return solanaView(id);
  if (chain === "robinhood") return robinhoodView(id);
  return null;
}

async function solanaView(id: string): Promise<ShareView | null> {
  let address: PublicKey;
  try {
    address = new PublicKey(id);
  } catch {
    return null;
  }
  const c = await positionCard(address);
  if (!c) return null;
  // The card carries prices with 8 decimals, money and shares with 6.
  const premium = Number(c.premium) / 1e6;
  return {
    chain: "solana",
    id: address.toBase58(),
    number: c.number.toString(),
    symbol: c.symbol,
    openTs: Number(c.openTs),
    shares: Number(c.shares) / 1e6,
    upper: Number(c.upper) / 1e8,
    lower: Number(c.lower) / 1e8,
    premium,
    maxPayout: Number(c.maxPayout) / 1e6,
    state: c.state,
    price: c.state === "settled" ? Number(c.price) / 1e8 : null,
    payout: c.state === "settled" ? Number(c.payout) / 1e6 : c.state === "voided" ? premium : null,
    art: `/api/position-art/solana/${address.toBase58()}/image`,
  };
}

async function robinhoodView(id: string): Promise<ShareView | null> {
  const d = evmDeployment();
  if (!d || !/^\d{1,18}$/.test(id)) return null;
  const client = createPublicClient({ chain: evmChain(d), transport: http(d.rpc) });
  const vault = { address: d.vault, abi: afterbellVaultAbi } as const;
  const [p, decimals] = await Promise.all([
    client.readContract({ ...vault, functionName: "position", args: [BigInt(id)] }) as Promise<EvmPosition>,
    client.readContract({ address: d.testUsd, abi: testUsdAbi, functionName: "decimals" }),
  ]);
  // A position never sold reads as zeros.
  if (p.buyer === zeroAddress) return null;
  const key = await client.readContract({ ...vault, functionName: "seriesKey", args: [p.feed, p.openTs] });
  const s = (await client.readContract({ ...vault, functionName: "series", args: [key] })) as EvmSeries;
  const state = STATES[s.state]!;
  const unit = 10n ** BigInt(decimals);
  const money = (x: bigint) => Number(x) / Number(unit);
  const symbol = Object.entries(d.feeds).find(([, a]) => a?.toLowerCase() === p.feed.toLowerCase())?.[0] ?? p.feed.slice(0, 10);
  const payout = p.closed ? p.paid : state === "open" ? null : claimUnits(state, p, s.price, unit);
  return {
    chain: "robinhood",
    id,
    number: id,
    symbol,
    openTs: Number(p.openTs),
    shares: Number(p.shares) / 1e6,
    upper: Number(p.upper) / 1e8,
    lower: Number(p.lower) / 1e8,
    premium: money(p.premium),
    maxPayout: money(p.maxPayout),
    state,
    price: state === "settled" ? Number(s.price) / 1e8 : null,
    payout: payout === null ? null : money(payout),
    art: `/api/position-art/${id}`,
  };
}
