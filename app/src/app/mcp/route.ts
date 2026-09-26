import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { AfterbellApi } from "@root/agent/api";
import { createServer } from "@root/agent/tools";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The hosted MCP endpoint: add <site>/mcp to any MCP client. Stateless, and
 * it holds no keys: buying returns an unsigned transaction for the caller's
 * own wallet. Its tools read this same app's public routes.
 */
async function handle(request: Request): Promise<Response> {
  const server = createServer("hosted", new AfterbellApi(new URL(request.url).origin));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  // Browser-based clients (the MCP Inspector) need CORS; server-side clients ignore it.
  response.headers.set("Access-Control-Allow-Origin", "*");
  return response;
}

export function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
    },
  });
}

const HELP = (origin: string) => `Afterbell MCP server (Streamable HTTP, stateless, no keys).
Add it to Claude Code:
  claude mcp add --transport http afterbell ${origin}/mcp
or add this URL as a custom connector in any MCP client.
Tools: market, quote_protection, protection_transaction, protect_portfolio, positions, vault.
`;

/** MCP clients ask for JSON or an event stream; a person opening the URL in a browser gets directions instead. */
export function GET(request: Request) {
  const accept = request.headers.get("accept") ?? "";
  if (!accept.includes("text/event-stream") && !accept.includes("application/json")) {
    return new Response(HELP(new URL(request.url).origin), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  return handle(request);
}

export { handle as DELETE, handle as POST };
