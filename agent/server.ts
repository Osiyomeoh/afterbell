/**
 * Afterbell as a local MCP server: the hosted tools plus the agent's own
 * devnet wallet, so it can buy protection and claim by itself under a
 * spending cap.
 *
 *   npx tsx agent/server.ts
 *
 * Claude Code:
 *   claude mcp add afterbell -e AFTERBELL_URL=http://localhost:3000 -e AGENT_MAX_SPEND=25 -- npx tsx <repo>/agent/server.ts
 *
 * AFTERBELL_URL    the app whose routes price, sign and fund (default http://localhost:3000)
 * AGENT_KEYPAIR    the agent's devnet wallet, created on first use (default ~/.config/afterbell/agent-devnet.json)
 * AGENT_MAX_SPEND  most one purchase may cost, in TestUSD (default 25)
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { AfterbellClient } from "../sdk/index";
import { createServer } from "./tools";
import { localWallet } from "./wallet";

const api = new AfterbellClient(process.env.AFTERBELL_URL || "http://localhost:3000");
const server = createServer("local", api, localWallet(api));
await server.connect(new StdioServerTransport());
