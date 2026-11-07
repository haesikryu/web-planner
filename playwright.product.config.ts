import { defineConfig, devices } from "@playwright/test";

const databaseUrl = process.env.PLANNER_E2E_DATABASE_URL;
if (!databaseUrl) throw new Error("PLANNER_E2E_DATABASE_URL is required for product browser tests");
export default defineConfig({
  outputDir: "./test-results/product",
  testDir: "./tests/e2e", testMatch: "planner.spec.ts", fullyParallel: true, forbidOnly: Boolean(process.env.CI), retries: 0,
  reporter: "list", use: { baseURL: "http://127.0.0.1:3101", trace: "retain-on-failure" },
  projects: [ { name: "product-desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "product-mobile", use: { ...devices["Pixel 7"], viewport: { width: 360, height: 800 } } } ],
  webServer: { command: "npm run dev -- --port 3101", url: "http://127.0.0.1:3101/api/health", reuseExistingServer: false, timeout: 60000,
    env: { PLANNER_TEST_BUILD: "product", LOCAL_DEMO_ENABLED: "false", DATABASE_URL: databaseUrl, BETTER_AUTH_URL: "http://127.0.0.1:3101", BETTER_AUTH_SECRET: "synthetic-browser-test-secret-32-characters", GOOGLE_CLIENT_ID: "synthetic-browser-client", GOOGLE_CLIENT_SECRET: "synthetic-browser-provider-secret", AUTH_ALLOW_SIGN_UP: "false", AUTH_ALLOWED_EMAILS: Array.from({ length: 256 }, (_, index) => `browser-${index}@example.test`).join(",") } }
});
