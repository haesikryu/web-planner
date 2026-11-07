import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("foundation page is accessible and does not pretend authentication is ready", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Web Planner/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("중요한 일부터");
  await expect(page.getByRole("button", { name: "Google로 시작하기" })).toBeDisabled();
  await expect(page.getByRole("status")).toHaveText("로그인은 준비 중입니다.");
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(3);
  expect(await page.locator("html").getAttribute("lang")).toBe("ko");
  const noHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(noHorizontalOverflow).toBe(true);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "본문으로 건너뛰기" })).toBeFocused();
});

test("health response exposes liveness without secrets or database readiness claims", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(await response.json()).toEqual({ status: "ok", service: "web-planner" });
});

test("anonymous product session returns a private contract error", async ({ request }) => {
  const response = await request.get("/api/session");
  expect(response.status()).toBe(401);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(await response.json()).toMatchObject({ code: "UNAUTHENTICATED", requestId: expect.any(String) });
});

test("library bypass routes are unavailable and missing OAuth setup fails safely", async ({ request }) => {
  expect((await request.get("/api/auth/get-session")).status()).toBe(404);
  const response = await request.post("/api/auth/sign-in/social", {
    headers: { Origin: "http://127.0.0.1:3100" }, data: { provider: "google" }
  });
  expect(response.status()).toBe(503);
  const body = await response.json();
  expect(body.code).toBe("AUTH_UNAVAILABLE");
  expect(JSON.stringify(body)).not.toMatch(/DATABASE_URL|GOOGLE_CLIENT_SECRET|BETTER_AUTH_SECRET|postgresql:/);
});

test("public landing page meets automated WCAG A/AA checks", async ({ page }) => {
  await page.goto("/");
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(result.violations).toEqual([]);
});
