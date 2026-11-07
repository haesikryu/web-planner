import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("paused login offers a working demo with tab persistence and no product API traffic", async ({ page, context, request }) => {
  const apiRequests: string[] = [];
  page.on("request", req => { if (new URL(req.url()).pathname.startsWith("/api/")) apiRequests.push(req.url()); });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Google로 시작하기" })).toBeDisabled();
  await page.getByRole("link", { name: "로그인 없이 테스트하기" }).click();
  await expect(page.getByRole("status")).toHaveText("이 탭에 저장된 테스트 목록입니다.");
  await page.getByLabel("지금 떠오른 일").fill("테스트 할 일");
  await page.getByRole("button", { name: "입력함에 저장", exact: true }).click();
  const inbox = page.getByRole("region", { name: "입력함", exact: true });
  const scheduled = page.getByRole("region", { name: "오늘의 할 일", exact: true });
  const completed = page.getByRole("region", { name: "오늘 완료", exact: true });
  await expect(inbox.getByText("테스트 할 일", { exact: true })).toBeVisible();
  await inbox.getByRole("button", { name: "오늘로", exact: true }).click();
  await scheduled.getByRole("button", { name: "수정", exact: true }).click();
  await page.getByLabel("제목", { exact: true }).fill("수정한 테스트 할 일");
  await page.getByRole("button", { name: "변경 저장", exact: true }).click();
  await expect(scheduled.getByText("수정한 테스트 할 일", { exact: true })).toBeVisible();
  await scheduled.getByRole("button", { name: "완료", exact: true }).click();
  await expect(completed.getByText("수정한 테스트 할 일", { exact: true })).toBeVisible();
  await completed.getByRole("button", { name: "완료 취소", exact: true }).click();
  await expect(scheduled.getByText("수정한 테스트 할 일", { exact: true })).toBeVisible();
  await page.reload();
  await expect(scheduled.getByText("수정한 테스트 할 일", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.getByText(/기준 시간대 설정/).click();
  await page.getByLabel("IANA 시간대").fill("America/New_York");
  await page.getByRole("button", { name: "시간대 적용" }).click();
  await expect(page.locator(".date-line")).toContainText("America/New_York");
  await page.getByRole("button", { name: "테스트 나가기" }).click();
  await expect(page.getByRole("link", { name: "로그인 없이 테스트하기" })).toBeVisible();
  await page.getByRole("link", { name: "로그인 없이 테스트하기" }).click();
  await expect(page.locator(".date-line")).toContainText("America/New_York");
  expect(apiRequests).toEqual([]);
  expect(await context.cookies()).toEqual([]);
  expect((await request.get("/api/tasks?view=inbox")).status()).toBe(401);
  expect((await request.post("/api/auth/sign-in/social", { data: { provider: "google" } })).status()).toBe(503);
});

test("unavailable browser storage shows an actionable error instead of a broken planner", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "sessionStorage", { get() { throw new Error("Storage blocked for test"); } });
  });
  await page.goto("/demo");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("테스트 저장소를 열 수 없습니다");
  await expect(page.getByLabel("지금 떠오른 일")).toHaveCount(0);
  await page.getByRole("link", { name: "홈으로 돌아가기" }).click();
  await expect(page.getByRole("link", { name: "로그인 없이 테스트하기" })).toBeVisible();
});
