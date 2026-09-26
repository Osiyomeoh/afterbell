export const usd = (v: number, digits = 2) => `$${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
export const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;

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
