import { join } from "node:path";

import type { NextConfig } from "next";

// The app imports the quoter, pricing and Solana client from the repo root.
const root = join(import.meta.dirname, "..");

const nextConfig: NextConfig = {
  turbopack: { root },
  outputFileTracingRoot: root,
  // The Pyth receiver (used by the keeper) only loads through its CommonJS build.
  serverExternalPackages: ["@pythnetwork/pyth-solana-receiver"],
};

export default nextConfig;
