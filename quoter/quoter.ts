/**
 * The quote service's core: prices protection until the next open from the
 * stock's history of openings, then signs it for the vault the buyer uses.
 * Pure: the caller supplies the time, market data and keys.
 */
import bs58 from "bs58";
import type { Address, Hex } from "viem";

import { openingModel, type Opening, type OpeningModel } from "../pricing/model";
import { priceProtection, type Protection } from "../pricing/putSpread";
import { hashEvmQuote, maxPayoutUnits, signEvmQuote, toEvmQuote, toUnits, type EvmQuote } from "../pricing/quote";
import {
  ed25519InstructionData,
  quoterPublicKey,
  signSolanaQuote,
  solanaQuoteMessage,
  type SolanaQuote,
} from "../pricing/solanaQuote";
import { nextOpen, SESSION_SECS_PER_YEAR, sessionSecsLeft, type EarlyCloses } from "./calendar";

const YEAR_SECS = 365.25 * 86_400;

export type QuoterConfig = {
  /** Premium over the model's fair value (0.15 = 15%). */
  margin: number;
  /**
   * The least a quote costs, as a share of the most it can pay (0.005 = 0.5%).
   * The model learns from openings since June, a short and mostly calm history:
   * a stock that hasn't gapped 2% in it still can, so cover on it isn't free.
   */
  minRate: number;
  /** How long a signed quote stays usable. */
  ttlSecs: number;
  /**
   * Every quote expires at least this long before its open. Protection is sold
   * for the next open only while a quote can still live its full TTL; after
   * that, it's for the open after.
   */
  stopBeforeOpenSecs: number;
  /** Most shares one quote covers. */
  maxShares: number;
  /**
   * Outside the session, sales pause once the live price has moved this far
   * from the close (earnings after the bell, say): the history of openings
   * can't price a move that has already happened.
   */
  maxMoveSinceClose: number;
};

export const DEFAULT_QUOTER_CONFIG: QuoterConfig = {
  margin: 0.15,
  minRate: 0.005,
  ttlSecs: 60,
  stopBeforeOpenSecs: 120,
  maxShares: 1_000,
  maxMoveSinceClose: 0.05,
};

export type Market = {
  symbol: string;
  /** The last official close: Pyth's first print at or after 16:00 ET. */
  close: number;
  /**
   * The price now: Pyth's during the session, otherwise Hyperliquid's xyz
   * perp, which trades while the exchange is shut. Required in the session.
   */
  live?: number;
  /** Past close-to-open moves, oldest first. */
  history: readonly Opening[];
  annualVol: number;
  /** NY dates the exchange is closed (calendar.scheduleHolidays). */
  holidays: ReadonlySet<string>;
  /** Early-close days (calendar.scheduleEarlyCloses). */
  earlyCloses?: EarlyCloses;
};

export type PricedProtection = {
  symbol: string;
  protection: Protection;
  /** Unix seconds of the 09:30 ET open it settles on. */
  openTs: number;
  /** Unix seconds after which the quote can't be used. */
  expiry: number;
  /** Dollars. */
  premium: number;
  expectedPayout: number;
  maxPayout: number;
  probabilityOfPayout: number;
  model: { source: "history" | "lognormal"; sd: number; openings: number };
  /** The price the protection was priced from, and why that one. */
  reference: { price: number; basis: ReferenceBasis };
};

export type ReferenceBasis = "live" | "close" | "live, below the close";

/**
 * The price protection is centred on. In the session, the live price. Outside
 * it, the lower of the close and the live price: on average the close
 * predicts the open better (research/results/multi-weekend-proof.md), but on
 * weeknights and close to the open Hyperliquid's price often does better, so
 * a drop since the close is priced in and a buyer can't get protection cheap
 * after one. A rise since the close is ignored, which errs on the vault's side.
 */
export function referencePrice(now: number, market: Market, cfg: QuoterConfig = DEFAULT_QUOTER_CONFIG): { price: number; basis: ReferenceBasis } {
  const live = market.live;
  if (sessionSecsLeft(now, market.holidays, market.earlyCloses) > 0) {
    if (!(live !== undefined && live > 0)) throw new Error("no live price during the session");
    return { price: live, basis: "live" };
  }
  if (!(market.close > 0)) throw new Error("no closing price");
  if (live === undefined) return { price: market.close, basis: "close" };
  if (!(live > 0)) throw new Error("no live price");
  const move = live / market.close - 1;
  if (Math.abs(move) > cfg.maxMoveSinceClose) {
    throw new Error(`sales paused: the price has moved ${(move * 100).toFixed(1)}% since the close`);
  }
  return live < market.close ? { price: live, basis: "live, below the close" } : { price: market.close, basis: "close" };
}

