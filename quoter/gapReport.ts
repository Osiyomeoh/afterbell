/**
 * A gap report for a book of stock positions: a wallet, a vault, a lending
 * market's collateral. For each stock: how it has opened after its closes,
 * what its worst recorded opening would cost the position at today's price
 * (and what protection would have paid back that night), what protecting it
 * until the next open costs now, and how that protection did replayed on
 * every past opening. Pure: the caller passes each stock's Market, the same
 * one the quoter prices from.
 */
import { backtest, type Structure } from "../pricing/backtest";
import { payout } from "../pricing/putSpread";
import { DEFAULT_QUOTER_CONFIG, priceQuote, referencePrice, type Market, type QuoterConfig } from "./quoter";

/** A holding, as shares or as a dollar value at the price protection is priced from. */
export type BookLine = { symbol: string; shares?: number; value?: number };

/** Drops the report counts: nights the stock opened at least this far below its close. */
export const DOWN_AT_LEAST = [0.01, 0.02, 0.05] as const;

export type GapLine = {
  symbol: string;
  shares: number;
  /** Dollars, at `reference`. */
  value: number;
  reference: { price: number; basis: string };
  history: {
    openings: number;
    from: string;
    to: string;
    downAtLeast: { move: number; nights: number }[];
    /** The worst close-to-open move on record: `gap` is open / close − 1. */
    worst: { from: string; to: string; gap: number };
  };
  /** That worst opening, applied to this position at today's price: what it would lose, and what the protection would pay. */
  worstNight: { loss: number; protectionPays: number };
  /** Protection until the next open, priced now for the whole position; or why it can't be. */
  tonight: { openTs: number; premium: number; maxPayout: number; probabilityOfPayout: number; upper: number; lower: number } | { unavailable: string };
  /** The same protection replayed on every past opening, each priced only from the ones before it. Null with too little history. */
  replay: { nights: number; paidNights: number; paidPerDollar: number } | null;
};

export type GapReport = {
  structure: Structure;
  lines: GapLine[];
  /** Holdings the report couldn't cover, and why. */
  skipped: { symbol: string; reason: string }[];
  totals: {
    value: number;
    /** Over the lines that can be priced now. */
    premium: number;
    maxPayout: number;
    /** Every stock's worst recorded opening added up, as if they all came at once: a bound, not a forecast. */
    worstNightLoss: number;
    worstNightPaid: number;
  };
};

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * The report for `book`, with protection from `structure.deductible` to
 * `structure.depth` below each stock's price. `markets` has each stock's
 * Market, or null for one the caller can't price. Lines for the same stock
 * are added together.
 */
export function gapReport(
  now: number,
  book: readonly BookLine[],
  markets: ReadonlyMap<string, Market | null>,
  structure: Structure,
  cfg: QuoterConfig = DEFAULT_QUOTER_CONFIG,
): GapReport {
  if (!(structure.deductible >= 0 && structure.depth > structure.deductible)) throw new Error("protection must stop further below the price than it starts");
  const bySymbol = new Map<string, BookLine[]>();
  for (const l of book) {
    const symbol = l.symbol.toUpperCase();
    bySymbol.set(symbol, [...(bySymbol.get(symbol) ?? []), l]);
  }

  const lines: GapLine[] = [];
  const skipped: GapReport["skipped"] = [];
  for (const [symbol, held] of bySymbol) {
    const market = markets.get(symbol);
    if (!market) {
      skipped.push({ symbol, reason: "not covered" });
      continue;
    }
    if (market.history.length === 0) {
      skipped.push({ symbol, reason: "no recorded openings" });
      continue;
    }
    // Priced from what the quoter would price from; when sales are paused, valued at the live price.
    let reference: GapLine["reference"];
    let paused: string | null = null;
    try {
      reference = referencePrice(now, market, cfg);
    } catch (e) {
      paused = (e as Error).message;
      reference = { price: market.live ?? market.close, basis: "live" };
    }
    const shares = held.reduce((a, l) => a + (l.shares ?? 0) + (l.value ?? 0) / reference.price, 0);
    if (!(shares > 0)) {
      skipped.push({ symbol, reason: "no shares" });
      continue;
    }
    lines.push(line(now, market, shares, reference, paused, structure, cfg));
  }

  const priced = lines.flatMap((l) => ("premium" in l.tonight ? [l.tonight] : []));
  return {
    structure,
    lines,
    skipped,
    totals: {
      value: lines.reduce((a, l) => a + l.value, 0),
      premium: priced.reduce((a, t) => a + t.premium, 0),
      maxPayout: priced.reduce((a, t) => a + t.maxPayout, 0),
      worstNightLoss: lines.reduce((a, l) => a + l.worstNight.loss, 0),
      worstNightPaid: lines.reduce((a, l) => a + l.worstNight.protectionPays, 0),
    },
  };
}

