import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e", testMatch: "demo.spec.ts", fullyParallel: true, forbidOnly: Boolean(process.env.CI), retries: 0,
  reporter: "list", use: { baseURL: "http://127.0.0.1:3102", trace: "retain-on-failure" },
  projects: [ { name: "demo-desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "demo-mobile", use: { ...devices["Pixel 7"], viewport: { width: 360, height: 800 } } } ],
  webServer: { command: "npm run dev -- --port 3102", url: "http://127.0.0.1:3102/api/health", reuseExistingServer: false, timeout: 60000,
    env: { PLANNER_TEST_BUILD: "demo", AUTH_LOGIN_ENABLED: "false", LOCAL_DEMO_ENABLED: "true", DATABASE_URL: "", BETTER_AUTH_SECRET: "", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", AUTH_ALLOWED_EMAILS: "" } }
});
