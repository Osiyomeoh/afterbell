import { getAccount } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";

import { stockByFeedId } from "@root/quoter/stocks";
import { getProgram } from "@root/solana/client/vault";
import { claimUnits, type SeriesState } from "@root/solana/keeper/plan";

import { SOLANA_DEPLOYMENT } from "./deployment";

export const RPC = process.env.SOLANA_RPC || process.env.NEXT_PUBLIC_SOLANA_RPC || "https://api.devnet.solana.com";

/** Reads only; nothing on the server signs with this wallet. */
export const readOnly = {
  publicKey: PublicKey.default,
  signTransaction: () => Promise.reject(new Error("read-only")),
  signAllTransactions: () => Promise.reject(new Error("read-only")),
};

export type SeriesRow = {
  address: string;
  /** The stock it settles on. */
  symbol: string;
  openTs: number;
  state: SeriesState;
  /** Settlement price in dollars, once settled. */
  price: number | null;
  publishTime: number | null;
  positions: number;
  premiums: number;
  maxPayouts: number;
};

export type PositionRow = {
  address: string;
  series: string;
  symbol: string;
  buyer: string;
  openTs: number;
  state: SeriesState;
  shares: number;
  upper: number;
  lower: number;
  premium: number;
  maxPayout: number;
  /** What a claim pays now (settled: the payout; voided: the premium back); null while open. */
  claimable: number | null;
  settlementPrice: number | null;
  /** EVM positions only: the position's NFT image, drawn on-chain. */
  art?: string;
};

/** An EVM vault's underwriters' pool, in TestUSD and shares (6 decimals both). */
export type PoolState = {
  round: number;
  /** The opening the current round sells, once its first sale fixes it. */
  roundOpenTs: number | null;
  /** What the pool is worth now, and what it was worth at the roll (its risk limits' base). */
  nav: number;
  roundNav: number;
  shares: number;
  sharePrice: number;
  pendingDeposits: number;
  pendingRedeemShares: number;
  /** Set aside for redemptions already filled. */
  reserved: number;
  tipsOwed: number;
  /** How much more maximum payout the round can sell, across stocks, and at most per stock. */
  room: number;
  perStock: number;
  maxUtilizationBps: number;
  maxFeedBps: number;
  keeperTipBps: number;
};

export type VaultState = {
  /** EVM vaults only. */
  chainId?: number;
  pool?: PoolState;
  vault: string;
  collateralMint: string;
  collateral: number;
  locked: number;
  series: SeriesRow[];
  positions: PositionRow[];
};

/** The stock a Pyth feed id is, or the id's start if it isn't in the registry. */
const symbolOf = (feedId: number[]) => {
  const hex = Buffer.from(feedId).toString("hex");
  return stockByFeedId(hex)?.symbol ?? `0x${hex.slice(0, 8)}`;
};

const TTL_MS = 10_000;
let cache: { at: number; state: Promise<VaultState> } | null = null;

/** The vault, its series and open positions, shared by every visitor and refreshed at most every 10 seconds. */
export function vaultState(): Promise<VaultState> {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const state = load();
    cache = { at: Date.now(), state };
    state.catch(() => (cache = null));
  }
  return cache.state;
}

async function load(): Promise<VaultState> {
  const connection = new Connection(RPC, "confirmed");
  const program = getProgram(connection, readOnly);
  const vault = new PublicKey(SOLANA_DEPLOYMENT.vault);
  const byVault = [{ memcmp: { offset: 8, bytes: vault.toBase58() } }];
  const [v, series, positions, held] = await Promise.all([
    program.account.vault.fetch(vault),
    program.account.series.all(byVault),
    program.account.position.all(byVault),
    getAccount(connection, new PublicKey(SOLANA_DEPLOYMENT.vaultToken)),
  ]);
  const unit = Number(v.collateralUnit.toString());
  const money = (x: { toString(): string }) => Number(x.toString()) / unit;
  const dollars8 = (x: { toString(): string }) => Number(x.toString()) / 1e8;

  const seriesByKey = new Map(series.map((s) => [s.publicKey.toBase58(), s.account]));
  const stateOf = (s: object) => Object.keys(s)[0] as SeriesState;

  const positionRows: PositionRow[] = positions.map((p) => {
    const s = seriesByKey.get(p.account.series.toBase58())!;
    const state = stateOf(s.state);
    const a = p.account;
    const claimable =
      state === "open"
        ? null
        : Number(
            claimUnits(
              state,
              { shares: BigInt(a.shares.toString()), upper: BigInt(a.upper.toString()), lower: BigInt(a.lower.toString()), premium: BigInt(a.premium.toString()) },
              BigInt(s.price.toString()),
              BigInt(v.collateralUnit.toString()),
            ),
          ) / unit;
    return {
      address: p.publicKey.toBase58(),
      series: a.series.toBase58(),
      symbol: symbolOf(s.feedId),
      buyer: a.buyer.toBase58(),
      openTs: s.openTs.toNumber(),
      state,
      shares: Number(a.shares.toString()) / 1e6,
      upper: dollars8(a.upper),
      lower: dollars8(a.lower),
      premium: money(a.premium),
      maxPayout: money(a.maxPayout),
      claimable,
      settlementPrice: state === "settled" ? dollars8(s.price) : null,
    };
  });

  const seriesRows: SeriesRow[] = series
    .map((s) => {
      const mine = positionRows.filter((p) => p.series === s.publicKey.toBase58());
      const state = stateOf(s.account.state);
      return {
        address: s.publicKey.toBase58(),
        symbol: symbolOf(s.account.feedId),
        openTs: s.account.openTs.toNumber(),
        state,
        price: state === "settled" ? dollars8(s.account.price) : null,
        publishTime: state === "settled" ? s.account.publishTime.toNumber() : null,
        positions: mine.length,
        premiums: mine.reduce((t, p) => t + p.premium, 0),
        maxPayouts: mine.reduce((t, p) => t + p.maxPayout, 0),
      };
    })
    .sort((a, b) => b.openTs - a.openTs);

  return {
    vault: vault.toBase58(),
    collateralMint: v.collateralMint.toBase58(),
    collateral: Number(held.amount) / unit,
    locked: money(v.locked),
    series: seriesRows,
    positions: positionRows,
  };
}
