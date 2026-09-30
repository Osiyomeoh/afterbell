import { defineConfig } from "tsup";

/**
 * The published package: the SDK and the repo code it shares with the app and the vaults (pricing,
 * quotes, the vault clients), bundled into one ES module with its types. npm dependencies stay
 * dependencies.
 */
export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  // Types come from tsc (tsconfig.build.json): the bundler's type plugin predates TypeScript 7.
  dts: false,
  clean: true,
  target: "es2022",
  external: ["@anchor-lang/core", "@noble/curves", "@solana/spl-token", "@solana/web3.js", "bs58", "viem"],
});
