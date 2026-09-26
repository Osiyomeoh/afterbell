import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Our TypeScript tests only; evm/lib holds OpenZeppelin's own JavaScript tests.
    include: ["research/**/*.test.ts", "pricing/**/*.test.ts", "solana/client/**/*.test.ts"],
  },
});
