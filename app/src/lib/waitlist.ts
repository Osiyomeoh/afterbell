import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";

import { stockBySymbol } from "@root/quoter/stocks";

/**
 * The mainnet waitlist, kept on Solana devnet rather than in a database: joining is a transaction that
 * sends nothing to WAITLIST, with a memo saying who you are and what you'd protect. One look-up by that
 * address lists every signup, so anyone can count them; no one holds its key.
 */
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const WAITLIST = PublicKey.findProgramAddressSync([new TextEncoder().encode("afterbell-waitlist")], MEMO_PROGRAM_ID)[0];

export const ROLES = {
  holder: "I hold tokenized stocks",
  borrower: "I borrow against them",
  protocol: "I run a protocol, vault or fund",
  agent: "I build trading agents",
} as const;
export type Role = keyof typeof ROLES;

/** The most stocks one signup names. */
export const MAX_STOCKS = 5;

const PREFIX = "afterbell waitlist v1";

/** Stocks we list, uppercased, without repeats, at most MAX_STOCKS. */
function cleanStocks(stocks: readonly string[]): string[] {
  const known = stocks.map((s) => stockBySymbol(s.trim())?.symbol).filter((s): s is string => s !== undefined);
  return [...new Set(known)].slice(0, MAX_STOCKS);
}

export function waitlistMemo(role: Role, stocks: readonly string[]): string {
  return `${PREFIX} role=${role} stocks=${cleanStocks(stocks).join(",")}`;
}

/** A signup's memo, or null for anything else sent to the address. */
export function parseWaitlistMemo(text: string): { role: Role; stocks: string[] } | null {
  const m = /^afterbell waitlist v1 role=([a-z]+) stocks=([A-Z0-9.,]*)$/.exec(text.trim());
  const [, role, list] = m ?? [];
  if (role === undefined || !(role in ROLES)) return null;
  return { role: role as Role, stocks: cleanStocks(list ? list.split(",") : []) };
}

/** The signup the wallet signs: nothing sent to the waitlist's address, and the memo, signed by the wallet. */
export function joinWaitlistTx(owner: PublicKey, role: Role, stocks: readonly string[]): Transaction {
  return new Transaction().add(
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: WAITLIST, lamports: 0 }),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [{ pubkey: owner, isSigner: true, isWritable: false }],
      data: Buffer.from(waitlistMemo(role, stocks), "utf8"),
    }),
  );
}

export type Signup = { wallet: string; role: Role; stocks: string[]; signature: string; time: number };

export type WaitlistView = {
  /** Wallets on the list, the team's left out. */
  count: number;
  byRole: Record<Role, number>;
  /** Of those wallets, how many bought test cover from the vault as well. */
  tried: number;
  /** Outside wallets that have bought test cover, joined or not. */
  testers: number;
  /** The stocks the list asks for, most-named first. */
  wanted: { symbol: string; count: number }[];
  /** The latest signups first, the team's left out. */
  signups: Signup[];
  address: string;
};

/**
 * Counts the list: each wallet once, at its latest signup (it may change its answer), the team's
 * wallets left out. `buyers` are the outside wallets that bought test cover.
 */
export function tally(signups: readonly Signup[], team: ReadonlySet<string>, buyers: ReadonlySet<string>): WaitlistView {
  const latest = new Map<string, Signup>();
  for (const s of signups) if (!team.has(s.wallet) && (latest.get(s.wallet)?.time ?? -Infinity) < s.time) latest.set(s.wallet, s);
  const list = [...latest.values()].sort((a, b) => b.time - a.time);
  const byRole = Object.fromEntries(Object.keys(ROLES).map((r) => [r, 0])) as Record<Role, number>;
  for (const s of list) byRole[s.role]++;
  const named = new Map<string, number>();
  for (const s of list) for (const symbol of s.stocks) named.set(symbol, (named.get(symbol) ?? 0) + 1);
  const wanted = [...named].map(([symbol, count]) => ({ symbol, count })).sort((a, b) => b.count - a.count || a.symbol.localeCompare(b.symbol));
  return {
    count: list.length,
    byRole,
    tried: list.filter((s) => buyers.has(s.wallet)).length,
    testers: buyers.size,
    wanted,
    signups: list,
    address: WAITLIST.toBase58(),
  };
}
