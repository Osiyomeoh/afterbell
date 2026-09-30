/**
 * Who counts as an outside buyer, for the counter on /verify. Every purchase before the first campaign,
 * Tesla's third-quarter deliveries (protection for the Friday 2 October open), was the team's, so a
 * wallet counts as outside only if its first purchase is for that open or later and it isn't one of
 * ours. Add any wallet of ours that buys after that here.
 */

/** The first open aimed at outside buyers: Friday 2 October 2026, 09:30 ET. */
export const FIRST_CAMPAIGN_OPEN = Date.parse("2026-10-02T13:30:00Z") / 1000;

/** Wallets and contracts of ours that buy protection (lowercased for EVM). */
export const TEAM_WALLETS: ReadonlySet<string> = new Set([
  // Solana devnet: the vaults' authority, and the private desk's desks and holders.
  "GZP4hLs8gqxPNuRtsAkzbWiZQKYch8m6hyDDuSyJXZde",
  "3iiuzCYxzCW9SKMAqFSGjL5cmTYGMahVivHkcdygo3Hk",
  "Dmqcim6dHaPkxxzLVjXYrEwyhnzSzbBw4GvoLqtboCNV",
  "FL1PSYmNFZxgE4WHyMXSojnCZuYhSGAdZghjRPkhxaWf",
  "8a2pWdwozLdR4JDKFdS9n3yhpcneCHAmr5mjTKKWG81C",
  // Robinhood Chain: the team's wallet, the vault's owner, the renewer and its keeper.
  "0x81b8361bdb60a9483b432dae88101a5bc0f76378",
  "0x63e37160334fbea25f1c5df6f3a69af1906efcd1",
  "0x710df188d43f6778e84c83025ee589c292544627",
  "0xa2bf5e00e572fe03e95448e1c116f2120ce38513",
]);

export type Sale = { chain: "solana" | "robinhood"; buyer: string; openTs: number };

const key = (s: Sale) => (s.chain === "robinhood" ? s.buyer.toLowerCase() : s.buyer);

/** The distinct wallets that have bought, and those of them that are outside buyers under the rule above. */
export function buyers(sales: readonly Sale[], team: ReadonlySet<string> = TEAM_WALLETS, firstOpen = FIRST_CAMPAIGN_OPEN): { all: string[]; outside: string[] } {
  const first = new Map<string, number>();
  for (const s of sales) first.set(key(s), Math.min(first.get(key(s)) ?? Infinity, s.openTs));
  const all = [...first.keys()];
  return { all, outside: all.filter((w) => !team.has(w) && first.get(w)! >= firstOpen) };
}
