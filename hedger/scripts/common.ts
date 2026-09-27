/** What the hedger's and the quoter's scripts share: settings, API wallet keys, the run loop, and how they print. */
import type { Address, Hex, LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { Network } from "../hyperliquid";

export const iso = (secs: number) => new Date(secs * 1000).toISOString().replace(".000Z", "Z");
export const usd = (x: number) => `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const sh = (x: number) => x.toFixed(3);

/**
 * A warning when an account holds nothing on the coin's dex: each builder dex
 * margins separately, so USDC elsewhere in the account can't back an order
 * there. Null when there's something to trade with.
 */
export function emptyDexNote(accountValue: number, dex: string): string | null {
  return accountValue > 0 ? null : `note: the account holds nothing on the ${dex} dex; move USDC there first, its orders need margin on that dex`;
}

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

/**
 * The key of an API wallet the account has approved, from the environment
 * (set in the shell, never in a file). Refused when it's the account's own
 * key: the scripts hold only keys that trade for the account. The key is
 * never printed.
 */
export function agentKey(name: string, account: Address): LocalAccount {
  const key = process.env[name];
  if (!key) throw new Error(`set ${name} to the API wallet's private key, in your shell`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${name} isn't a private key (0x and 64 hex digits)`);
  const signer = privateKeyToAccount(key as Hex);
  if (signer.address.toLowerCase() === account.toLowerCase()) {
    throw new Error(`${name} is the account's own key: approve an API wallet for ${account} and use its key instead`);
  }
  return signer;
}

/** `--every <seconds>` from the command line, in ms; null runs once. */
export function everyMs(): number | null {
  const i = process.argv.indexOf("--every");
  if (i < 0) return null;
  const secs = Number(process.argv[i + 1]);
  if (!(secs >= 5)) throw new Error("--every takes a number of seconds, at least 5");
  return secs * 1000;
}

/**
 * Runs `tick` now and again at the time it returns, until SIGINT or SIGTERM,
 * then resolves once the tick in flight is done. A tick that fails is
 * reported and retried after `retryMs`: one failed read mustn't stop the
 * runs after it.
 */
export async function loop(tick: () => Promise<number>, retryMs: number): Promise<void> {
  let stopped = false;
  let wake = () => {};
  const stop = () => {
    stopped = true;
    wake();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  while (!stopped) {
    let next: number;
    try {
      next = await tick();
    } catch (e) {
      console.error(`${iso(Math.floor(Date.now() / 1000))} failed: ${e instanceof Error ? e.message : e}`);
      next = Date.now() + retryMs;
    }
    if (stopped) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, next - Date.now()));
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}

/** A number, at least 0, from the environment, or the default when it's unset. */
export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const x = Number(raw);
  if (!(x >= 0)) throw new Error(`${name} must be a number, at least 0`);
  return x;
}
