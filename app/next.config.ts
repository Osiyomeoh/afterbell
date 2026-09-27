import { join } from "node:path";

import type { NextConfig } from "next";

// The app imports the quoter, pricing and Solana client from the repo root.
const root = join(import.meta.dirname, "..");

const nextConfig: NextConfig = {
  turbopack: { root },
  outputFileTracingRoot: root,
  // The Pyth receiver (used by the keeper) only loads through its CommonJS build.
  serverExternalPackages: ["@pythnetwork/pyth-solana-receiver"],
  // The Robinhood Chain deployment is read from disk at request time (it may not exist yet), and so is Solana vault v1's
  // record once v2 replaces it (solana/deployments/devnet-v1.json), which the record and hedge routes read.
  outputFileTracingIncludes: {
    ...Object.fromEntries(["/api/quote", "/api/market", "/api/positions", "/api/vault"].map((r) => [r, ["../evm/deployments/*.json"]])),
    "/api/record": ["../evm/deployments/*.json", "../solana/deployments/*.json"],
    "/api/hedge": ["../evm/deployments/*.json", "../solana/deployments/*.json"],
  },
};

export default nextConfig;
