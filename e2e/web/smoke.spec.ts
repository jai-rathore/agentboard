import { test, expect, type Page } from "@playwright/test";

const API = `http://127.0.0.1:${process.env.E2E_API_PORT ?? 18787}`;

/** Collects console errors and uncaught page errors; answers any request that leaves 127.0.0.1 locally. */
async function watch(page: Page) {
  const errors: string[] = [];
  const offsite: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.route(/^(?!https?:\/\/(127\.0\.0\.1|localhost)[:/]).*/i, (route) => {
    offsite.push(route.request().url());
    return route.fulfill({ status: 204, body: "" });
  });
  return { errors, offsite };
}

const PAGES: { path: string; heading: RegExp; text?: RegExp }[] = [
  { path: "/", heading: /Show it once/i },
  { path: "/board", heading: /The board/i, text: /Does the board render seeded posts/ },
  { path: "/skills", heading: /skill/i },
  { path: "/governance", heading: /governance/i },
  { path: "/docs", heading: /How Agentboard Skills works/i },
];

for (const p of PAGES) {
  test(`${p.path} renders without console errors`, async ({ page }) => {
    const w = await watch(page);
    const res = await page.goto(p.path);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 }).first()).toContainText(p.heading);
    if (p.text) await expect(page.getByText(p.text).first()).toBeVisible();
    await expect(page.getByText(/API unreachable/)).toHaveCount(0);
    await page.waitForLoadState("networkidle").catch(() => {}); // the firehose SSE keeps a connection open
    // nothing wider than the viewport (catches mobile layout breaks)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(1);
    expect(w.errors).toEqual([]);
  });
}

test("navigation links between pages work", async ({ page }) => {
  const w = await watch(page);
  await page.goto("/docs");
  await page.locator("a[href='/board']:visible").first().click(); // header nav on desktop, footer link on mobile
  await expect(page).toHaveURL(/\/board$/);
  await expect(page.getByRole("heading", { level: 1 }).first()).toContainText(/The board/i);
  expect(w.errors).toEqual([]);
});

test("the app reads the local API, not prod", async ({ page }) => {
  const seen: string[] = [];
  page.on("request", (r) => seen.push(r.url()));
  await watch(page);
  await page.goto("/board");
  await expect(page.getByText(/Does the board render seeded posts/).first()).toBeVisible();
  expect(seen.some((u) => u.startsWith(API))).toBe(true);
  expect(seen.filter((u) => u.includes("onrender.com") || u.includes("vercel.app"))).toEqual([]);
});
