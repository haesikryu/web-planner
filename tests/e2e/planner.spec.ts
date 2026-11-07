import { createHash, randomBytes, randomUUID } from "node:crypto";
import { makeSignature } from "better-auth/crypto";
import { Pool } from "pg";
import { type BrowserContext, expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { join } from "node:path";
import { Temporal } from "@js-temporal/polyfill";

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
  await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.", { timeout: 15000 });
  await expect(page.getByRole("heading", { name: "오늘을 가볍게." })).toBeVisible();
  await page.getByLabel("지금 떠오른 일").fill("  ");
  await expect(page.getByText("제목은 공백만 사용할 수 없으며", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "입력함에 저장" })).toBeDisabled();
  await page.getByLabel("지금 떠오른 일").fill("오늘의 제안서");
  await page.getByRole("button", { name: "입력함에 저장" }).click();
  const inbox = page.getByRole("region", { name: "입력함", exact: true });
  await expect(inbox.getByText("오늘의 제안서", { exact: true })).toBeVisible();
  const id = await inbox.locator("[data-task-id]").getAttribute("data-task-id");
  // The first development PATCH can compile the route before the UI reload begins.
  const assigned = page.waitForResponse(response => new URL(response.url()).pathname === `/api/tasks/${id}` && response.request().method() === "PATCH", { timeout: 10000 });
  await inbox.getByRole("button", { name: "오늘로", exact: true }).click();
  expect((await assigned).status()).toBe(200);
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
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.", { timeout: 15000 });
  await page.getByLabel("지금 떠오른 일").fill("첫 계정의 비공개 과제");
  await page.getByRole("button", { name: "입력함에 저장" }).click();
  await expect(page.getByText("첫 계정의 비공개 과제", { exact: true })).toBeVisible();
  await page.getByLabel("지금 떠오른 일").fill("첫 계정의 미저장 입력");
  await page.getByRole("textbox", { name: "자유롭게 쓰는 글", exact: true }).fill("첫 계정의 미저장 자유 기록");
  await seedSession(context);
  page.on("dialog", dialog => dialog.accept());
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByLabel("지금 떠오른 일")).toHaveValue("");
  await expect(page.getByText("첫 계정의 비공개 과제", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "자유롭게 쓰는 글", exact: true })).toHaveValue("");
});

