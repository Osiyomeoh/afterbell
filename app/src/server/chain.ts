import { getAccount, getAssociatedTokenAddressSync, getMint, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";

import { stockByFeedId } from "@root/quoter/stocks";
import type { Card } from "@root/solana/client/art";
import { assetsFor, bpsOf, maxPayoutUnits, roomLeft, saleRefusal, stakeOf, totalAssets, type RoundLimits } from "@root/solana/client/pool";
import { feedConfigAddress, getProgram, rateAddress, requestAddress, seriesAddress, token2022Account } from "@root/solana/client/vault";
import { claimUnits, type SeriesState } from "@root/solana/keeper/plan";

import { SOLANA_DEPLOYMENT, type SolanaV2Deployment } from "./deployment";
import type { LedgerRow } from "./ledger";

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

type SolanaVaultState = VaultState & { ledger: LedgerRow[]; pool: PoolState };

type Num = { toString(): string };
const big = (x: Num) => BigInt(x.toString());
const hex = (bytes: number[]) => Buffer.from(bytes).toString("hex");
const stateOf = (s: object) => Object.keys(s)[0] as SeriesState;

type VaultAccount = Awaited<ReturnType<ReturnType<typeof getProgram>["account"]["vault"]["fetch"]>>;

const books = (v: VaultAccount) => ({
  pendingDepositAssets: big(v.pendingDepositAssets),
  reservedAssets: big(v.reservedAssets),
  tipsOwed: big(v.tipsOwed),
  locked: big(v.locked),
});

const limitsOf = (v: VaultAccount): RoundLimits => ({
  roundOpenTs: big(v.roundOpenTs),
  roundNav: big(v.roundNav),
  locked: big(v.locked),
  maxUtilizationBps: v.params.maxUtilizationBps,
  maxFeedBps: v.params.maxFeedBps,
});

const reader = () => {
  const connection = new Connection(RPC, "confirmed");
  return { connection, program: getProgram(connection, readOnly) };
};

const TTL_MS = 10_000;
let cache: { at: number; state: Promise<SolanaVaultState> } | null = null;

/**
 * The Solana vault v2: its series and unpaid positions, its ledger (a paid
 * position stays on-chain with what it paid, so each series' record comes
 * straight from state), and its underwriters' pool. Shared by every visitor
 * and refreshed at most every 10 seconds. Null until v2 is deployed.
 */
export function solanaVaultState(): Promise<SolanaVaultState> | null {
  const d = SOLANA_DEPLOYMENT;
  if (!d) return null;
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const state = load(d);
    cache = { at: Date.now(), state };
    state.catch(() => (cache = null));
  }
  return cache.state;
}

