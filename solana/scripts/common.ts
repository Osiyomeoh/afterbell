/** What the Solana scripts share: the fee payer's keypair file, and times as readable UTC. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Keypair } from "@solana/web3.js";

/** ANCHOR_WALLET, or the Solana CLI's default keypair. */
export const walletPath = () => process.env.ANCHOR_WALLET ?? join(homedir(), ".config/solana/id.json");

export const loadKeypair = (path: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path.replace(/^~(?=\/)/, homedir()), "utf8"))));

export const iso = (secs: number) => new Date(secs * 1000).toISOString().replace(".000Z", "Z");
