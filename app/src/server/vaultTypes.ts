/** What the app reads off a vault, on either chain. */
import type { SeriesState } from "@root/solana/keeper/plan";

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
  /** The most its positions not yet paid out could pay. */
  maxPayouts: number;
};

export type PositionRow = {
  address: string;
  series: string;
  symbol: string;
  /** Whoever holds the position's NFT, who is paid (the original buyer until a holder is looked up). */
  buyer: string;
  openTs: number;
  state: SeriesState;
  shares: number;
  upper: number;
  lower: number;
  premium: number;
  maxPayout: number;
  /** What paying it out pays now (settled: the payout; voided: the premium back); null while open. */
  claimable: number | null;
  settlementPrice: number | null;
  /** The position's NFT image. */
  art?: string;
  /** Solana: the NFT's mint, and the holder's account holding it (for the holder's own claim). */
  mint?: string;
  nftAccount?: string;
};

/** An underwriters' pool, in TestUSD and shares (6 decimals both). */
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