/** The distribution of the print at `openTs`, as protection for it is priced at `now`. The hedger sizes its short from the same one. */
export function modelFor(now: number, openTs: number, market: Pick<Market, "history" | "annualVol" | "holidays" | "earlyCloses">): OpeningModel {
  return openingModel(market.history, {
    annualVol: market.annualVol,
    years: (openTs - now) / YEAR_SECS,
    sessionYears: sessionSecsLeft(now, market.holidays, market.earlyCloses) / SESSION_SECS_PER_YEAR,
  });
}

export function priceQuote(now: number, market: Market, protection: Protection, cfg: QuoterConfig = DEFAULT_QUOTER_CONFIG): PricedProtection {
  if (protection.shares > cfg.maxShares) throw new Error(`at most ${cfg.maxShares} shares per quote`);
  const reference = referencePrice(now, market, cfg);
  const openTs = nextOpen(now, cfg.stopBeforeOpenSecs + cfg.ttlSecs, market.holidays);
  const model = modelFor(now, openTs, market);
  const price = priceProtection(model, reference.price, protection, cfg.margin, cfg.minRate);
  // The vault takes premium <= max payout, but protection that dear is no use to anyone.
  if (price.premium >= price.maxPayout) throw new Error("protection this deep costs as much as it can pay");
  return {
    symbol: market.symbol,
    protection,
    openTs,
    expiry: Math.min(now + cfg.ttlSecs, openTs - cfg.stopBeforeOpenSecs),
    premium: price.premium,
    expectedPayout: price.expectedPayout,
    maxPayout: price.maxPayout,
    probabilityOfPayout: price.probabilityOfPayout,
    model: { source: model.source, sd: model.sd, openings: market.history.length },
    reference,
  };
}

// ---------------------------------------------------------------------- Solana

export type SolanaVaultRef = { programId: string; vault: string; /** Pyth feed id, hex */ feedId: string };

export type SignedSolanaQuote = {
  quote: SolanaQuote;
  quoter: string;
  signature: Uint8Array;
  /** Data for the Ed25519 program instruction that goes right before `buy`. */
  ed25519Data: Uint8Array;
};

const hexBytes = (hex: string) => Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex"));

export function signForSolana(
  p: PricedProtection,
  buyer: string,
  v: SolanaVaultRef,
  quoterSeed: Uint8Array,
  nonce: Uint8Array = crypto.getRandomValues(new Uint8Array(32)),
): SignedSolanaQuote {
  const units = toUnits(p.protection, p.premium);
  const quote: SolanaQuote = {
    feedId: hexBytes(v.feedId),
    openTs: BigInt(p.openTs),
    ...units,
    expiry: BigInt(p.expiry),
    nonce,
  };
  // The checks `buy` makes on the quote itself.
  const max = maxPayoutUnits(units);
  if (units.shares === 0n || max === 0n) throw new Error("protection pays nothing");
  if (units.premium > max) throw new Error("premium above the maximum payout");
  if (quote.expiry >= quote.openTs) throw new Error("quote must expire before the open");

  const message = solanaQuoteMessage(v.programId, v.vault, buyer, quote);
  const signature = signSolanaQuote(message, quoterSeed);
  const quoter = quoterPublicKey(quoterSeed);
  return { quote, quoter, signature, ed25519Data: ed25519InstructionData(bs58.decode(quoter), signature, message) };
}

// ------------------------------------------------------------------------- EVM

export type EvmVaultRef = { chainId: number; vault: Address; /** Chainlink proxy for the stock */ feed: Address };

export type SignedEvmQuote = { quote: EvmQuote; digest: Hex; signature: Hex };

export async function signForEvm(p: PricedProtection, buyer: Address, v: EvmVaultRef, quoterKey: Hex, nonce?: bigint): Promise<SignedEvmQuote> {
  const quote = toEvmQuote({ buyer, feed: v.feed, openTs: p.openTs, protection: p.protection, premium: p.premium, expiry: p.expiry, nonce });
  const domain = { chainId: v.chainId, vault: v.vault };
  return { quote, digest: hashEvmQuote(quote, domain), signature: await signEvmQuote(quote, domain, quoterKey) };
}
