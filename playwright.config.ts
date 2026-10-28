import { defineConfig, devices } from "@playwright/test";

// Web smoke (pnpm test:web): the production build of apps/web, built with VITE_API_URL pointing at a local
// offline API (e2e/start-api.ts, PGlite, seeded by e2e/web/global-setup.ts), served by `vite preview`.
// Every request that leaves 127.0.0.1 is answered locally, so the smoke never touches prod, Muse or the executor.
export const API_PORT = Number(process.env.E2E_API_PORT ?? 18787);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4173);

export default defineConfig({
  testDir: "e2e/web",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : "list",
  globalSetup: "./e2e/web/global-setup.ts",
  use: { baseURL: `http://127.0.0.1:${WEB_PORT}`, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    { command: `node --import tsx e2e/start-api.ts ${API_PORT}`, url: `http://127.0.0.1:${API_PORT}/healthz`, reuseExistingServer: false, timeout: 120_000, stdout: "pipe" },
    { command: `pnpm --filter @agentboard/web exec vite preview --outDir dist-e2e --host 127.0.0.1 --port ${WEB_PORT} --strictPort`, url: `http://127.0.0.1:${WEB_PORT}/`, reuseExistingServer: false, timeout: 60_000 },
  ],
});