test("an uncertain creation older than 24 hours is not sent again", async ({ page }) => {
  await page.clock.install(); let attempts = 0;
  await page.route("**/api/tasks", async route => {
    if (route.request().method() === "POST") {
      attempts++;
      const committed = await route.fetch();
      expect(committed.status()).toBe(201);
      await route.abort("failed");
    } else await route.continue();
  });
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.", { timeout: 15000 });
  await page.getByLabel("지금 떠오른 일").fill("오래된 불확실 요청");
  const responseLost = page.waitForEvent("requestfailed", {
    predicate: request => new URL(request.url()).pathname === "/api/tasks" && request.method() === "POST",
    timeout: 15000,
  });
  await page.getByRole("button", { name: "입력함에 저장" }).click();
  await responseLost;
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
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.", { timeout: 15000 });
  await page.getByLabel("지금 떠오른 일").fill("날짜 기준 경합");
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
  await expect(page.getByRole("main").getByRole("alert")).toContainText("날짜 기준", { timeout: 10000 });
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

test("a delayed previous diary page cannot replace the current date's tasks or status", async ({ page }) => {
  await page.goto("/");
  const session = await (await page.request.get("/api/session")).json();
  const today = Temporal.PlainDate.from(session.serverDate);
  const tomorrow = today.add({ days: 1 }).toString(), followingDay = today.add({ days: 2 }).toString();
  await page.getByLabel("지금 떠오른 일").fill("이전 페이지의 과제");
  await page.getByRole("button", { name: "입력함에 저장", exact: true }).click();
  const inbox = page.getByRole("region", { name: "입력함", exact: true });
  await expect(inbox.getByText("이전 페이지의 과제", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await expect(page.locator(".date-line")).toContainText(tomorrow);
  await inbox.getByRole("button", { name: "이날로", exact: true }).click();
  await expect(page.getByRole("region", { name: "이날의 할 일", exact: true }).getByText("이전 페이지의 과제", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "이전 날", exact: true }).click();
  await expect(page.locator(".date-line")).toContainText(today.toString());
  await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.");

  let markHeld: () => void = () => {}, releaseResponse: () => void = () => {};
  const held = new Promise<void>(resolve => { markHeld = resolve; });
  const release = new Promise<void>(resolve => { releaseResponse = resolve; });
  let delayOnce = true;
  await page.route("**/api/tasks?view=scheduled&**", async route => {
    if (!delayOnce || new URL(route.request().url()).searchParams.get("date") !== tomorrow) { await route.continue(); return; }
    delayOnce = false;
    const previousPage = await route.fetch();
    markHeld();
    await release;
    await route.fulfill({ response: previousPage });
  });
  try {
    await page.getByRole("button", { name: "다음 날", exact: true }).click();
    await held;
    await page.getByRole("button", { name: "다음 날", exact: true }).click();
    await expect(page.locator(".date-line")).toContainText(followingDay);
    await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.");
    await page.getByRole("button", { name: "목록 새로고침", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("최신 목록을 확인했습니다.");
    const oldLoadConfirmed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/session" && response.request().method() === "GET");
    releaseResponse();
    await oldLoadConfirmed;
    // Let the released response's React updates commit before checking absence and unchanged status.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator(".date-line")).toContainText(followingDay);
    await expect(page.getByRole("region", { name: "이날의 할 일", exact: true }).getByText("이전 페이지의 과제", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText("최신 목록을 확인했습니다.");
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  } finally { releaseResponse(); }
});


test("title-only capture and daily-list priority persist through status changes and editing", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.", { timeout: 15000 });
  const capture = page.locator(".capture");
  await expect(capture.getByRole("textbox")).toHaveCount(1);
  await expect(capture.getByRole("combobox")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: /유형/ })).toHaveCount(0);
  await expect(page.locator(".symbol-legend").filter({ hasText: /약속|행사/ })).toHaveCount(0);
  await page.getByLabel("지금 떠오른 일").fill("상태 변경 확인");
  await page.getByRole("button", { name: "입력함에 저장", exact: true }).click();
  const inbox = page.getByRole("region", { name: "입력함", exact: true });
  const scheduled = page.getByRole("region", { name: "오늘의 할 일", exact: true });
  const completed = page.getByRole("region", { name: "오늘 완료", exact: true });
  const inboxCard = inbox.locator("[data-task-id]").filter({ hasText: "상태 변경 확인" });
  const activeCard = scheduled.locator("[data-task-id]").filter({ hasText: "상태 변경 확인" });
  await expect(inboxCard).toBeVisible();
  await expect(inboxCard.getByRole("combobox", { name: /우선순위/ })).toHaveCount(0);
  await expect(inboxCard.locator(".bullet-symbol")).toHaveText("□");
  await expect(inboxCard.locator(".bullet-symbol")).toHaveAttribute("aria-label", "진행 전");
  await inboxCard.getByRole("button", { name: "오늘로", exact: true }).click();
  await expect(activeCard.getByLabel("상태 변경 확인 우선순위", { exact: true })).toHaveValue("medium");
  await activeCard.getByLabel("상태 변경 확인 우선순위", { exact: true }).selectOption("high");
  await expect(activeCard.getByLabel("상태 변경 확인 우선순위", { exact: true })).toHaveValue("high");
  await page.reload();
  await expect(activeCard.getByLabel("상태 변경 확인 우선순위", { exact: true })).toHaveValue("high");
  await activeCard.getByLabel("상태 변경 확인 우선순위", { exact: true }).selectOption("low");
  await expect(activeCard.getByLabel("상태 변경 확인 우선순위", { exact: true })).toHaveValue("low");
  await activeCard.getByLabel("상태 변경 확인 상태", { exact: true }).selectOption("deferred");
  await expect(activeCard.locator(".bullet-symbol")).toHaveText("→");
  await expect(activeCard.locator(".bullet-symbol")).toHaveAttribute("aria-label", /미룸|연기/);
  const currentDay = (await page.locator(".date-line").textContent() ?? "").slice(0, 10);
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await expect(page.locator(".date-line")).toContainText(Temporal.PlainDate.from(currentDay).add({ days: 1 }).toString());
  const overdue = page.getByRole("region", { name: "이전 날짜의 미완료", exact: true });
  const overdueCard = overdue.locator("[data-task-id]").filter({ hasText: "상태 변경 확인" });
  await expect(overdueCard.locator(".bullet-symbol")).toHaveText("→");
  await expect(overdueCard.getByRole("combobox", { name: /우선순위/ })).toHaveCount(0);
  await page.getByRole("button", { name: "이전 날", exact: true }).click();
  await activeCard.getByLabel("상태 변경 확인 상태", { exact: true }).selectOption("canceled");
  await expect(activeCard.locator(".bullet-symbol")).toHaveText("×");
  await expect(activeCard.locator(".bullet-symbol")).toHaveAttribute("aria-label", /취소/);
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await expect(page.locator(".date-line")).toContainText(Temporal.PlainDate.from(currentDay).add({ days: 1 }).toString());
  await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.");
  await expect(overdueCard).toHaveCount(0);
  await page.getByRole("button", { name: "이전 날", exact: true }).click();
  await expect(activeCard.getByLabel("상태 변경 확인 상태", { exact: true })).toHaveValue("canceled");
  await activeCard.getByLabel("상태 변경 확인 상태", { exact: true }).selectOption("open");
  await expect(activeCard.locator(".bullet-symbol")).toHaveText("□");
  await activeCard.getByLabel("상태 변경 확인 상태", { exact: true }).selectOption("completed");
  const doneCard = completed.locator("[data-task-id]").filter({ hasText: "상태 변경 확인" });
  await expect(doneCard.locator(".bullet-symbol")).toHaveText("✓");
  await expect(doneCard.locator(".bullet-symbol")).toHaveAttribute("aria-label", /완료/);
  await expect(doneCard.getByRole("combobox", { name: /우선순위/ })).toHaveCount(0);
  await doneCard.getByRole("button", { name: "완료 취소", exact: true }).click();
  await expect(activeCard.locator(".bullet-symbol")).toHaveText("□");
  await page.getByLabel("지금 떠오른 일").fill("편집 중 보호할 다른 일");
  await page.getByRole("button", { name: "입력함에 저장", exact: true }).click();
  const otherInboxCard = inbox.locator("[data-task-id]").filter({ hasText: "편집 중 보호할 다른 일" });
  await otherInboxCard.getByRole("button", { name: "오늘로", exact: true }).click();
  const otherCard = scheduled.locator("[data-task-id]").filter({ hasText: "편집 중 보호할 다른 일" });
  await expect(otherCard).toBeVisible();
  await activeCard.getByRole("button", { name: "수정", exact: true }).click();
  const editor = page.locator(".edit-panel");
  await expect(editor.getByRole("combobox", { name: /유형|우선순위/ })).toHaveCount(0);
  await editor.getByLabel("제목", { exact: true }).fill("보존할 미저장 편집 제목");
  await expect(page.getByRole("button", { name: "＋ 빠른 입력", exact: true })).toBeDisabled();
  await expect(page.getByLabel("지금 떠오른 일")).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "자유롭게 쓰는 글", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "글 저장", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "입력함에 저장", exact: true })).toBeDisabled();
  await expect(otherCard.getByLabel("편집 중 보호할 다른 일 우선순위", { exact: true })).toBeDisabled();
  await expect(otherCard.getByLabel("편집 중 보호할 다른 일 상태", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "다음 날", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "이전 날", exact: true })).toBeDisabled();
  await page.getByText(/기준 시간대 설정/).click();
  await expect(page.getByLabel("IANA 시간대")).toBeDisabled();
  await expect(page.getByRole("button", { name: "시간대 적용", exact: true })).toBeDisabled();
  await expect(editor.getByLabel("제목", { exact: true })).toHaveValue("보존할 미저장 편집 제목");
  await editor.getByLabel("제목", { exact: true }).fill("상태 변경 확인");
  await editor.getByLabel("진행 상태", { exact: true }).selectOption("open");
  await editor.getByRole("button", { name: "변경 저장", exact: true }).click();
  await expect(activeCard.getByLabel("상태 변경 확인 우선순위", { exact: true })).toBeEnabled();
  await page.reload();
  await expect(activeCard.getByLabel("상태 변경 확인 우선순위", { exact: true })).toHaveValue("low");
  await expect(activeCard.getByLabel("상태 변경 확인 상태", { exact: true })).toHaveValue("open");
  await expect(activeCard.locator(".bullet-symbol")).toHaveText("□");
  await expect(activeCard.locator(".bullet-symbol")).toHaveAttribute("aria-label", "진행 전");
  await expect(page.locator(".task-meta").filter({ hasText: /약속|행사|할 일/ })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: /유형/ })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});


