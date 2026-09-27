/** What the hedger's and the quoter's scripts share: settings from the environment, and how they print. */
import type { Network } from "../hyperliquid";

export const iso = (secs: number) => new Date(secs * 1000).toISOString().replace(".000Z", "Z");
export const usd = (x: number) => `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const sh = (x: number) => x.toFixed(3);

/** Where the hedge trades: testnet unless HYPERLIQUID_NETWORK says mainnet. */
export function hedgeNetwork(): Network {
  const n = process.env.HYPERLIQUID_NETWORK ?? "testnet";
  if (n !== "testnet" && n !== "mainnet") throw new Error(`HYPERLIQUID_NETWORK is testnet or mainnet, not "${n}"`);
  return n;
}

/** HEDGE_MAX_NOTIONAL: the most the short may be worth, in dollars (default 1500: about what 500 mock USDC of margin carries at 3×). */
export function maxNotional(): number {
  const x = Number(process.env.HEDGE_MAX_NOTIONAL ?? 1500);
  if (!(x > 0)) throw new Error("HEDGE_MAX_NOTIONAL must be a positive number of dollars");
  return x;
}

/** A number, at least 0, from the environment, or the default when it's unset. */
export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const x = Number(raw);
  if (!(x >= 0)) throw new Error(`${name} must be a number, at least 0`);
  return x;
}
