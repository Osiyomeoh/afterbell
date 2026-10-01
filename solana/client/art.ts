/**
 * What a Solana position's NFT shows: evm/src/PositionArt.sol's card, drawn
 * from the position's accounts by the app (the NFT's metadata points there),
 * so an NFT looks the same on either chain. The stock, the opening, the
 * payoff (flat at the maximum below the lower strike, falling to nothing at
 * the upper), and, once the bell has rung, where it opened and what it paid.
 */

/** Everything the card shows. Prices carry 8 decimals, money 6, shares 6. */
export type Card = {
  number: bigint;
  symbol: string;
  openTs: bigint;
  shares: bigint;
  upper: bigint;
  lower: bigint;
  premium: bigint;
  maxPayout: bigint;
  state: "open" | "settled" | "voided";
  price: bigint;
  /** What it pays at `price` (settled) or paid, and whether it has been paid out. */
  payout: bigint;
  closed: boolean;
  /** Its NFT was burned before it was paid, so its payout stayed in the pool. */
  forfeited: boolean;
};

const GOLD = "#c9a45c";
const INK = "#101214";
const TEXT = "#ecebe7";
const MUTED = "#8b9098";
const GAIN = "#6fcf97";

/** The NFT's JSON metadata, in the shape wallets and marketplaces read. The name is the one on-chain. */
export function metadata(c: Card, image: string) {
  const traits: [string, string][] = [
    ["Stock", c.symbol],
    ["Opening", date(c.openTs)],
    ["Shares", shares(c.shares)],
    ["Protected from", `$${price(c.upper)}`],
    ["Down to", `$${price(c.lower)}`],
    ["Premium", `$${money(c.premium)}`],
    ["Pays up to", `$${money(c.maxPayout)}`],
    ["Status", c.state === "open" ? "Open" : c.forfeited ? "Forfeited" : c.state === "voided" ? "Voided" : c.closed ? "Paid" : "Settled"],
  ];
  return {
    name: `Afterbell #${c.number} ${c.symbol}`,
    symbol: "BELL",
    description: `A put spread on ${c.symbol}'s next opening print, settled on-chain on Pyth's first print at or after 09:30 ET. Its payout goes to whoever holds this token. Collateral is TestUSD, which has no value.`,
    image,
    attributes: traits.map(([trait_type, value]) => ({ trait_type, value })),
  };
}

export function svg(c: Card): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" font-family="ui-monospace,Menlo,monospace"><rect width="400" height="400" rx="22" fill="${INK}"/>`,
    text(28, 46, 12, GOLD, `AFTERBELL  PROTECTION #${c.number}`),
    `<text x="28" y="98" font-size="44" font-family="Georgia,serif" fill="${TEXT}">${escape(c.symbol)}</text>`,
    text(28, 126, 13, MUTED, `until the 09:30 ET open, ${date(c.openTs)}`),
    chart(c),
    text(28, 338, 14, TEXT, `${shares(c.shares)}${c.shares === 1_000_000n ? " share" : " shares"}  |  cost $${money(c.premium)}`),
    text(28, 364, 14, statusColor(c), status(c)),
    "</svg>",
  ].join("");
}

// ------------------------------------------------------------------- the chart

function chart(c: Card): string {
  // Price axis from 0.75 spreads below the lower strike to 0.75 above the upper one.
  const pad = ((c.upper - c.lower) * 3n) / 4n + 1n;
  const lo = c.lower > pad ? c.lower - pad : 0n;
  const hi = c.upper + pad;
  const xl = x(c.lower, lo, hi);
  const xu = x(c.upper, lo, hi);
  let out =
    `<line x1="28" y1="292" x2="372" y2="292" stroke="#2a2e33"/><polyline fill="none" stroke="${GOLD}" stroke-width="3" stroke-linejoin="round" points="28,176 ${xl},176 ${xu},292 372,292"/>` +
    text(28, 166, 12, MUTED, `pays up to $${money(c.maxPayout)}`) +
    text(xl, 312, 11, MUTED, `$${price(c.lower)}`) +
    text(xu, 312, 11, MUTED, `$${price(c.upper)}`);
  if (c.state === "settled") {
    const xp = x(c.price, lo, hi);
    out += `<line x1="${xp}" y1="150" x2="${xp}" y2="292" stroke="${TEXT}" stroke-dasharray="4 4"/>`;
  }
  return out;
}

/** A price's x position on the chart, clamped to its edges. */
function x(p: bigint, lo: bigint, hi: bigint): bigint {
  if (p <= lo) return 28n;
  if (p >= hi) return 372n;
  return 28n + ((p - lo) * 344n) / (hi - lo);
}

// ------------------------------------------------------------------- the words

function status(c: Card): string {
  if (c.state === "open") return "Open until the bell";
  if (c.forfeited) return "Forfeited: its NFT was burned";
  if (c.state === "voided") return c.closed ? "Voided: premium refunded" : "Voided: premium to refund";
  return `Opened at $${price(c.price)}${c.closed ? "  |  paid $" : "  |  pays $"}${money(c.payout)}`;
}

const statusColor = (c: Card) => (c.state === "settled" && c.payout > 0n && !c.forfeited ? GAIN : c.state === "open" ? TEXT : MUTED);

const text = (x: bigint | number, y: number, size: number, fill: string, body: string) =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}">${escape(body)}</text>`;

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// -------------------------------------------------------------- number formats

const pad = (v: bigint, digits: number) => v.toString().padStart(digits, "0");
const fixed = (v: bigint, places: number) => {
  const unit = 10n ** BigInt(places);
  return `${v / unit}.${pad(v % unit, places)}`;
};

/** A price with 8 decimals as dollars and cents, rounded to the nearest cent: 38382840000 is "383.83". */
export const price = (p: bigint) => fixed((p + 500_000n) / 1_000_000n, 2);

/** Money with 6 decimals as dollars and cents, rounded to the nearest cent. */
export const money = (m: bigint) => fixed((m + 5_000n) / 10_000n, 2);

/** Shares with 6 decimals, without trailing zeros: 10000000 is "10", 2500000 is "2.5". */
export function shares(s: bigint): string {
  const whole = s / 1_000_000n;
  const frac = s % 1_000_000n;
  return frac === 0n ? whole.toString() : `${whole}.${pad(frac, 6).replace(/0+$/, "")}`;
}

/** The UTC date of a timestamp, as "28 Sep 2026". Every US opening falls on the same date in UTC as in New York. */
export function date(ts: bigint): string {
  const d = new Date(Number(ts) * 1000);
  return `${d.getUTCDate()} ${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${d.getUTCFullYear()}`;
}
