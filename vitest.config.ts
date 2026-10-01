import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // The app's alias for the repo root, so its lib modules test as they build.
  resolve: { alias: { "@root": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text-summary"],
      include: ["{pricing,quoter,sdk,hedger,agent,evm/keeper,evm/client,solana/client,solana/keeper,app/src/lib,privacy}/**/*.ts"],
      exclude: ["**/*.test.ts"],
    },
    // Our TypeScript tests only; evm/lib holds OpenZeppelin's own JavaScript tests.
    include: ["research/**/*.test.ts", "pricing/**/*.test.ts", "solana/client/**/*.test.ts", "solana/keeper/**/*.test.ts", "quoter/**/*.test.ts", "evm/keeper/**/*.test.ts", "agent/**/*.test.ts", "hedger/**/*.test.ts", "sdk/**/*.test.ts", "app/src/lib/**/*.test.ts", "privacy/book.test.ts"],
  },
});