test("an unscheduled organized completion returns to inbox after cancellation or completion undo", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("지금 떠오른 일").fill("날짜 없는 기록");
  await page.getByRole("button", { name: "입력함에 저장", exact: true }).click();
  const inbox = page.getByRole("region", { name: "입력함", exact: true });
  const completed = page.getByRole("region", { name: "오늘 완료", exact: true });
  const inboxCard = inbox.locator("[data-task-id]").filter({ hasText: "날짜 없는 기록" });
  const doneCard = completed.locator("[data-task-id]").filter({ hasText: "날짜 없는 기록" });
  await expect(inboxCard).toBeVisible();
  const id = await inboxCard.getAttribute("data-task-id");
  await inboxCard.getByRole("button", { name: "완료", exact: true }).click();
  await expect(doneCard.locator(".bullet-symbol")).toHaveText("✓");
  await doneCard.getByRole("button", { name: "정리 완료", exact: true }).click();
  await expect(inboxCard).toHaveCount(0);
  await doneCard.getByLabel("날짜 없는 기록 상태", { exact: true }).selectOption("canceled");
  await expect(inboxCard.locator(".bullet-symbol")).toHaveText("×");
  await expect(inboxCard).toHaveAttribute("data-task-id", id ?? "");
  await expect(inboxCard).toContainText("날짜 미정");
  await expect(doneCard).toHaveCount(0);
  await page.reload();
  await expect(inboxCard.getByLabel("날짜 없는 기록 상태", { exact: true })).toHaveValue("canceled");
  await inboxCard.getByRole("button", { name: "취소 되돌리기", exact: true }).click();
  await expect(inboxCard.locator(".bullet-symbol")).toHaveText("□");
  await inboxCard.getByRole("button", { name: "완료", exact: true }).click();
  await doneCard.getByRole("button", { name: "정리 완료", exact: true }).click();
  await expect(inboxCard).toHaveCount(0);
  await doneCard.getByRole("button", { name: "완료 취소", exact: true }).click();
  await expect(inboxCard).toHaveAttribute("data-task-id", id ?? "");
  await expect(inboxCard.locator(".bullet-symbol")).toHaveText("□");
  await page.reload();
  await expect(inboxCard.getByLabel("날짜 없는 기록 상태", { exact: true })).toHaveValue("open");
  await expect(inboxCard).toContainText("날짜 미정");
});


