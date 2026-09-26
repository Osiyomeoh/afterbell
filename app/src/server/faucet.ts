import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction } from "@solana/web3.js";

const UNIT = 1_000_000n; // TestUSD has 6 decimals
const DRIP = 1_000n * UNIT;
const REFILL_BELOW = 100n * UNIT;
const SOL_DRIP = 0.02 * LAMPORTS_PER_SOL;
const SOL_REFILL_BELOW = 0.01 * LAMPORTS_PER_SOL;

export type DripResult = { signature: string | null; testUsd: number; sol: number };

/**
 * Devnet faucet, as in Weekend Markets: tops a wallet up to 1,000 TestUSD
 * when it holds less than 100, and sends 0.02 SOL for fees and account rent
 * when it holds less than 0.01. Stateless: a wallet that isn't low gets nothing.
 * The faucet key is TestUSD's mint authority and pays for everything.
 */
export async function drip(connection: Connection, faucet: Keypair, mint: PublicKey, owner: PublicKey): Promise<DripResult> {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  const [tokens, lamports] = await Promise.all([
    connection.getTokenAccountBalance(ata).then((b) => BigInt(b.value.amount), () => 0n),
    connection.getBalance(owner),
  ]);
  const tx = new Transaction();
  const result: DripResult = { signature: null, testUsd: 0, sol: 0 };
  if (tokens < REFILL_BELOW) {
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(faucet.publicKey, ata, owner, mint),
      createMintToInstruction(mint, ata, faucet.publicKey, DRIP),
    );
    result.testUsd = Number(DRIP / UNIT);
  }
  if (lamports < SOL_REFILL_BELOW) {
    tx.add(SystemProgram.transfer({ fromPubkey: faucet.publicKey, toPubkey: owner, lamports: SOL_DRIP }));
    result.sol = SOL_DRIP / LAMPORTS_PER_SOL;
  }
  if (tx.instructions.length === 0) return result;
  if ((await connection.getBalance(faucet.publicKey)) < SOL_DRIP + 0.005 * LAMPORTS_PER_SOL) {
    throw new Error("The faucet is out of devnet SOL. Try again later.");
  }
  result.signature = await sendAndConfirmTransaction(connection, tx, [faucet], { commitment: "confirmed" });
  return result;
}
