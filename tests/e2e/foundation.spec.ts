import { expect, test } from "@playwright/test";

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
