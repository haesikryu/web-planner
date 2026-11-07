import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  outputDir: "./test-results/foundation",
  testDir: "./tests/e2e",
  testMatch: "foundation.spec.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"], viewport: { width: 360, height: 800 } } }
  ],
  webServer: {
    command: "npm run start -- --port 3100",
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false,
    env: { AUTH_LOGIN_ENABLED: "true" },
    timeout: 60_000
  }
});
