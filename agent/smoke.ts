/**
 * Exercises both MCP servers through a real MCP client against a running app:
 * the local one over stdio (a throwaway agent wallet buys protection on
 * devnet under its cap) and the hosted /mcp over HTTP (a fresh wallet signs
 * the transaction it returns).
 *
 *   AFTERBELL_URL=http://localhost:3000 npx tsx agent/smoke.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Connection, Keypair, Transaction } from "@solana/web3.js";

const URL_ = process.env.AFTERBELL_URL || "http://localhost:3000";
const text = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  const out = text(r);
  console.log(`\n> ${name} ${JSON.stringify(args)}${r.isError ? " (error)" : ""}\n${out}`);
  if (r.isError) throw new Error(`${name} failed`);
  return out;
}

async function main() {
  // Local: the agent's own wallet, created fresh for this run.
  const local = new Client({ name: "afterbell-smoke", version: "0" });
  await local.connect(
    new StdioClientTransport({
      command: "npx",
      args: ["tsx", join(import.meta.dirname, "server.ts")],
      env: { ...process.env, AFTERBELL_URL: URL_, AGENT_KEYPAIR: join(mkdtempSync(join(tmpdir(), "afterbell-agent-")), "agent.json"), AGENT_MAX_SPEND: "5" } as Record<string, string>,
    }),
  );
  console.log("local tools:", (await local.listTools()).tools.map((t) => t.name).join(", "));
  await call(local, "market");
  await call(local, "quote_protection", { shares: 2 });
  await call(local, "wallet");
  await call(local, "get_test_funds");
  const refused = await local.callTool({ name: "buy_protection", arguments: { shares: 50 } });
  console.log(`\n> buy_protection {"shares":50} (over the cap)\n${text(refused)}`);
  if (!refused.isError || !text(refused).includes("spending cap")) throw new Error("the spending cap didn't hold");
  await call(local, "buy_protection", { shares: 2 });
  await call(local, "positions");
  await local.close();

  // Hosted: no keys; the caller's own wallet signs what it returns.
  const hosted = new Client({ name: "afterbell-smoke", version: "0" });
  await hosted.connect(new StreamableHTTPClientTransport(new URL("/mcp", URL_)));
  console.log("\nhosted tools:", (await hosted.listTools()).tools.map((t) => t.name).join(", "));
  const buyer = Keypair.generate();
  const out = await call(hosted, "protection_transaction", { buyer: buyer.publicKey.toBase58(), shares: 1 });
  const b64 = out.trim().split("\n").pop()!;
  const tx = Transaction.from(Buffer.from(b64, "base64"));
  tx.partialSign(buyer);
  const connection = new Connection(process.env.SOLANA_RPC || "https://api.devnet.solana.com", "confirmed");
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  console.log(`\nthe fresh wallet signed and sent it: https://explorer.solana.com/tx/${sig}?cluster=devnet err=${JSON.stringify((await connection.getSignatureStatus(sig)).value?.err)}`);
  await hosted.close();
  console.log("PASS");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