test("legacy appointment data uses the common status symbol and survives title editing", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.", { timeout: 15000 });
  const session = await (await page.request.get("/api/session")).json();
  // The compatibility API seeds a record saved by the earlier UI.
  const created = await page.request.post("/api/tasks", {
    headers: { Origin: "http://127.0.0.1:3101", "X-CSRF-Token": session.csrfToken, "Idempotency-Key": randomUUID() },
    data: { title: "이전에 저장한 기록", kind: "appointment", priority: "high", scheduledDate: session.serverDate },
  });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  await page.reload();
  const scheduled = page.getByRole("region", { name: "오늘의 할 일", exact: true });
  const oldCard = scheduled.locator("[data-task-id]").filter({ hasText: "이전에 저장한 기록" });
  await expect(oldCard.locator(".bullet-symbol")).toHaveText("□");
  await expect(oldCard.locator(".bullet-symbol")).toHaveAttribute("aria-label", "진행 전");
  await expect(oldCard.locator(".task-meta")).not.toContainText(/약속|행사/);
  await expect(oldCard.getByLabel("이전에 저장한 기록 우선순위", { exact: true })).toHaveValue("high");
  await expect(page.locator(".symbol-legend").filter({ hasText: /약속|행사/ })).toHaveCount(0);
  await oldCard.getByRole("button", { name: "수정", exact: true }).click();
  const editor = page.locator(".edit-panel");
  await expect(editor.getByRole("combobox", { name: /유형|우선순위/ })).toHaveCount(0);
  await editor.getByLabel("제목", { exact: true }).fill("제목을 고친 이전 기록");
  await editor.getByRole("button", { name: "변경 저장", exact: true }).click();
  const editedCard = scheduled.locator("[data-task-id]").filter({ hasText: "제목을 고친 이전 기록" });
  await expect(editedCard).toBeVisible();
  await page.reload();
  await expect(editedCard.locator(".bullet-symbol")).toHaveText("□");
  await expect(editedCard.getByLabel("제목을 고친 이전 기록 우선순위", { exact: true })).toHaveValue("high");
  const stored = await page.request.get(`/api/tasks/${id}`);
  expect(stored.status()).toBe(200);
  expect(await stored.json()).toMatchObject({ kind: "appointment", priority: "high", title: "제목을 고친 이전 기록" });
});


