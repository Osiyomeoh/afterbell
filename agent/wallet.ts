/**
 * The local agent's own devnet wallet: created on first use, funded from the
 * Afterbell faucet, buying protection under a spending cap and paying out the
 * positions whose NFTs it holds.
 * Only the local MCP server uses this; the hosted endpoint holds no keys.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";

import { solanaPurchase, type AfterbellClient } from "../sdk";
import { getProgram, processInstruction } from "../solana/client/vault";
import { describe, protectionFor, SOLANA_RPC, type AgentWalletTools } from "./tools";

// Positions paid out per transaction: well inside the seven one `process` fits, next to creating the TestUSD account.
const CLAIMS_PER_TX = 3;
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

/** The agent's wallet file, outside any repo: ~/.config/afterbell/agent-devnet.json unless AGENT_KEYPAIR says otherwise. */
export const keypairPath = () => (process.env.AGENT_KEYPAIR || join(homedir(), ".config", "afterbell", "agent-devnet.json")).replace(/^~(?=\/)/, homedir());

/** Most the agent may pay for one purchase, in TestUSD. Set by the person running it. */
export const maxSpend = () => {
  const cap = Number(process.env.AGENT_MAX_SPEND || 25);
  if (!(cap > 0)) throw new Error(`AGENT_MAX_SPEND must be a positive number of TestUSD, not "${process.env.AGENT_MAX_SPEND}"`);
  return cap;
};

function load(): { keypair: Keypair; created: boolean } {
  const path = keypairPath();
  if (existsSync(path)) return { keypair: Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")))), created: false };
  const keypair = Keypair.generate();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
  return { keypair, created: true };
}

export function localWallet(api: AfterbellClient): AgentWalletTools {
  const cap = maxSpend();
  const { keypair } = load();
  const connection = new Connection(SOLANA_RPC, "confirmed");
  const me = keypair.publicKey;

  const solanaMarket = async (symbol?: string) => {
    const m = await api.market(symbol);
    if (!m.solana) throw new Error("The Solana vault v2 isn't deployed yet.");
    return { ...m, solana: m.solana };
  };

  const balances = async (symbol?: string) => {
    const m = await solanaMarket(symbol);
    const ata = getAssociatedTokenAddressSync(new PublicKey(m.solana.collateralMint), me);
    const [testUsd, lamports] = await Promise.all([connection.getTokenAccountBalance(ata).then((b) => b.value.uiAmount ?? 0, () => 0), connection.getBalance(me)]);
    return { testUsd, sol: lamports / LAMPORTS_PER_SOL, market: m };
  };

  return {
    address: () => me.toBase58(),

    async wallet() {
      const b = await balances();
      return `Agent wallet ${me.toBase58()} (devnet, key at ${keypairPath()}): ${b.testUsd} TestUSD, ${b.sol.toFixed(3)} SOL. Spending cap: ${cap} TestUSD per purchase.`;
    },

    async getTestFunds() {
      const r = await api.faucet(me.toBase58());
      if (r.alreadyFunded) return "The agent's wallet already has enough test money.";
      return `Sent ${r.testUsd} TestUSD and ${r.sol} SOL: ${explorer(r.signature!)}`;
    },

    async buy(symbol, shares, startsBelow, stopsBelow, maxCost) {
      const b = await balances(symbol);
      const r = await api.quote({ chain: "solana", symbol: b.market.symbol, buyer: me.toBase58(), ...protectionFor(b.market, shares, startsBelow, stopsBelow) });
      const limit = Math.min(cap, maxCost ?? cap);
      if (r.priced.premium > limit) throw new Error(`Not bought: it costs ${r.priced.premium.toFixed(2)} TestUSD, above the ${maxCost !== undefined && maxCost < cap ? "max_cost" : "spending cap"} of ${limit}.\n${describe(r.priced)}`);
      if (r.priced.premium > b.testUsd) throw new Error(`Not bought: it costs ${r.priced.premium.toFixed(2)} TestUSD and the wallet has ${b.testUsd}. Use get_test_funds.`);
      const { transaction: tx } = await solanaPurchase(connection, me, r.solana);
      const sig = await sendAndConfirmTransaction(connection, tx, [keypair], { commitment: "confirmed" });
      return `Bought.\n${describe(r.priced)}\n${explorer(sig)}`;
    },

    // Pays out each finished position whose NFT the agent holds, with the agent as keeper, so it takes the tips too.
    async claim() {
      const ps = (await api.positions(me.toBase58())).filter((p) => p.state !== "open" && p.nftAccount);
      if (ps.length === 0) return "Nothing to claim yet: protection settles after the open.";
      const m = await solanaMarket();
      const mint = new PublicKey(m.solana.collateralMint);
      const token = getAssociatedTokenAddressSync(mint, me);
      const program = getProgram(connection, { publicKey: me, signTransaction: async (t) => t, signAllTransactions: async (t) => t });
      const lines: string[] = [];
      // One `process` pays positions of one series.
      for (const series of new Set(ps.map((p) => p.series))) {
        const mine = ps.filter((p) => p.series === series);
        for (let i = 0; i < mine.length; i += CLAIMS_PER_TX) {
          const batch = mine.slice(i, i + CLAIMS_PER_TX);
          const pay = await processInstruction(program, {
            keeper: me,
            vault: new PublicKey(m.solana.vault),
            series: new PublicKey(series),
            collateralMint: mint,
            keeperToken: token,
            payees: batch.map((p) => ({ position: new PublicKey(p.address), nftAccount: new PublicKey(p.nftAccount!), payeeToken: token })),
          });
          const tx = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(me, token, me, mint), pay);
          const sig = await sendAndConfirmTransaction(connection, tx, [keypair], { commitment: "confirmed" });
          for (const p of batch) lines.push(`${p.shares} ${p.symbol}: ${p.state === "voided" ? "refunded" : "paid"} ${(p.claimable ?? 0).toFixed(2)} TestUSD`);
          lines.push(explorer(sig));
        }
      }
      return lines.join("\n");
    },
  };
}