async function load(d: SolanaV2Deployment): Promise<SolanaVaultState> {
  const { connection, program } = reader();
  const vault = new PublicKey(d.vault);
  const byVault = [{ memcmp: { offset: 8, bytes: vault.toBase58() } }];
  const [v, series, positions, feeds, held, shareMint] = await Promise.all([
    program.account.vault.fetch(vault),
    program.account.series.all(byVault),
    program.account.position.all(byVault),
    program.account.feedConfig.all(byVault),
    getAccount(connection, new PublicKey(d.vaultToken)),
    getMint(connection, new PublicKey(d.shareMint), "confirmed", TOKEN_2022_PROGRAM_ID),
  ]);
  const unit = big(v.collateralUnit);
  const money = (x: bigint) => Number(x) / Number(unit);
  const dollars8 = (x: bigint) => Number(x) / 1e8;
  // Each feed's ticker, as the vault allowed it.
  const symbols = new Map(feeds.map((f) => [hex(f.account.feedId), f.account.symbol]));
  const symbolOf = (feedId: number[]) => symbols.get(hex(feedId)) ?? stockByFeedId(hex(feedId))?.symbol ?? `0x${hex(feedId).slice(0, 8)}`;

  const seriesByKey = new Map(series.map((s) => [s.publicKey.toBase58(), s.account]));
  const rows = positions.map((p) => {
    const a = p.account;
    const s = seriesByKey.get(a.series.toBase58())!;
    const state = stateOf(s.state);
    const terms = { shares: big(a.shares), upper: big(a.upper), lower: big(a.lower), premium: big(a.premium) };
    const row: PositionRow = {
      address: p.publicKey.toBase58(),
      series: a.series.toBase58(),
      symbol: symbolOf(s.feedId),
      buyer: a.buyer.toBase58(),
      openTs: s.openTs.toNumber(),
      state,
      shares: Number(terms.shares) / 1e6,
      upper: dollars8(terms.upper),
      lower: dollars8(terms.lower),
      premium: money(terms.premium),
      maxPayout: money(big(a.maxPayout)),
      claimable: state === "open" ? null : money(claimUnits(state, terms, big(s.price), unit)),
      settlementPrice: state === "settled" ? dollars8(big(s.price)) : null,
      art: `/api/position-art/solana/${p.publicKey.toBase58()}/image`,
      mint: a.mint.toBase58(),
    };
    // A position whose NFT was burned before it was paid closes paying no one.
    return { row, closed: a.closed, paid: big(a.paid), forfeited: a.closed && a.paidTo.equals(PublicKey.default) };
  });

  const seriesRows: SeriesRow[] = series
    .map((s) => {
      const state = stateOf(s.account.state);
      return {
        address: s.publicKey.toBase58(),
        symbol: symbolOf(s.account.feedId),
        openTs: s.account.openTs.toNumber(),
        state,
        price: state === "settled" ? dollars8(big(s.account.price)) : null,
        publishTime: state === "settled" ? s.account.publishTime.toNumber() : null,
        positions: s.account.sold,
        premiums: rows.filter((r) => r.row.series === s.publicKey.toBase58()).reduce((t, r) => t + r.row.premium, 0),
        maxPayouts: money(big(s.account.locked)),
      };
    })
    .sort((a, b) => b.openTs - a.openTs);

  // Settle transactions come from the vault's events (ledger.ts).
  const ledger: LedgerRow[] = seriesRows.map((s) => {
    const mine = rows.filter((r) => r.row.series === s.address);
    const paid = mine.filter((r) => r.closed && !r.forfeited);
    return {
      chain: "solana",
      series: s.address,
      symbol: s.symbol,
      openTs: s.openTs,
      state: s.state,
      price: s.price,
      priceTime: s.publishTime,
      settleTx: null,
      sales: mine.length,
      premiums: s.premiums,
      maxPayouts: mine.reduce((t, r) => t + r.row.maxPayout, 0),
      paid: paid.reduce((t, r) => t + money(r.paid), 0),
      claims: paid.length,
    };
  });

  const b = books(v);
  const limits = limitsOf(v);
  const nav = totalAssets(held.amount, b);
  const supply = shareMint.supply;
  const pool: PoolState = {
    round: Number(v.round.toString()),
    roundOpenTs: limits.roundOpenTs === 0n ? null : Number(limits.roundOpenTs),
    nav: money(nav),
    roundNav: money(limits.roundNav),
    // Shares carry the collateral's decimals.
    shares: money(supply),
    // What a share is worth now, as the program converts at the roll: (assets + 1) / (supply + 1).
    sharePrice: Number(nav + 1n) / Number(supply + 1n),
    pendingDeposits: money(b.pendingDepositAssets),
    pendingRedeemShares: money(big(v.pendingRedeemShares)),
    reserved: money(b.reservedAssets),
    tipsOwed: money(b.tipsOwed),
    room: money(roomLeft(limits).round),
    perStock: money(bpsOf(limits.roundNav, limits.maxFeedBps)),
    maxUtilizationBps: limits.maxUtilizationBps,
    maxFeedBps: limits.maxFeedBps,
    keeperTipBps: v.params.keeperTipBps,
  };

  return {
    ledger,
    pool,
    vault: vault.toBase58(),
    collateralMint: d.collateralMint,
    collateral: money(held.amount),
    locked: money(b.locked),
    series: seriesRows,
    positions: rows.filter((r) => !r.closed).map((r) => r.row),
  };
}

/**
 * The unpaid positions whose NFTs `owner` holds now, each with the account
 * holding it: whoever holds a position's NFT is the one paid. Null until v2
 * is deployed.
 */
export async function positionsHeldBy(owner: PublicKey): Promise<PositionRow[] | null> {
  const state = solanaVaultState();
  if (!state) return null;
  const { connection } = reader();
  const [s, accounts] = await Promise.all([state, connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }, "confirmed")]);
  const held = new Map<string, string>();
  for (const { pubkey, account } of accounts.value) {
    const info = account.data.parsed.info as { mint: string; tokenAmount: { amount: string } };
    if (info.tokenAmount.amount === "1") held.set(info.mint, pubkey.toBase58());
  }
  return s.positions.filter((p) => p.mint && held.has(p.mint)).map((p) => ({ ...p, buyer: owner.toBase58(), nftAccount: held.get(p.mint!) }));
}