test("left-page tasks and right-page journal preserve separate dated entries and unsaved drafts", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.", { timeout: 15000 });
  const left = page.locator(".diary-page-left"), right = page.locator(".diary-page-right");
  await expect(left.getByLabel("지금 떠오른 일")).toBeVisible();
  for (const name of ["오늘의 할 일", "오늘 완료", "입력함", "이전 날짜의 미완료"]) {
    await expect(left.getByRole("region", { name, exact: true })).toBeVisible();
    await expect(right.getByRole("region", { name, exact: true })).toHaveCount(0);
  }
  const journal = right.getByRole("region", { name: "자유 기록", exact: true });
  const writing = journal.getByRole("textbox", { name: "자유롭게 쓰는 글", exact: true });
  const save = journal.getByRole("button", { name: "글 저장", exact: true });
  await expect(writing).toBeEnabled();
  await expect(writing).toHaveValue("");
  await expect(save).toBeDisabled();
  await expect(left.getByRole("region", { name: "자유 기록", exact: true })).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveCount(1);
  const today = (await page.locator(".date-line").textContent() ?? "").slice(0, 10);
  const tomorrow = Temporal.PlainDate.from(today).add({ days: 1 }).toString();
  const firstEntry = "  오늘의 생각  \n\n두 번째 문단에는  여백을 남깁니다.\n";
  const secondEntry = "내일의 메모\n  다른 날짜의 글  ";
  await writing.fill(firstEntry);
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "로그아웃 / 계정 바꾸기", exact: true }).click();
  await expect(writing).toHaveValue(firstEntry);
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await expect(page.locator(".date-line")).toContainText(tomorrow);
  await expect(writing).toBeEnabled();
  await expect(writing).toHaveValue("");
  await writing.fill(secondEntry);
  await page.getByRole("button", { name: "이전 날", exact: true }).click();
  await expect(page.locator(".date-line")).toContainText(today);
  await expect(writing).toHaveValue(firstEntry);
  await save.click();
  await expect(journal.locator(".journal-save-status")).toHaveText("글을 저장했습니다.");
  await expect(save).toBeDisabled();
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await expect(writing).toHaveValue(secondEntry);
  await save.click();
  await expect(journal.locator(".journal-save-status")).toHaveText("글을 저장했습니다.");
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(page.locator(".date-line")).toContainText(today);
  await expect(writing).toHaveValue(firstEntry);
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await expect(writing).toHaveValue(secondEntry);
  await expect(save).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a lost journal save keeps its text and retries the same committed request once", async ({ page }) => {
  const keys: string[] = [];
  let loseOnce = true;
  await page.route("**/api/journal/*", async route => {
    if (route.request().method() === "PUT") {
      keys.push(route.request().headers()["idempotency-key"]);
      if (loseOnce) {
        loseOnce = false;
        const committed = await route.fetch();
        expect(committed.status()).toBe(200);
        await route.abort("failed");
        return;
      }
    }
    await route.continue();
  });
  await page.goto("/");
  const journal = page.getByRole("region", { name: "자유 기록", exact: true });
  const writing = journal.getByRole("textbox", { name: "자유롭게 쓰는 글", exact: true });
  await expect(writing).toBeEnabled();
  const today = (await page.locator(".date-line").textContent() ?? "").slice(0, 10);
  const content = "응답이 사라져도 보존할 글\n\n  마지막 줄  ";
  await writing.fill(content);
  await journal.getByRole("button", { name: "글 저장", exact: true }).click();
  await expect(journal.getByRole("button", { name: "같은 글 다시 저장", exact: true })).toBeVisible();
  await expect(writing).toHaveValue(content);
  await expect(writing).toBeDisabled();
  await expect(page.getByRole("button", { name: "다음 날", exact: true })).toBeDisabled();
  await expect(page.getByLabel("지금 떠오른 일")).toBeDisabled();
  const committed = await page.request.get(`/api/journal/${today}`);
  expect(committed.status()).toBe(200);
  expect(await committed.json()).toMatchObject({ date: today, content, version: 1 });
  const nextServerDate = Temporal.PlainDate.from(today).add({ days: 1 }).toString();
  await page.route("**/api/session", async route => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    const current = await route.fetch();
    expect(current.status()).toBe(200);
    await route.fulfill({ response: current, json: { ...await current.json(), serverDate: nextServerDate } });
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".diary-current-date")).toContainText("선택한 페이지");
  await expect(page.locator(".date-line")).toContainText(today);
  await expect(writing).toHaveValue(content);
  await expect(writing).toBeDisabled();
  await page.unroute("**/api/session");
  await page.getByRole("button", { name: "목록 새로고침", exact: true }).click();
  await expect(page.locator(".diary-current-date")).toContainText("오늘의 페이지");
  await expect(page.locator(".date-line")).toContainText(today);
  await expect(writing).toHaveValue(content);
  await journal.getByRole("button", { name: "같은 글 다시 저장", exact: true }).click();
  await expect(journal.locator(".journal-save-status")).toHaveText("글을 저장했습니다.");
  await expect(writing).toBeEnabled();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  const replayed = await page.request.get(`/api/journal/${today}`);
  expect(await replayed.json()).toMatchObject({ date: today, content, version: 1 });
  await page.reload();
  await expect(writing).toHaveValue(content);
});

