import { expect, test, type Page } from "@playwright/test";

/** Fails on any error the page logs, and on a page wider than the screen. */
async function visit(page: Page, path: string) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // A failed request is reported by its URL; the browser's console line for it says only "404".
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
  page.on("response", (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));
  await page.goto(path);
  await page.waitForLoadState("networkidle").catch(() => {});
  const width = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(width, "the page scrolls sideways").toBeLessThanOrEqual(1);
  return errors;
}

test("the home page prices protection and offers a test wallet", async ({ page }) => {
  const errors = await visit(page, "/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("opening bell");
  await expect(page.getByText("You pay").locator("visible=true").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /test wallet/i }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("verify links settlements on both chains to their transactions", async ({ page }) => {
  const errors = await visit(page, "/verify");
  await expect(page.getByRole("heading", { name: "Verify it yourself" })).toBeVisible();
  await expect(page.locator('a[href*="explorer.solana.com/tx/"]').first()).toBeVisible();
  await expect(page.locator('a[href*="robinhoodchain.blockscout.com/tx/"]').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("the Kamino page maps loans and checks one", async ({ page }) => {
  const errors = await visit(page, "/kamino");
  await expect(page.getByRole("heading", { name: "If they all opened down together" })).toBeVisible();
  await expect(page.getByText(/loans borrow/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Check the loan" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the private page links its transactions", async ({ page }) => {
  const errors = await visit(page, "/private");
  await expect(page.locator('a[href*="explorer.solana.com/tx/"]')).toHaveCount(3);
  expect(errors).toEqual([]);
});

test("every page renders", async ({ page }) => {
  for (const path of ["/positions", "/vault", "/record", "/gap", "/status", "/event"]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBeLessThan(500);
    await expect(page.locator("main")).not.toBeEmpty();
  }
});

test("the API and the MCP server answer", async ({ request }) => {
  const spec = await request.get("/api/openapi.json");
  expect(spec.ok()).toBe(true);
  expect(Object.keys((await spec.json()).paths)).toContain("/api/kamino/loans");
  expect((await request.get("/api/kamino/loans?wallet=nope")).status()).toBe(400);
  const mcp = await request.get("/mcp");
  expect(await mcp.text()).toContain("kamino_loan");
});