/** One underwriter's stake: shares held and their value, what waits for the roll, and what earlier rolls filled. */
export async function solanaUnderwriter(owner: PublicKey) {
  const d = SOLANA_DEPLOYMENT;
  if (!d) return null;
  const { connection, program } = reader();
  const vault = new PublicKey(d.vault);
  const balance = (account: PublicKey) => connection.getTokenAccountBalance(account, "confirmed").then((b) => BigInt(b.value.amount), () => 0n);
  const [v, request, shares, testUsd, held, shareMint] = await Promise.all([
    program.account.vault.fetch(vault),
    program.account.request.fetchNullable(requestAddress(vault, owner)),
    balance(token2022Account(owner, new PublicKey(d.shareMint))),
    balance(getAssociatedTokenAddressSync(new PublicKey(d.collateralMint), owner)),
    getAccount(connection, new PublicKey(d.vaultToken)),
    getMint(connection, new PublicKey(d.shareMint), "confirmed", TOKEN_2022_PROGRAM_ID),
  ]);
  const round = big(v.round);
  const r = request && {
    depositRound: big(request.depositRound),
    depositAssets: big(request.depositAssets),
    redeemRound: big(request.redeemRound),
    redeemShares: big(request.redeemShares),
    filledDepositAssets: big(request.filledDepositAssets),
    filledDepositShares: big(request.filledDepositShares),
    filledRedeemShares: big(request.filledRedeemShares),
    filledRedeemAssets: big(request.filledRedeemAssets),
  };
  // A request queued in a round already rolled fills at that roll's rate.
  const rate = (queued: bigint, amount: bigint) =>
    amount > 0n && queued < round
      ? program.account.roundRate.fetch(rateAddress(vault, queued)).then((x) => ({ assets: big(x.assets), supply: big(x.supply) }))
      : null;
  const [deposit, redeem] = r ? await Promise.all([rate(r.depositRound, r.depositAssets), rate(r.redeemRound, r.redeemShares)]) : [null, null];
  const stake = stakeOf(r, round, { deposit, redeem });
  const unit = Number(big(v.collateralUnit));
  const money = (x: bigint) => Number(x) / unit;
  return {
    shares: money(shares),
    value: money(assetsFor(shares, totalAssets(held.amount, books(v)), shareMint.supply)),
    testUsd: money(testUsd),
    pendingDeposit: money(stake.pendingDeposit),
    pendingRedeemShares: money(stake.pendingRedeemShares),
    claimableDeposit: money(stake.claimableDeposit),
    claimableShares: money(stake.claimableShares),
    claimableRedeemShares: money(stake.claimableRedeemShares),
    claimableAssets: money(stake.claimableAssets),
  };
}

/**
 * Why the vault would refuse this sale, or null if it would take it: the quote
 * route asks before handing out a signed quote, so a buyer never pays for a
 * sure failure. The round sells one opening at a time, and each sale must fit
 * the pool's limits.
 */
export async function solanaSaleError(q: { feedId: Uint8Array; openTs: bigint; shares: bigint; upper: bigint; lower: bigint }): Promise<string | null> {
  const d = SOLANA_DEPLOYMENT;
  if (!d) return "the Solana vault v2 isn't deployed yet";
  const { program } = reader();
  const vault = new PublicKey(d.vault);
  const [v, series] = await Promise.all([program.account.vault.fetch(vault), program.account.series.fetchNullable(seriesAddress(vault, q.feedId, q.openTs))]);
  const limits = limitsOf(v);
  const unit = big(v.collateralUnit);
  const seriesLocked = series ? big(series.locked) : 0n;
  const refusal = saleRefusal(limits, seriesLocked, q.openTs, maxPayoutUnits(q.shares, q.upper, q.lower, unit));
  if (!refusal) return null;
  if (refusal === "wrong-round") return "the pool is still closing out its last opening; it sells the next one once its keeper rolls it";
  if (limits.roundNav === 0n) return "the pool has no underwriters yet, so it can't sell protection";
  const room = Number(roomLeft(limits, seriesLocked).stock) / Number(unit);
  return `the pool can cover at most $${room.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} more on this stock tonight; try fewer shares or a narrower range`;
}

/** What a position's NFT shows, read from its accounts; null if it isn't this vault's. */
export async function positionCard(address: PublicKey): Promise<Card | null> {
  const d = SOLANA_DEPLOYMENT;
  if (!d) return null;
  const { program } = reader();
  const vault = new PublicKey(d.vault);
  const p = await program.account.position.fetchNullable(address);
  if (!p || !p.vault.equals(vault)) return null;
  const s = await program.account.series.fetch(p.series);
  const [v, feed] = await Promise.all([program.account.vault.fetch(vault), program.account.feedConfig.fetchNullable(feedConfigAddress(vault, Uint8Array.from(s.feedId)))]);
  const state = stateOf(s.state);
  const terms = { shares: big(p.shares), upper: big(p.upper), lower: big(p.lower), premium: big(p.premium) };
  return {
    number: big(p.number),
    symbol: feed?.symbol ?? stockByFeedId(hex(s.feedId))?.symbol ?? "?",
    openTs: big(s.openTs),
    ...terms,
    maxPayout: big(p.maxPayout),
    state,
    price: big(s.price),
    payout: p.closed ? big(p.paid) : state === "settled" ? claimUnits(state, terms, big(s.price), big(v.collateralUnit)) : 0n,
    closed: p.closed,
    forfeited: p.closed && p.paidTo.equals(PublicKey.default),
  };
}