test("a journal conflict preserves the draft until either explicit conflict choice", async ({ page }) => {
  await page.goto("/");
  const journal = page.getByRole("region", { name: "자유 기록", exact: true });
  const writing = journal.getByRole("textbox", { name: "자유롭게 쓰는 글", exact: true });
  await expect(writing).toBeEnabled();
  const session = await (await page.request.get("/api/session")).json();
  const path = `/api/journal/${session.serverDate}`;
  const mine = "내가 쓴 글\n보존해야 하는 문단";
  await writing.fill(mine);
  const remote = await page.request.put(path, {
    headers: { Origin: "http://127.0.0.1:3101", "X-CSRF-Token": session.csrfToken, "Idempotency-Key": randomUUID(), "If-Match": '"v0"' },
    data: { content: "다른 탭에서 먼저 저장한 글" },
  });
  expect(remote.status()).toBe(200);
  await journal.getByRole("button", { name: "글 저장", exact: true }).click();
  await expect(journal.getByRole("button", { name: "내 글 다시 저장", exact: true })).toBeVisible();
  await expect(journal.getByRole("button", { name: "저장된 글 사용", exact: true })).toBeVisible();
  await expect(writing).toHaveValue(mine);
  await journal.getByRole("button", { name: "내 글 다시 저장", exact: true }).click();
  await expect(journal.locator(".journal-save-status")).toHaveText("글을 저장했습니다.");
  const resolved = await page.request.get(path);
  expect(await resolved.json()).toMatchObject({ content: mine, version: 2 });
  await writing.fill("두 번째 충돌에서도 남아 있는 내 초안");
  const newer = "이번에는 저장된 글을 선택합니다.\n최신 문단";
  const secondRemote = await page.request.put(path, {
    headers: { Origin: "http://127.0.0.1:3101", "X-CSRF-Token": session.csrfToken, "Idempotency-Key": randomUUID(), "If-Match": '"v2"' },
    data: { content: newer },
  });
  expect(secondRemote.status()).toBe(200);
  await journal.getByRole("button", { name: "글 저장", exact: true }).click();
  await expect(journal.getByRole("button", { name: "저장된 글 사용", exact: true })).toBeVisible();
  await expect(writing).toHaveValue("두 번째 충돌에서도 남아 있는 내 초안");
  await journal.getByRole("button", { name: "저장된 글 사용", exact: true }).click();
  await expect(writing).toHaveValue(newer);
  await expect(journal.getByRole("button", { name: "글 저장", exact: true })).toBeDisabled();
  await page.reload();
  await expect(writing).toHaveValue(newer);
  const selected = await page.request.get(path);
  expect(await selected.json()).toMatchObject({ content: newer, version: 3 });
});

