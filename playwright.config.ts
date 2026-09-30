import { defineConfig } from "@playwright/test";

/**
 * End-to-end checks of the running app, in a real browser: the hosted one by default
 * (E2E_BASE_URL for another). They read live chains, so CI runs them on a schedule rather than on
 * every change. Uses the machine's Chrome, so there's no browser to download.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  retries: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "https://afterbell-nine.vercel.app",
    channel: "chrome",
    headless: true,
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "phone", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
