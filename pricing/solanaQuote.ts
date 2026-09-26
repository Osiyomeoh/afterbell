/**
 * Quotes for the Solana vault (solana/programs/afterbell-vault): the exact
 * bytes the program rebuilds and checks, signed with ed25519 by the quoter.
 * The buyer's transaction carries the signature in an Ed25519 program
 * instruction placed right before `buy`.
 *
 * Units match the program: shares with 6 decimals, prices with 8, the premium
 * in collateral units.
 */
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";

export const QUOTE_PREFIX = new TextEncoder().encode("afterbell:quote:v1");
export const QUOTE_MESSAGE_LEN = 18 + 32 * 4 + 8 * 6 + 32;

export type SolanaQuote = {
  /** Pyth feed id, 32 bytes. */
  feedId: Uint8Array;
  openTs: bigint;
  shares: bigint;
  upper: bigint;
  lower: bigint;
  premium: bigint;
  expiry: bigint;
  /** 32 random bytes; the position's address derives from it, so a quote buys once. */
  nonce: Uint8Array;
};

const pubkeyBytes = (base58: string) => {
  const b = bs58.decode(base58);
  if (b.length !== 32) throw new Error(`not a 32-byte public key: ${base58}`);
  return b;
};

function le64(v: bigint, signed: boolean): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  if (signed) view.setBigInt64(0, v, true);
  else view.setBigUint64(0, v, true);
  return out;
}

/** prefix ‖ program id ‖ vault ‖ buyer ‖ feed id ‖ open_ts ‖ shares ‖ upper ‖ lower ‖ premium ‖ expiry ‖ nonce */
export function solanaQuoteMessage(programId: string, vault: string, buyer: string, q: SolanaQuote): Uint8Array {
  if (q.feedId.length !== 32 || q.nonce.length !== 32) throw new Error("feed id and nonce must be 32 bytes");
  const parts = [
    QUOTE_PREFIX,
    pubkeyBytes(programId),
    pubkeyBytes(vault),
    pubkeyBytes(buyer),
    q.feedId,
    le64(q.openTs, true),
    le64(q.shares, false),
    le64(q.upper, false),
    le64(q.lower, false),
    le64(q.premium, false),
    le64(q.expiry, true),
    q.nonce,
  ];
  const out = new Uint8Array(QUOTE_MESSAGE_LEN);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Signs with the quoter's 32-byte ed25519 secret seed. */
export function signSolanaQuote(message: Uint8Array, quoterSeed: Uint8Array): Uint8Array {
  return ed25519.sign(message, quoterSeed);
}

export const quoterPublicKey = (quoterSeed: Uint8Array) => bs58.encode(ed25519.getPublicKey(quoterSeed));

/**
 * Data for the Ed25519 program instruction that verifies one signature, with
 * the key, signature and message all inside this instruction (instruction
 * index 0xFFFF), the only layout the vault accepts.
 */
export function ed25519InstructionData(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): Uint8Array {
  const keyOffset = 16;
  const sigOffset = keyOffset + 32;
  const msgOffset = sigOffset + 64;
  const out = new Uint8Array(msgOffset + message.length);
  const view = new DataView(out.buffer);
  out[0] = 1;
  const fields = [sigOffset, 0xffff, keyOffset, 0xffff, msgOffset, message.length, 0xffff];
  fields.forEach((v, i) => view.setUint16(2 + i * 2, v, true));
  out.set(publicKey, keyOffset);
  out.set(signature, sigOffset);
  out.set(message, msgOffset);
  return out;
}