test("a delayed journal page cannot overwrite another date's unsaved text", async ({ page }) => {
  await page.goto("/");
  const journal = page.getByRole("region", { name: "자유 기록", exact: true });
  const writing = journal.getByRole("textbox", { name: "자유롭게 쓰는 글", exact: true });
  await expect(writing).toBeEnabled();
  const session = await (await page.request.get("/api/session")).json();
  const today = Temporal.PlainDate.from(session.serverDate);
  const tomorrow = today.add({ days: 1 }).toString(), followingDay = today.add({ days: 2 }).toString();
  for (const [date, content] of [[tomorrow, "늦게 도착할 이전 날짜의 글"], [followingDay, "현재 날짜에 저장된 글"]]) {
    const seeded = await page.request.put(`/api/journal/${date}`, {
      headers: { Origin: "http://127.0.0.1:3101", "X-CSRF-Token": session.csrfToken, "Idempotency-Key": randomUUID(), "If-Match": '"v0"' },
      data: { content },
    });
    expect(seeded.status()).toBe(200);
  }
  let markHeld: () => void = () => {}, releaseResponse: () => void = () => {};
  const held = new Promise<void>(resolve => { markHeld = resolve; });
  const release = new Promise<void>(resolve => { releaseResponse = resolve; });
  let delayOnce = true;
  await page.route(`**/api/journal/${tomorrow}`, async route => {
    if (!delayOnce || route.request().method() !== "GET") { await route.continue(); return; }
    delayOnce = false;
    const previousEntry = await route.fetch();
    markHeld();
    await release;
    await route.fulfill({ response: previousEntry });
  });
  try {
    await page.getByRole("button", { name: "다음 날", exact: true }).click();
    await held;
    await page.getByRole("button", { name: "다음 날", exact: true }).click();
    await expect(page.locator(".date-line")).toContainText(followingDay);
    await expect(writing).toHaveValue("현재 날짜에 저장된 글");
    await writing.fill("현재 날짜의 미저장 글\n응답 순서와 무관하게 유지");
    const delivered = page.waitForResponse(response => new URL(response.url()).pathname === `/api/journal/${tomorrow}` && response.request().method() === "GET");
    releaseResponse();
    await (await delivered).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator(".date-line")).toContainText(followingDay);
    await expect(writing).toHaveValue("현재 날짜의 미저장 글\n응답 순서와 무관하게 유지");
    await expect(journal.getByRole("button", { name: "글 저장", exact: true })).toBeEnabled();
    await expect(journal.getByRole("alert")).toHaveCount(0);
  } finally { releaseResponse(); }
});

test("a temporary session failure preserves the journal draft until the same account recovers", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.", { timeout: 15000 });
  const journal = page.getByRole("region", { name: "자유 기록", exact: true });
  const writing = journal.getByRole("textbox", { name: "자유롭게 쓰는 글", exact: true });
  await expect(writing).toBeEnabled();
  const content = "일시적인 세션 오류에도 남겨둘 글\n  같은 계정으로 계속 작성  ";
  await writing.fill(content);
  let unavailable = true;
  await page.route("**/api/session", async route => {
    if (unavailable && route.request().method() === "GET") {
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ code: "UNAUTHENTICATED" }) });
      return;
    }
    await route.continue();
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(writing).toBeDisabled();
  await expect(writing).toHaveValue(content);
  await expect(journal.getByRole("button", { name: "글 저장", exact: true })).toBeDisabled();
  unavailable = false;
  await page.getByRole("button", { name: "목록 새로고침", exact: true }).click();
  await expect(writing).toBeEnabled();
  await expect(writing).toHaveValue(content);
  await journal.getByRole("button", { name: "글 저장", exact: true }).click();
  await expect(journal.locator(".journal-save-status")).toHaveText("글을 저장했습니다.");
  await page.reload();
  await expect(writing).toHaveValue(content);
});
