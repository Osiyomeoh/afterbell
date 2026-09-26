/**
 * Quotes for the EVM vault (evm/src/AfterbellVault.sol): the priced protection
 * in the contract's units, signed as EIP-712 typed data by the quoter.
 *
 * Units match the contract: shares with 6 decimals, prices with 8 (Chainlink's),
 * the premium in collateral units (6 decimals). Rounding never favours the
 * buyer against the vault: shares round down, the premium rounds up.
 */
import { hashTypedData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { Protection } from "./putSpread";

export const SHARE_SCALE = 1_000_000n;
export const PRICE_SCALE = 100_000_000n;
export const COLLATERAL_UNIT = 1_000_000n;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

export type EvmQuote = {
  buyer: Address;
  feed: Address;
  openTs: bigint;
  shares: bigint;
  upper: bigint;
  lower: bigint;
  premium: bigint;
  expiry: bigint;
  nonce: bigint;
};

export type VaultDomain = { chainId: number; vault: Address };

export const QUOTE_TYPES = {
  Quote: [
    { name: "buyer", type: "address" },
    { name: "feed", type: "address" },
    { name: "openTs", type: "uint64" },
    { name: "shares", type: "uint64" },
    { name: "upper", type: "uint64" },
    { name: "lower", type: "uint64" },
    { name: "premium", type: "uint128" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

const domain = (d: VaultDomain) => ({ name: "Afterbell", version: "1", chainId: d.chainId, verifyingContract: d.vault });

/** A random 256-bit nonce: quotes are single-use and the vault remembers every nonce it has seen. */
export function newNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return BigInt("0x" + Buffer.from(bytes).toString("hex"));
}

/** The contract's maximum payout for a quote, in collateral units (rounded down, as on-chain). */
export function maxPayoutUnits(q: Pick<EvmQuote, "shares" | "upper" | "lower">): bigint {
  return (q.shares * (q.upper - q.lower) * COLLATERAL_UNIT) / (SHARE_SCALE * PRICE_SCALE);
}

/**
 * Protection and premium in on-chain units, the same on both vaults: shares
 * round down, the strikes to the nearest unit, the premium up.
 */
export function toUnits(protection: Protection, premium: number): { shares: bigint; upper: bigint; lower: bigint; premium: bigint } {
  return {
    shares: BigInt(Math.floor(protection.shares * Number(SHARE_SCALE))),
    upper: BigInt(Math.round(protection.upper * Number(PRICE_SCALE))),
    lower: BigInt(Math.round(protection.lower * Number(PRICE_SCALE))),
    // toFixed(3) first, so floating-point noise (20.000000000001) doesn't round up a whole unit.
    premium: BigInt(Math.ceil(Number((premium * Number(COLLATERAL_UNIT)).toFixed(3)))),
  };
}

/** Converts priced protection (dollars and shares) into a quote in the contract's units. */
export function toEvmQuote(args: {
  buyer: Address;
  feed: Address;
  /** Unix seconds of the 09:30 ET open the protection settles on. */
  openTs: number;
  protection: Protection;
  /** Premium in dollars. */
  premium: number;
  /** Unix seconds after which the quote can't be used. */
  expiry: number;
  nonce?: bigint;
}): EvmQuote {
  const q: EvmQuote = {
    buyer: args.buyer,
    feed: args.feed,
    openTs: BigInt(args.openTs),
    ...toUnits(args.protection, args.premium),
    expiry: BigInt(args.expiry),
    nonce: args.nonce ?? newNonce(),
  };
  validateEvmQuote(q);
  return q;
}

/** The checks the contract makes on a quote's contents, so a bad quote fails before it's signed. */
export function validateEvmQuote(q: EvmQuote): void {
  for (const [name, v] of [["openTs", q.openTs], ["shares", q.shares], ["upper", q.upper], ["lower", q.lower], ["expiry", q.expiry]] as const) {
    if (v < 0n || v > U64_MAX) throw new Error(`${name} out of uint64 range`);
  }
  if (q.premium < 0n || q.premium > U128_MAX) throw new Error("premium out of uint128 range");
  if (q.shares === 0n) throw new Error("shares must be positive");
  if (q.upper <= q.lower) throw new Error("upper must be above lower");
  const max = maxPayoutUnits(q);
  if (max === 0n) throw new Error("protection pays nothing");
  if (q.premium > max) throw new Error("premium above the maximum payout");
  if (q.expiry >= q.openTs) throw new Error("quote must expire before the open");
}

export function hashEvmQuote(q: EvmQuote, d: VaultDomain): Hex {
  return hashTypedData({ domain: domain(d), types: QUOTE_TYPES, primaryType: "Quote", message: q });
}

export async function signEvmQuote(q: EvmQuote, d: VaultDomain, quoterKey: Hex): Promise<Hex> {
  validateEvmQuote(q);
  return privateKeyToAccount(quoterKey).signTypedData({ domain: domain(d), types: QUOTE_TYPES, primaryType: "Quote", message: q });
}
