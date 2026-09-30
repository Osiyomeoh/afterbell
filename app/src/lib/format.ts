export const usd = (v: number, digits = 2) => `$${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
/** "+$5.21", "−$4.46", "$0.00": a result, signed, with the minus sign typeset. */
export const signedUsd = (v: number, digits = 2) => {
  const shown = usd(Math.abs(v), digits);
  return shown === usd(0, digits) ? shown : `${v < 0 ? "−" : "+"}${shown}`;
};
export const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;
/** A probability, without rounding a tiny one to "0.00%". */
export const chance = (p: number) => (p < 0.0001 ? "under 0.01%" : `${(p * 100).toFixed(p < 0.1 ? 2 : 1)}%`);
/** The same, in a sentence: "a 2.35% chance", "less than a 0.01% chance". */
export const aChance = (p: number) => (p < 0.0001 ? "less than a 0.01% chance" : `a ${chance(p)} chance`);

/** "Mon 28 Sep, 09:30 ET" */
export function nyTime(unix: number): string {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(unix * 1000)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute} ET`;
}

/** "2d 07h 12m" */
export function countdown(secs: number): string {
  if (secs <= 0) return "now";
  const d = Math.floor(secs / 86_400);
  const h = Math.floor((secs % 86_400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return d > 0 ? `${d}d ${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m` : `${h}h ${String(m).padStart(2, "0")}m`;
}

export const explorer = (kind: "tx" | "address", id: string) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

/** "Wed 22 Jul", for a NY calendar date like "2026-07-22". */
export function dayLabel(iso: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" })
      .formatToParts(new Date(`${iso}T12:00:00Z`))
      .map((x) => [x.type, x.value]),
  );
  return `${p.weekday} ${p.day} ${p.month}`;
}

/** "09:30:01 ET" */
export function nyClock(unix: number): string {
  return `${new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(unix * 1000))} ET`;
}

/**
 * Past this, a payout multiple says "lottery ticket" more than it informs:
 * protection priced at a cent because it almost never pays. The chance says it better.
 */
export const MAX_MULTIPLE = 200;