function line(
  now: number,
  market: Market,
  shares: number,
  reference: GapLine["reference"],
  paused: string | null,
  structure: Structure,
  cfg: QuoterConfig,
): GapLine {
  const h = market.history;
  const gaps = h.map((o) => ({ from: o.from, to: o.to, gap: o.open / o.close - 1 }));
  const worst = gaps.reduce((w, g) => (g.gap < w.gap ? g : w));
  const protection = { shares, upper: round2(reference.price * (1 - structure.deductible)), lower: round2(reference.price * (1 - structure.depth)) };

  let tonight: GapLine["tonight"];
  if (paused) tonight = { unavailable: paused };
  else {
    try {
      // A book can be bigger than one quote may be; this prices all of it, as an indication.
      const p = priceQuote(now, market, protection, { ...cfg, maxShares: Number.POSITIVE_INFINITY });
      tonight = { openTs: p.openTs, premium: p.premium, maxPayout: p.maxPayout, probabilityOfPayout: p.probabilityOfPayout, upper: protection.upper, lower: protection.lower };
    } catch (e) {
      tonight = { unavailable: (e as Error).message };
    }
  }

  const r = backtest(h, structure, { shares: 1, annualVol: market.annualVol, margin: cfg.margin });
  return {
    symbol: market.symbol,
    shares,
    value: shares * reference.price,
    reference,
    history: {
      openings: h.length,
      from: h[0]!.from,
      to: h[h.length - 1]!.to,
      downAtLeast: DOWN_AT_LEAST.map((move) => ({ move, nights: gaps.filter((g) => g.gap <= -move).length })),
      worst,
    },
    worstNight: {
      loss: Math.max(0, -worst.gap) * shares * reference.price,
      protectionPays: payout(protection, reference.price * (1 + worst.gap)),
    },
    tonight,
    replay: r.nights.length > 0 ? { nights: r.nights.length, paidNights: r.paidNights, paidPerDollar: r.paidPerDollar } : null,
  };
}

/**
 * A book from text, as links and tools write it: "TSLA:100,NVDA:$25000"
 * (shares, or a dollar value with $). Throws on anything else.
 */
export function parseBook(text: string): BookLine[] {
  const book = text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const m = /^([A-Za-z.]{1,10}):(\$)?([0-9]+(?:\.[0-9]+)?)$/.exec(part);
      const amount = m ? Number(m[3]) : NaN;
      if (!m || !(amount > 0)) throw new Error(`"${part}" should look like TSLA:100 (shares) or NVDA:$25000 (dollars)`);
      return m[2] ? { symbol: m[1]!.toUpperCase(), value: amount } : { symbol: m[1]!.toUpperCase(), shares: amount };
    });
  if (book.length === 0) throw new Error("the book is empty");
  return book;
}

/** The inverse of parseBook, for links. */
export const formatBook = (book: readonly BookLine[]) =>
  book.map((l) => (l.value !== undefined ? `${l.symbol}:$${l.value}` : `${l.symbol}:${l.shares}`)).join(",");
