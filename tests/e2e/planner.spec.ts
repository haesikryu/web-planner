import { createHash, randomBytes, randomUUID } from "node:crypto";
import { makeSignature } from "better-auth/crypto";
import { Pool } from "pg";
import { type BrowserContext, expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { join } from "node:path";

const secret = "synthetic-browser-test-secret-32-characters";
async function seedSession(context: BrowserContext) {
  const pool = new Pool({ connectionString: process.env.PLANNER_E2E_DATABASE_URL, max: 1 });
  try {
  const id = randomUUID(), token = randomBytes(32).toString("hex"), now = new Date();
  let inserted = false;
  for (let index = 0; index < 256; index++) {
    const result = await pool.query("INSERT INTO users (id,name,email,timezone) VALUES ($1,'',$2,'Asia/Seoul') ON CONFLICT (email) DO NOTHING RETURNING id", [id, `browser-${index}@example.test`]);
    if (result.rowCount) { inserted = true; break; }
  }
  if (!inserted) throw new Error("Disposable browser fixture email pool exhausted; recreate the test database");
  await pool.query("INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$5)", [randomUUID(), id, createHash("sha256").update(token).digest("hex"), new Date(now.getTime() + 604800000), now]);
  await context.addCookies([{ name: "planner-session", value: encodeURIComponent(`${token}.${await makeSignature(token, secret)}`), url: "http://127.0.0.1:3101", httpOnly: true, sameSite: "Lax" }]);
  } finally { await pool.end(); }
}
test.beforeEach(async ({ context }) => seedSession(context));

test("capture -> today -> complete -> undo keeps the same original task", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "오늘을 가볍게." })).toBeVisible();
  await page.getByLabel("지금 떠오른 일").fill("  ");
  await expect(page.getByText("제목은 공백만 사용할 수 없으며", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "입력함에 저장" })).toBeDisabled();
  await page.getByLabel("지금 떠오른 일").fill("오늘의 제안서");
  await page.getByRole("button", { name: "입력함에 저장" }).click();
  const inbox = page.getByRole("region", { name: "입력함", exact: true });
  await expect(inbox.getByText("오늘의 제안서", { exact: true })).toBeVisible();
  const id = await inbox.locator("[data-task-id]").getAttribute("data-task-id");
  await inbox.getByRole("button", { name: "오늘로", exact: true }).click();
  const today = page.getByRole("region", { name: "오늘의 할 일", exact: true });
  await expect(today.getByText("오늘의 제안서", { exact: true })).toBeVisible();
  expect(await today.locator("[data-task-id]").getAttribute("data-task-id")).toBe(id);
  await today.getByRole("button", { name: "완료", exact: true }).click();
  const done = page.getByRole("region", { name: "오늘 완료", exact: true });
  await expect(done.getByText("오늘의 제안서", { exact: true })).toBeVisible();
  await done.getByRole("button", { name: "완료 취소", exact: true }).click();
  await expect(today.getByText("오늘의 제안서", { exact: true })).toBeVisible();
  expect(await today.locator("[data-task-id]").getAttribute("data-task-id")).toBe(id);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (process.env.PLANNER_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.PLANNER_SCREENSHOT_DIR, `planner-${testInfo.project.name}.png`), fullPage: true });
});

test("an account change clears the prior account's draft and visible tasks", async ({ page, context }) => {
  await page.goto("/"); await page.getByLabel("지금 떠오른 일").fill("첫 계정의 비공개 과제");
  await page.getByRole("button", { name: "입력함에 저장" }).click();
  await expect(page.getByText("첫 계정의 비공개 과제", { exact: true })).toBeVisible();
  await page.getByLabel("지금 떠오른 일").fill("첫 계정의 미저장 입력");
  await seedSession(context);
  page.on("dialog", dialog => dialog.accept());
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByLabel("지금 떠오른 일")).toHaveValue("");
  await expect(page.getByText("첫 계정의 비공개 과제", { exact: true })).toHaveCount(0);
});

test("an uncertain creation older than 24 hours is not sent again", async ({ page }) => {
  await page.clock.install(); let attempts = 0;
  await page.route("**/api/tasks", async route => {
    if (route.request().method() === "POST") { attempts++; await route.fetch(); await route.abort("failed"); } else await route.continue();
  });
  await page.goto("/"); await page.getByLabel("지금 떠오른 일").fill("오래된 불확실 요청");
  await page.getByRole("button", { name: "입력함에 저장" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("확인");
  await expect(page.getByRole("status")).toHaveText("저장 확인 필요");
  await page.clock.setFixedTime(new Date(Date.now() + 86401000));
  await page.getByRole("button", { name: "같은 요청 재시도" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("24시간");
  expect(attempts).toBe(1);
});

test("planner form and lists meet automated WCAG A/AA checks", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "오늘을 가볍게." })).toBeVisible();
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(result.violations).toEqual([]);
});

