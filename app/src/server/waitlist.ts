import { Connection } from "@solana/web3.js";

import { buyers, TEAM_WALLETS } from "@/lib/team";
import { MEMO_PROGRAM_ID, parseWaitlistMemo, tally, WAITLIST, type Signup, type WaitlistView } from "@/lib/waitlist";

import { RPC, solanaVaultState } from "./chain";
import { evmVaultState } from "./evmChain";

const TTL_MS = 20_000;
let cache: { at: number; view: Promise<WaitlistView> } | null = null;

/** Every signup sent to the waitlist's address on devnet, newest first: the wallet that signed it and its memo. */
async function signups(connection: Connection): Promise<Signup[]> {
  const sigs = (await connection.getSignaturesForAddress(WAITLIST, { limit: 1000 })).filter((s) => s.err === null);
  const out: Signup[] = [];
  for (let i = 0; i < sigs.length; i += 100) {
    const batch = sigs.slice(i, i + 100);
    const txs = await connection.getParsedTransactions(
      batch.map((s) => s.signature),
      { maxSupportedTransactionVersion: 0, commitment: "confirmed" },
    );
    txs.forEach((tx, j) => {
      const sig = batch[j];
      // The fee payer signed the memo: it's the wallet joining.
      const payer = tx?.transaction.message.accountKeys[0];
      if (!tx || !sig || !payer) return;
      const memo = tx.transaction.message.instructions.find((ix) => ix.programId.equals(MEMO_PROGRAM_ID));
      const parsed = memo && "parsed" in memo && typeof memo.parsed === "string" ? parseWaitlistMemo(memo.parsed) : null;
      if (!parsed) return;
      out.push({ wallet: payer.pubkey.toBase58(), ...parsed, signature: sig.signature, time: tx.blockTime ?? sig.blockTime ?? 0 });
    });
  }
  return out;
}

/** The list, and how many outside wallets have bought test cover, shared by every visitor for 20 seconds. */
export function waitlistView(): Promise<WaitlistView> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.view;
  const view = (async () => {
    const [list, solana, evm] = await Promise.all([
      signups(new Connection(RPC, "confirmed")),
      solanaVaultState()?.catch(() => null) ?? null,
      evmVaultState()?.catch(() => null) ?? null,
    ]);
    const outside = new Set(buyers([...(solana?.sales ?? []), ...(evm?.sales ?? [])]).outside);
    return tally(list, TEAM_WALLETS, outside);
  })();
  cache = { at: Date.now(), view };
  view.catch(() => (cache = null));
  return view;
}
