import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { Keypair } from "@solana/web3.js";

/**
 * A Solana keypair from the environment: `${name}` holds the keypair file's
 * contents (a JSON array of 64 numbers), or `${name}_FILE` its path. Keys
 * are only ever read here, to sign; never logged or returned.
 */
export function keypairFromEnv(name: string): Keypair | null {
  const inline = process.env[name];
  const file = process.env[`${name}_FILE`];
  const json = inline || (file ? readFileSync(file.replace(/^~(?=\/)/, homedir()), "utf8") : null);
  if (!json) return null;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(json)));
}