test("a timezone change during loading does not label old-calendar results as current", async ({ page }) => {
  await page.goto("/"); await page.getByLabel("지금 떠오른 일").fill("날짜 기준 경합");
  await page.getByRole("button", { name: "입력함에 저장" }).click();
  await expect(page.getByText("날짜 기준 경합", { exact: true })).toBeVisible();
  const session = await (await page.request.get("/api/session")).json();
  let changeOnce = true;
  await page.route("**/api/tasks?view=scheduled&**", async route => {
    if (!changeOnce) { await route.continue(); return; }
    changeOnce = false;
    const oldCalendarResponse = await route.fetch();
    const changed = await page.request.patch("/api/settings", { headers: { Origin: "http://127.0.0.1:3101", "X-CSRF-Token": session.csrfToken, "Idempotency-Key": randomUUID(), "If-Match": '"v1"' }, data: { timezone: "America/New_York" } });
    expect(changed.status()).toBe(200);
    await route.fulfill({ response: oldCalendarResponse });
  });
  await page.getByRole("button", { name: "목록 새로고침" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("날짜 기준");
  await expect(page.getByText("날짜 기준 경합", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "목록 새로고침" }).click();
  await expect(page.getByText("날짜 기준 경합", { exact: true })).toBeVisible();
  await expect(page.locator(".date-line")).toContainText("America/New_York");
});

test("lost success response preserves input and reuses the same request key", async ({ page }) => {
  const keys: string[] = []; let loseOnce = true;
  await page.route("**/api/tasks", async route => {
    if (route.request().method() === "POST") {
      keys.push(route.request().headers()["idempotency-key"]);
      if (loseOnce) { loseOnce = false; await route.fetch(); await route.abort("failed"); return; }
    }
    await route.continue();
  });
  await page.goto("/"); await page.getByLabel("지금 떠오른 일").fill("응답 유실 복구");
  await page.getByRole("button", { name: "입력함에 저장" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("확인");
  await expect(page.getByLabel("지금 떠오른 일")).toHaveValue("응답 유실 복구");
  await page.getByRole("button", { name: "같은 요청 재시도" }).click();
  await expect(page.getByRole("region", { name: "입력함", exact: true }).getByText("응답 유실 복구", { exact: true })).toHaveCount(1);
  await expect(page.getByLabel("지금 떠오른 일")).toHaveValue("");
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
});

test("stale edit shows current task and requires an explicit conflict choice", async ({ page }) => {
  await page.goto("/"); await page.getByLabel("지금 떠오른 일").fill("충돌 전 제목");
  await page.getByRole("button", { name: "입력함에 저장" }).click();
  const inbox = page.getByRole("region", { name: "입력함", exact: true });
  await expect(inbox.getByText("충돌 전 제목", { exact: true })).toBeVisible();
  const id = await inbox.locator("[data-task-id]").getAttribute("data-task-id");
  await inbox.getByRole("button", { name: "수정", exact: true }).click();
  const edit = page.locator(".edit-panel"); await edit.getByLabel("제목", { exact: true }).fill("내 변경");
  // A genuine second HTTP writer shares the test session; no application auth bypass is added.
  const session = await (await page.request.get("/api/session")).json();
  const remote = await page.request.patch(`/api/tasks/${id}`, { headers: { Origin: "http://127.0.0.1:3101", "X-CSRF-Token": session.csrfToken, "Idempotency-Key": randomUUID(), "If-Match": '"v1"' }, data: { title: "다른 탭의 최신 제목" } });
  expect(remote.status()).toBe(200);
  await edit.getByRole("button", { name: "변경 저장" }).click();
  const conflict = page.getByRole("region", { name: "수정 충돌 확인" });
  await expect(conflict).toContainText("다른 탭의 최신 제목"); await expect(conflict).toContainText("내 변경");
  await conflict.getByRole("button", { name: "내 변경 다시 적용" }).click();
  await expect(inbox.getByText("내 변경", { exact: true })).toBeVisible();
});

test("timezone change persists and logout warns before discarding unsaved input", async ({ page }) => {
  await page.goto("/"); await page.getByText("기준 시간대 설정", { exact: false }).click();
  await page.getByLabel("IANA 시간대").fill("America/New_York");
  await page.getByRole("button", { name: "시간대 적용" }).click();
  await expect(page.locator(".date-line")).toContainText("America/New_York");
  await page.reload(); await expect(page.locator(".date-line")).toContainText("America/New_York");
  await page.getByLabel("지금 떠오른 일").fill("아직 저장하지 않은 입력");
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "로그아웃 / 계정 바꾸기" }).click();
  await expect(page.getByLabel("지금 떠오른 일")).toHaveValue("아직 저장하지 않은 입력");
  page.on("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "로그아웃 / 계정 바꾸기" }).click();
  await expect(page.getByRole("button", { name: "Google로 시작하기" })).toBeVisible();
  await expect(page.getByText("아직 저장하지 않은 입력", { exact: true })).toHaveCount(0);
});
