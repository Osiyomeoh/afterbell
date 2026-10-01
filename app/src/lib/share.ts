import { eventAt } from "./events";
import { nyTime, usd } from "./format";

/** A position as its share page shows it, from either chain. */
export type ShareView = {
  chain: "solana" | "robinhood";
  /** The Solana position's address, or the Robinhood Chain position's number. */
  id: string;
  /** Its NFT's number. */
  number: string;
  symbol: string;
  openTs: number;
  shares: number;
  upper: number;
  lower: number;
  premium: number;
  maxPayout: number;
  state: "open" | "settled" | "voided";
  /** The opening price it settled on. */
  price: number | null;
  /** What it pays or paid once settled; the premium back if its series voided. */
  payout: number | null;
  /** Its NFT's image. */
  art: string;
};

/** Where a position's share page is. */
export const sharePath = (chain: ShareView["chain"], id: string) => `/p/${chain}/${id}`;

/** "Friday" */
const weekday = (unix: number) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long" }).format(new Date(unix * 1000));
/** "Fri 2 Oct" */
const day = (unix: number) => nyTime(unix).split(",")[0]!;
const shareCount = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${n === 1 ? "share" : "shares"}`;

/** The headline: what it protects, or how it came out. */
export function headline(v: ShareView): string {
  if (v.state === "voided") return `${v.symbol}'s opening couldn't be settled: premium refunded`;
  if (v.state === "open") return `${shareCount(v.shares)} of ${v.symbol}, protected until ${weekday(v.openTs)}'s opening bell`;
  if ((v.payout ?? 0) > 0) return `Paid ${usd(v.payout!)} when ${v.symbol} opened at ${usd(v.price!)}`;
  return `${v.symbol} opened at ${usd(v.price!)}, above this protection`;
}

/** A sentence or two under the headline, with the numbers. */
export function outcome(v: ShareView): string {
  const event = eventAt(v.symbol, v.openTs);
  if (v.state === "open") {
    return (
      `${shareCount(v.shares)} of ${v.symbol}, protected from ${usd(v.upper)} down to ${usd(v.lower)} until the 09:30 ET open on ${day(v.openTs)}` +
      `${event ? `, the one expected to carry ${event.title}` : ""}. It cost ${usd(v.premium)} and pays up to ${usd(v.maxPayout)}, settled on the opening price.`
    );
  }
  if (v.state === "voided") return `The series wasn't settled in time, so the whole ${usd(v.premium)} premium went back to the holder.`;
  const paid = v.payout ?? 0;
  if (paid <= 0) {
    return `${v.symbol} opened at ${usd(v.price!)} on ${day(v.openTs)}, above ${usd(v.upper)} where this protection started, so it paid nothing. The ${usd(v.premium)} premium went to the pool's underwriters.`;
  }
  const most = v.price! <= v.lower ? " the most it could," : "";
  return `${v.symbol} opened at ${usd(v.price!)} on ${day(v.openTs)}, below ${usd(v.upper)} where this protection started. It paid${most} ${usd(paid)} for a ${usd(v.premium)} premium.`;
}

/** What the share button posts. It always says the money is test money. */
export function shareText(v: ShareView): string {
  const event = eventAt(v.symbol, v.openTs);
  const tail = "Test money, real oracle.";
  if (v.state === "open") {
    return `I protected ${shareCount(v.shares)} of ${v.symbol} until ${weekday(v.openTs)}'s opening bell${event ? `, through ${event.title}` : ""}, with Afterbell: ${usd(v.premium)} for up to ${usd(v.maxPayout)}. ${tail}`;
  }
  if (v.state === "voided") return `My Afterbell protection on ${v.symbol} couldn't be settled, so I got the whole ${usd(v.premium)} premium back. ${tail}`;
  const paid = v.payout ?? 0;
  if (paid > 0) return `${v.symbol} opened at ${usd(v.price!)} and my Afterbell protection paid ${usd(paid)}, for ${usd(v.premium)}. ${tail}`;
  return `${v.symbol} opened at ${usd(v.price!)}, above my Afterbell protection, so it paid nothing and the ${usd(v.premium)} went to the underwriters. ${tail}`;
}
