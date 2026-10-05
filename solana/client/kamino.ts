/**
 * Kamino lending instructions, built with Kamino's SDK and handed back as
 * web3.js instructions so they share a transaction with the vault's: the
 * holder claims a payout and repays their loan with it, atomically.
 */
import {
  DEFAULT_RECENT_SLOT_DURATION_MS,
  KaminoAction,
  KaminoMarket,
  PROGRAM_ID as KLEND_PROGRAM_ID,
  VanillaObligation,
} from "@kamino-finance/klend-sdk";
import { address, createNoopSigner, createSolanaRpc, type Instruction } from "@solana/kit";
import { Connection, PublicKey, TransactionInstruction, type AccountMeta } from "@solana/web3.js";

import { processInstruction } from "./vault";

type Action = "deposit" | "borrow" | "repay";

/** A Kamino SDK instruction as web3.js takes it. Roles: 1 writable, 2 signer, 3 both. */
export function toLegacy(ix: Instruction): TransactionInstruction {
  const keys: AccountMeta[] = (ix.accounts ?? []).map((a) => ({
    pubkey: new PublicKey(a.address),
    isSigner: (a.role & 2) !== 0,
    isWritable: (a.role & 1) !== 0,
  }));
  return new TransactionInstruction({ programId: new PublicKey(ix.programAddress), keys, data: Buffer.from(ix.data ?? new Uint8Array()) });
}

/** A Kamino market, read through the connection's RPC. */
export async function loadKaminoMarket(connection: Connection, market: PublicKey): Promise<KaminoMarket> {
  const rpc = createSolanaRpc(connection.rpcEndpoint);
  const m = await KaminoMarket.load(rpc as never, address(market.toBase58()), DEFAULT_RECENT_SLOT_DURATION_MS);
  if (!m) throw new Error(`no Kamino market at ${market.toBase58()}`);
  return m;
}

/**
 * The instructions for one Kamino action on `owner`'s first (vanilla) obligation, in order:
 * refreshes and setup, the action, cleanup. `amount` is in the token's smallest units.
 */
export async function kaminoInstructions(
  connection: Connection,
  market: KaminoMarket,
  action: Action,
  { owner, reserve, amount }: { owner: PublicKey; reserve: PublicKey; amount: bigint },
): Promise<TransactionInstruction[]> {
  await market.loadReserves();
  const slot = await connection.getSlot("confirmed");
  const blockTime = (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
  const props = {
    kaminoMarket: market,
    amount: amount.toString(),
    reserveAddress: address(reserve.toBase58()),
    owner: createNoopSigner(address(owner.toBase58())),
    obligation: new VanillaObligation(KLEND_PROGRAM_ID),
    useV2Ixs: true,
    scopeRefreshConfig: undefined,
    includeAtaIxs: true,
    currentLedgerInstant: { slot: BigInt(slot), blockTime: BigInt(blockTime) },
  } as const;
  const built =
    action === "deposit"
      ? await KaminoAction.buildDepositTxns({ ...props, initUserMetadata: { skipInitialization: false, skipLutCreation: true } } as never)
      : action === "borrow"
        ? await KaminoAction.buildBorrowTxns(props as never)
        : await KaminoAction.buildRepayTxns(props as never);
  return KaminoAction.actionToIxs(built).map(toLegacy);
}

/**
 * Claim a payout and repay a Kamino loan with it, in one transaction: the vault pays the holder's own
 * position into their account, then Kamino takes `repay` of it against their obligation's debt. If
 * either fails, neither happens.
 */
export async function claimAndRepayInstructions(
  connection: Connection,
  market: KaminoMarket,
  claim: Parameters<typeof processInstruction>,
  { owner, reserve, repay }: { owner: PublicKey; reserve: PublicKey; repay: bigint },
): Promise<TransactionInstruction[]> {
  return [await processInstruction(...claim), ...(await kaminoInstructions(connection, market, "repay", { owner, reserve, amount: repay }))];
}
