import { createHash, randomBytes, randomUUID } from "node:crypto";
import { makeSignature } from "better-auth/crypto";
import { Pool } from "pg";
import { type BrowserContext, type Page, expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { join } from "node:path";
import { Temporal } from "@js-temporal/polyfill";


function dailyRow(page: Page, title: string) {
  return page.locator(".daily-task-row[data-task-id]").filter({ has: page.getByRole("button", { name: `${title} 상태 변경`, exact: true }) });
}
async function addDaily(page: Page, title: string) {
  await showDiaryPage(page, "할 일·일정");
  await closeHistory(page);
  const index = await page.locator(".daily-task-row[data-task-id]").count() + 1;
  const input = page.getByRole("textbox", { name: `${index}번째 할 일`, exact: true });
  await input.fill(title);
  await input.press("Enter");
  await expect(dailyRow(page, title)).toBeVisible();
}
async function setDailyStatus(page: Page, title: string, state: "완료" | "미루기" | "진행 전" | "취소") {
  await showDiaryPage(page, "할 일·일정");
  await closeHistory(page);
  await dailyRow(page, title).getByRole("button", { name: `${title} 상태 변경`, exact: true }).click();
  await page.getByRole("group", { name: `${title} 상태 선택`, exact: true }).getByRole("button", { name: state, exact: true }).click();
}

async function showDiaryPage(page: Page, name: "할 일·일정" | "자유 기록") {
  if (name === "자유 기록") await closeHistory(page);
  const tab = page.getByRole("tab", { name, exact: true });
  if (await tab.isVisible()) await tab.click();
}
async function showScheduleSlot(page: Page, time: string) {
  await showDiaryPage(page, "할 일·일정");
  const [hours, minutes] = time.split(":").map(Number);
  await page.getByRole("combobox", { name: "일정 시간대", exact: true }).selectOption(String(Math.floor((hours * 60 + minutes - 360) / 120)));
}
async function moveTask(page: Page, title: string, direction: "up" | "down") {
  const handle = dailyRow(page, title).getByRole("button", { name: `${title} 순서 이동`, exact: true });
  await handle.focus();
  await handle.press("Space");
  await handle.press(direction === "up" ? "ArrowUp" : "ArrowDown");
  await handle.press("Space");
}
async function pickDate(page: Page, date: string) {
  const wanted = Temporal.PlainDate.from(date);
  const current = Temporal.PlainDate.from((await page.locator(".date-line").textContent() ?? "").slice(0, 10));
  await page.getByRole("button", { name: "날짜 선택", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "날짜 선택", exact: true });
  const difference = (wanted.year - current.year) * 12 + wanted.month - current.month;
  for (let i = 0; i < Math.abs(difference); i++) await dialog.getByRole("button", { name: difference > 0 ? "다음 달" : "이전 달", exact: true }).click();
  await dialog.getByRole("button", { name: `${wanted.day}, ${wanted.year}년 ${wanted.month}월 ${wanted.day}일`, exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".date-line")).toContainText(date);
}
async function dragTask(page: Page, title: string, target: string, touch: boolean) {
  const handle = dailyRow(page, title).getByRole("button", { name: `${title} 순서 이동`, exact: true });
  const from = await handle.boundingBox(), to = await dailyRow(page, target).boundingBox();
  expect(from).not.toBeNull(); expect(to).not.toBeNull();
  if (!from || !to) throw new Error("Drag endpoints must be visible");
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const end = { x: start.x, y: to.y + to.height / 2 };
  if (touch) {
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...start, id: 1 }] });
      for (let step = 1; step <= 8; step++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x, y: start.y + (end.y - start.y) * step / 8, id: 1 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } finally { await cdp.detach(); }
  } else {
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 8 }); await page.mouse.up();
  }
}
async function expectViewport(page: Page) {
  expect(await page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth <= window.innerWidth,
    vertical: document.documentElement.scrollHeight <= window.innerHeight,
    bodyFits: document.body.scrollHeight <= window.innerHeight,
  }))).toEqual({ horizontal: true, vertical: true, bodyFits: true });
}

async function closeHistory(page: Page) {
  const history = page.locator("details.archive-tasks[open]");
  if (await history.count()) await history.locator("summary").click();
}
async function openHistory(page: Page) {
  await showDiaryPage(page, "할 일·일정");
  const history = page.locator("details").filter({ has: page.getByText("이전 기록과 입력함", { exact: true }) });
  if (await history.getAttribute("open") === null) await history.locator("summary").click();
}


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
async function createStoredTask(page: Page, title: string, fields: Record<string, unknown> = {}) {
  const session = await (await page.request.get("/api/session")).json();
  const response = await page.request.post("/api/tasks", {
    headers: { Origin: "http://127.0.0.1:3101", "X-CSRF-Token": session.csrfToken, "Idempotency-Key": randomUUID() },
    data: { title, ...fields },
  });
  expect(response.status()).toBe(201);
  return response.json();
}
test.beforeEach(async ({ context }) => seedSession(context));

test("inline daily creation and status undo keep the same original task", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.", { timeout: 15000 });
  await expect(page.getByRole("heading", { name: "오늘을 가볍게." })).toBeVisible();
  const first = page.getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true });
  await first.fill("  ");
  await first.press("Enter");
  await expect(page.locator(".daily-task-row[data-task-id]")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "2번째 할 일", exact: true })).toBeDisabled();
  await first.fill("오늘의 제안서");
  const created = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tasks" && response.request().method() === "POST", { timeout: 10000 });
  await first.press("Enter");
  expect((await created).status()).toBe(201);
  const row = dailyRow(page, "오늘의 제안서");
  await expect(row).toBeVisible();
  const id = await row.getAttribute("data-task-id");
  const completed = page.waitForResponse(response => new URL(response.url()).pathname === `/api/tasks/${id}` && response.request().method() === "PATCH", { timeout: 10000 });
  await setDailyStatus(page, "오늘의 제안서", "완료");
  expect((await completed).status()).toBe(200);
  await expect(row.locator(".bullet-symbol")).toHaveText("✓");
  await setDailyStatus(page, "오늘의 제안서", "진행 전");
  await expect(row.locator(".bullet-symbol")).toHaveText("□");
  await expect(row).toHaveAttribute("data-task-id", id ?? "");
  await openHistory(page);
  await expect(page.getByRole("region", { name: "입력함", exact: true }).getByText("오늘의 제안서", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (process.env.PLANNER_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.PLANNER_SCREENSHOT_DIR, `planner-${testInfo.project.name}.png`), fullPage: true });
});

test("an account change clears the prior account's draft and visible tasks", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.", { timeout: 15000 });
  await addDaily(page, "첫 계정의 비공개 과제");
  await showDiaryPage(page, "자유 기록");
  await page.getByRole("textbox", { name: "자유롭게 쓰는 글", exact: true, includeHidden: true }).fill("첫 계정의 미저장 자유 기록");
  await showDiaryPage(page, "할 일·일정");
  await page.getByLabel("06:00 일정", { exact: true }).fill("첫 계정의 미저장 일정");
  await page.getByRole("textbox", { name: "2번째 할 일", exact: true }).fill("첫 계정의 미저장 입력");
  await seedSession(context);
  page.on("dialog", dialog => dialog.accept());
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true })).toHaveValue("");
  await expect(dailyRow(page, "첫 계정의 비공개 과제")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "자유롭게 쓰는 글", exact: true, includeHidden: true })).toHaveValue("");
  await expect(page.getByLabel("06:00 일정", { exact: true })).toHaveValue("");
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
  await page.getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true }).fill("오래된 불확실 요청");
  const responseLost = page.waitForEvent("requestfailed", {
    predicate: request => new URL(request.url()).pathname === "/api/tasks" && request.method() === "POST",
    timeout: 15000,
  });
  await page.getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true }).press("Enter");
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
  await expect(page.getByLabel("06:00 일정", { exact: true })).toBeEnabled({ timeout: 15000 });
  await expect(page.getByRole("textbox", { name: "자유롭게 쓰는 글", exact: true, includeHidden: true })).toBeEnabled();
  for (const name of ["할 일·일정", "자유 기록"] as const) {
    await showDiaryPage(page, name);
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(result.violations).toEqual([]);
  }
  await page.getByRole("button", { name: "날짜 선택", exact: true }).click();
  await page.locator(".calendar-day.is-selected").hover();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "달력 닫기", exact: true }).click();
});

test("a timezone change during loading does not label old-calendar results as current", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.", { timeout: 15000 });
  await createStoredTask(page, "날짜 기준 경합");
  await page.getByRole("button", { name: "목록 새로고침", exact: true }).click();
  await openHistory(page);
  await expect(page.getByRole("region", { name: "입력함", exact: true }).getByText("날짜 기준 경합", { exact: true })).toBeVisible();
  const session = await (await page.request.get("/api/session")).json();
  let changeOnce = true;
  await page.route("**/api/tasks?view=day&**", async route => {
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
  await page.goto("/"); await page.getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true }).fill("응답 유실 복구");
  await page.getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true }).press("Enter");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("확인");
  await expect(page.getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true })).toHaveValue("응답 유실 복구");
  await page.getByRole("button", { name: "같은 요청 재시도" }).click();
  await expect(dailyRow(page, "응답 유실 복구")).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true })).toHaveValue("응답 유실 복구");
  await expect(page.getByRole("textbox", { name: "2번째 할 일", exact: true })).toHaveValue("");
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
});

test("stale inline title editing preserves the draft for an explicit conflict choice", async ({ page }) => {
  await page.goto("/");
  await addDaily(page, "충돌 전 제목");
  const row = dailyRow(page, "충돌 전 제목");
  const id = await row.getAttribute("data-task-id");
  await row.getByRole("textbox").fill("내 변경");
  const session = await (await page.request.get("/api/session")).json();
  const remote = await page.request.patch(`/api/tasks/${id}`, { headers: { Origin: "http://127.0.0.1:3101", "X-CSRF-Token": session.csrfToken, "Idempotency-Key": randomUUID(), "If-Match": '"v1"' }, data: { title: "다른 탭의 최신 제목" } });
  expect(remote.status()).toBe(200);
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/session" && response.request().method() === "GET");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect((await refreshed).status()).toBe(200);
  await expect(row).toHaveAttribute("data-task-id", id ?? "");
  await expect(dailyRow(page, "다른 탭의 최신 제목")).toHaveCount(0);
  const inline = page.getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true });
  await expect(inline).toHaveValue("내 변경");
  await inline.press("Enter");
  const conflict = page.getByRole("region", { name: "수정 충돌 확인" });
  await expect(conflict).toContainText("다른 탭의 최신 제목");
  await expect(conflict).toContainText("내 변경");
  await conflict.getByRole("button", { name: "내 변경 다시 적용" }).click();
  await expect(dailyRow(page, "내 변경")).toHaveAttribute("data-task-id", id ?? "");
  await expect(page.getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true })).toHaveValue("내 변경");
});

test("inline editing keeps its original version and day through remote matching text, a date move and temporary session failure", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.", { timeout: 15000 });
  await addDaily(page, "옮기기 전 제목");
  const row = dailyRow(page, "옮기기 전 제목");
  const id = await row.getAttribute("data-task-id");
  const today = (await page.locator(".date-line").textContent() ?? "").slice(0, 10);
  const tomorrow = Temporal.PlainDate.from(today).add({ days: 1 }).toString();
  const inline = page.getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true });
  await inline.fill("같아진 제목");
  const session = await (await page.request.get("/api/session")).json();
  const remote = await page.request.patch(`/api/tasks/${id}`, {
    headers: { Origin: "http://127.0.0.1:3101", "X-CSRF-Token": session.csrfToken, "Idempotency-Key": randomUUID(), "If-Match": '"v1"' },
    data: { title: "같아진 제목", scheduledDate: tomorrow },
  });
  expect(remote.status()).toBe(200);
  expect(await remote.json()).toMatchObject({ title: "같아진 제목", scheduledDate: tomorrow, version: 2 });
  await page.route("**/api/session", route => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ code: "UNAUTHENTICATED", message: "Synthetic temporary session failure", requestId: "inline-session-fixture" }) }));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(inline).toBeDisabled();
  await expect(inline).toHaveValue("같아진 제목");
  await expect(row).toHaveAttribute("data-task-id", id ?? "");
  await expect(page.locator(".date-line")).toContainText(today);
  await page.unroute("**/api/session");
  await page.route("**/api/session", async route => {
    const current = await route.fetch();
    expect(current.status()).toBe(200);
    await route.fulfill({ response: current, json: { ...await current.json(), serverDate: tomorrow } });
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".diary-current-date")).toContainText("선택한 페이지");
  await expect(page.locator(".date-line")).toContainText(today);
  await expect(inline).toBeEnabled();
  await expect(inline).toHaveValue("같아진 제목");
  // Even matching remote text is dirty relative to the original editing snapshot.
  await inline.fill("같아진 제목 다시 수정");
  await inline.fill("같아진 제목");
  await expect(row.getByRole("button", { name: "할 일 저장", exact: true })).toBeEnabled();
  const attempted = page.waitForResponse(response => new URL(response.url()).pathname === `/api/tasks/${id}` && response.request().method() === "PATCH");
  await inline.press("Enter");
  const response = await attempted;
  expect(response.request().headers()["if-match"]).toBe('"v1"');
  expect(response.status()).toBe(412);
  const conflict = page.getByRole("region", { name: "수정 충돌 확인", exact: true });
  await expect(conflict).toContainText("같아진 제목");
  await expect(conflict).toContainText(tomorrow);
  await expect(inline).toHaveValue("같아진 제목");
  await conflict.getByRole("button", { name: "최신 내용 사용", exact: true }).click();
  await expect(page.locator(".date-line")).toContainText(tomorrow);
  await expect(dailyRow(page, "같아진 제목")).toHaveAttribute("data-task-id", id ?? "");
  const stored = await page.request.get(`/api/tasks/${id}`);
  expect(await stored.json()).toMatchObject({ title: "같아진 제목", scheduledDate: tomorrow, version: 2 });
});

test("timezone change persists and logout warns before discarding unsaved input", async ({ page }) => {
  await page.goto("/"); await page.getByText("기준 시간대 설정", { exact: false }).click();
  await page.getByLabel("IANA 시간대").fill("America/New_York");
  await page.getByRole("button", { name: "시간대 적용" }).click();
  await expect(page.locator(".date-line")).toContainText("America/New_York");
  await page.reload(); await expect(page.locator(".date-line")).toContainText("America/New_York");
  await showDiaryPage(page, "자유 기록");
  await page.getByRole("textbox", { name: "자유롭게 쓰는 글", exact: true, includeHidden: true }).fill("아직 저장하지 않은 입력");
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "로그아웃 / 계정 바꾸기" }).click();
  await expect(page.getByRole("textbox", { name: "자유롭게 쓰는 글", exact: true, includeHidden: true })).toHaveValue("아직 저장하지 않은 입력");
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
  await createStoredTask(page, "이전 페이지의 과제", { scheduledDate: tomorrow, isUnprocessed: false });
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await expect(dailyRow(page, "이전 페이지의 과제")).toBeVisible();
  await page.getByRole("button", { name: "이전 날", exact: true }).click();
  await expect(page.locator(".date-line")).toContainText(today.toString());
  await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.");

  let markHeld: () => void = () => {}, releaseResponse: () => void = () => {};
  const held = new Promise<void>(resolve => { markHeld = resolve; });
  const release = new Promise<void>(resolve => { releaseResponse = resolve; });
  let delayOnce = true;
  await page.route("**/api/tasks?view=day&**", async route => {
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
    await expect(dailyRow(page, "이전 페이지의 과제")).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText("최신 목록을 확인했습니다.");
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  } finally { releaseResponse(); }
});


test("status menus preserve daily rows and the date editor locks other changes", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.", { timeout: 15000 });
  await expect(page.getByRole("combobox", { name: /유형|우선순위/ })).toHaveCount(0);
  await expect(page.locator(".priority-badge")).toHaveCount(0);
  await addDaily(page, "상태 변경 확인");
  const active = dailyRow(page, "상태 변경 확인");
  await expect(active.locator(".bullet-symbol")).toHaveText("□");
  const toggle = active.getByRole("button", { name: "상태 변경 확인 상태 변경", exact: true });
  await toggle.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("group", { name: "상태 변경 확인 상태 선택", exact: true });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("button")).toHaveCount(4);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await setDailyStatus(page, "상태 변경 확인", "미루기");
  await expect(active.locator(".bullet-symbol")).toHaveText("→");
  const currentDay = (await page.locator(".date-line").textContent() ?? "").slice(0, 10);
  const tomorrow = Temporal.PlainDate.from(currentDay).add({ days: 1 }).toString();
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await expect(page.locator(".date-line")).toContainText(tomorrow);
  await openHistory(page);
  const overdue = page.getByRole("region", { name: "이전 날짜의 미완료", exact: true }).locator("[data-task-id]").filter({ hasText: "상태 변경 확인" });
  await expect(overdue.locator(".bullet-symbol")).toHaveText("→");
  await page.getByRole("button", { name: "이전 날", exact: true }).click();
  await setDailyStatus(page, "상태 변경 확인", "취소");
  await expect(active.locator(".bullet-symbol")).toHaveText("×");
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.");
  await openHistory(page);
  await expect(overdue).toHaveCount(0);
  await page.getByRole("button", { name: "이전 날", exact: true }).click();
  await setDailyStatus(page, "상태 변경 확인", "완료");
  await expect(active.locator(".bullet-symbol")).toHaveText("✓");
  await openHistory(page);
  await expect(page.getByRole("region", { name: "오늘 완료", exact: true }).getByText("상태 변경 확인", { exact: true })).toBeVisible();
  await setDailyStatus(page, "상태 변경 확인", "진행 전");
  await expect(active.locator(".bullet-symbol")).toHaveText("□");
  await addDaily(page, "편집 중 보호할 다른 일");
  const other = dailyRow(page, "편집 중 보호할 다른 일");
  await active.getByRole("button", { name: / 수정$/ }).click();
  const editor = page.locator(".edit-panel");
  await editor.getByLabel("실행 예정일", { exact: true }).fill(tomorrow);
  await expect(editor.getByRole("combobox", { name: /유형|우선순위/ })).toHaveCount(0);
  await expect(other.getByRole("textbox")).toBeDisabled();
  await expect(other.getByRole("button", { name: "편집 중 보호할 다른 일 상태 변경", exact: true })).toBeDisabled();
  await expect(other.getByRole("button", { name: "편집 중 보호할 다른 일 순서 이동", exact: true })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "3번째 할 일", exact: true })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "자유롭게 쓰는 글", exact: true, includeHidden: true })).toBeDisabled();
  await expect(page.getByLabel("06:00 일정", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "다음 날", exact: true })).toBeDisabled();
  await expect(page.locator("#timezone")).toBeDisabled();
  await expect(editor.getByLabel("실행 예정일", { exact: true })).toHaveValue(tomorrow);
  await editor.getByLabel("실행 예정일", { exact: true }).fill(currentDay);
  await editor.getByRole("button", { name: "변경 저장", exact: true }).click();
  await expect(other.getByRole("textbox")).toBeEnabled();
  await page.reload();
  await expect(active.locator(".bullet-symbol")).toHaveText("□");
  await expect(page.getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true })).toHaveValue("상태 변경 확인");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("an unscheduled organized completion returns to inbox after cancellation or completion undo", async ({ page }) => {
  await page.goto("/");
  await createStoredTask(page, "날짜 없는 기록");
  await page.reload();
  await openHistory(page);
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
  await openHistory(page);
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
  await openHistory(page);
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
  const oldCard = dailyRow(page, "이전에 저장한 기록");
  await expect(oldCard.locator(".bullet-symbol")).toHaveText("□");
  await expect(page.getByRole("combobox", { name: /유형|우선순위/ })).toHaveCount(0);
  await expect(page.locator(".priority-badge")).toHaveCount(0);
  await expect(page.locator(".symbol-legend").filter({ hasText: /약속|행사/ })).toHaveCount(0);
  await oldCard.getByRole("textbox").fill("제목을 고친 이전 기록");
  await oldCard.getByRole("textbox").press("Enter");
  const editedCard = dailyRow(page, "제목을 고친 이전 기록");
  await expect(editedCard).toBeVisible();
  await page.reload();
  await expect(editedCard.locator(".bullet-symbol")).toHaveText("□");
  const stored = await page.request.get(`/api/tasks/${id}`);
  expect(stored.status()).toBe(200);
  expect(await stored.json()).toMatchObject({ kind: "appointment", priority: "high", title: "제목을 고친 이전 기록" });
});


test("left-page tasks and right-page journal preserve separate dated entries and unsaved drafts", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.", { timeout: 15000 });
  const left = page.locator(".diary-page-left"), right = page.locator(".diary-page-right");
  await expect(left.getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true })).toBeVisible();
  await expect(left.getByRole("region", { name: "오늘의 할 일", exact: true })).toBeVisible();
  await expect(left.getByRole("region", { name: "하루 일정", exact: true })).toBeVisible();
  for (const name of ["오늘 완료", "입력함", "이전 날짜의 미완료"]) {
    await expect(left.getByRole("region", { name, exact: true, includeHidden: true })).toBeHidden();
    await expect(right.getByRole("region", { name, exact: true, includeHidden: true })).toHaveCount(0);
  }
  await openHistory(page);
  for (const name of ["오늘 완료", "입력함", "이전 날짜의 미완료"]) await expect(left.getByRole("region", { name, exact: true })).toBeVisible();
  await showDiaryPage(page, "자유 기록");
  const journal = right.getByRole("region", { name: "자유 기록", exact: true, includeHidden: true });
  const writing = journal.getByRole("textbox", { name: "자유롭게 쓰는 글", exact: true, includeHidden: true });
  const save = journal.getByRole("button", { name: "글 저장", exact: true, includeHidden: true });
  await expect(writing).toBeEnabled();
  await expect(writing).toHaveValue("");
  await expect(save).toBeDisabled();
  await expect(left.getByRole("region", { name: "자유 기록", exact: true, includeHidden: true })).toHaveCount(0);
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
  await showDiaryPage(page, "자유 기록");
  const journal = page.getByRole("region", { name: "자유 기록", exact: true, includeHidden: true });
  const writing = journal.getByRole("textbox", { name: "자유롭게 쓰는 글", exact: true, includeHidden: true });
  await expect(writing).toBeEnabled();
  const today = (await page.locator(".date-line").textContent() ?? "").slice(0, 10);
  const content = "응답이 사라져도 보존할 글\n\n  마지막 줄  ";
  await writing.fill(content);
  await journal.getByRole("button", { name: "글 저장", exact: true, includeHidden: true }).click();
  await expect(journal.getByRole("button", { name: "같은 글 다시 저장", exact: true })).toBeVisible();
  await expect(writing).toHaveValue(content);
  await expect(writing).toBeDisabled();
  await expect(page.getByRole("button", { name: "다음 날", exact: true })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true })).toBeDisabled();
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
  await showDiaryPage(page, "자유 기록");
  const journal = page.getByRole("region", { name: "자유 기록", exact: true, includeHidden: true });
  const writing = journal.getByRole("textbox", { name: "자유롭게 쓰는 글", exact: true, includeHidden: true });
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
  await journal.getByRole("button", { name: "글 저장", exact: true, includeHidden: true }).click();
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
  await journal.getByRole("button", { name: "글 저장", exact: true, includeHidden: true }).click();
  await expect(journal.getByRole("button", { name: "저장된 글 사용", exact: true })).toBeVisible();
  await expect(writing).toHaveValue("두 번째 충돌에서도 남아 있는 내 초안");
  await journal.getByRole("button", { name: "저장된 글 사용", exact: true }).click();
  await expect(writing).toHaveValue(newer);
  await expect(journal.getByRole("button", { name: "글 저장", exact: true, includeHidden: true })).toBeDisabled();
  await page.reload();
  await expect(writing).toHaveValue(newer);
  const selected = await page.request.get(path);
  expect(await selected.json()).toMatchObject({ content: newer, version: 3 });
});

test("a delayed journal page cannot overwrite another date's unsaved text", async ({ page }) => {
  await page.goto("/");
  await showDiaryPage(page, "자유 기록");
  const journal = page.getByRole("region", { name: "자유 기록", exact: true, includeHidden: true });
  const writing = journal.getByRole("textbox", { name: "자유롭게 쓰는 글", exact: true, includeHidden: true });
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
    await expect(journal.getByRole("button", { name: "글 저장", exact: true, includeHidden: true })).toBeEnabled();
    await expect(journal.getByRole("alert")).toHaveCount(0);
  } finally { releaseResponse(); }
});

test("a temporary session failure preserves the journal draft until the same account recovers", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.", { timeout: 15000 });
  await showDiaryPage(page, "자유 기록");
  const journal = page.getByRole("region", { name: "자유 기록", exact: true, includeHidden: true });
  const writing = journal.getByRole("textbox", { name: "자유롭게 쓰는 글", exact: true, includeHidden: true });
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
  await expect(journal.getByRole("button", { name: "글 저장", exact: true, includeHidden: true })).toBeDisabled();
  unavailable = false;
  await page.getByRole("button", { name: "목록 새로고침", exact: true }).click();
  await expect(writing).toBeEnabled();
  await expect(writing).toHaveValue(content);
  await journal.getByRole("button", { name: "글 저장", exact: true, includeHidden: true }).click();
  await expect(journal.locator(".journal-save-status")).toHaveText("글을 저장했습니다.");
  await page.reload();
  await expect(writing).toHaveValue(content);
});

test("five sequential lines keep completed and canceled tasks until one is moved", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.", { timeout: 15000 });
  const day = page.getByRole("region", { name: "오늘의 할 일", exact: true });
  await expect(day.locator(".daily-task-row")).toHaveCount(5);
  await expect(day.getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true })).toBeEnabled();
  for (let index = 2; index <= 5; index++) await expect(day.getByRole("textbox", { name: `${index}번째 할 일`, exact: true })).toBeDisabled();
  for (let index = 1; index <= 5; index++) {
    await addDaily(page, `하루 할 일 ${index}`);
    await expect(day.locator(".daily-task-row[data-task-id]")).toHaveCount(index);
    if (index < 5) await expect(day.getByRole("textbox", { name: `${index + 1}번째 할 일`, exact: true })).toBeEnabled();
  }
  await expect(day).toContainText(/5\s*\/\s*5/);
  await expect(day.getByRole("textbox", { name: "6번째 할 일", exact: true })).toHaveCount(0);
  await setDailyStatus(page, "하루 할 일 1", "완료");
  await setDailyStatus(page, "하루 할 일 2", "취소");
  await expect(dailyRow(page, "하루 할 일 1").locator(".bullet-symbol")).toHaveText("✓");
  await expect(dailyRow(page, "하루 할 일 2").locator(".bullet-symbol")).toHaveText("×");
  await expect(day.locator(".daily-task-row[data-task-id]")).toHaveCount(5);
  const date = (await page.locator(".date-line").textContent() ?? "").slice(0, 10);
  const tomorrow = Temporal.PlainDate.from(date).add({ days: 1 }).toString();
  const moving = dailyRow(page, "하루 할 일 3");
  const id = await moving.getAttribute("data-task-id");
  await moving.getByRole("button", { name: / 수정$/ }).click();
  await page.locator(".edit-panel").getByLabel("실행 예정일", { exact: true }).fill(tomorrow);
  await page.getByRole("button", { name: "변경 저장", exact: true }).click();
  await expect(day.locator(".daily-task-row[data-task-id]")).toHaveCount(4);
  await expect(day.getByRole("textbox", { name: "5번째 할 일", exact: true })).toBeEnabled();
  await addDaily(page, "빈 자리에 추가한 일");
  await expect(day.locator(".daily-task-row[data-task-id]")).toHaveCount(5);
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await expect(dailyRow(page, "하루 할 일 3")).toHaveAttribute("data-task-id", id ?? "");
  await expect(page.locator(".daily-task-row[data-task-id]")).toHaveCount(1);
  await page.reload();
  await expect(day.locator(".daily-task-row[data-task-id]")).toHaveCount(5);
  await expect(dailyRow(page, "하루 할 일 1").locator(".bullet-symbol")).toHaveText("✓");
});

test("the 36 half-hour schedule rows keep first and last slots separate by date", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.", { timeout: 15000 });
  const schedule = page.getByRole("region", { name: "하루 일정", exact: true });
  const first = schedule.getByRole("textbox", { name: "06:00 일정", exact: true });
  const last = schedule.getByRole("textbox", { name: "23:30 일정", exact: true });
  const save = schedule.getByRole("button", { name: "일정 저장", exact: true });
  for (let period = 0; period < 9; period++) {
    await schedule.getByRole("combobox", { name: "일정 시간대", exact: true }).selectOption(String(period));
    await expect(schedule.getByRole("textbox")).toHaveCount(4);
    for (let minute = 360 + period * 120; minute < 480 + period * 120; minute += 30) {
      const label = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")} 일정`;
      await expect(schedule.getByRole("textbox", { name: label, exact: true })).toBeVisible();
    }
  }
  await expect(schedule).toContainText(/23:30\s*[–-]\s*24:00/);
  await showScheduleSlot(page, "06:00");
  await expect(schedule).toContainText(/06:00\s*[–-]\s*06:30/);
  await showScheduleSlot(page, "06:00");
  await expect(first).toBeEnabled();
  await expect(save).toBeDisabled();
  await showScheduleSlot(page, "06:00");
  await first.fill("아침 계획");
  await showScheduleSlot(page, "23:30");
  await last.fill("하루 마무리");
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "로그아웃 / 계정 바꾸기", exact: true }).click();
  await showScheduleSlot(page, "06:00");
  await expect(first).toHaveValue("아침 계획");
  await showScheduleSlot(page, "23:30");
  await expect(last).toHaveValue("하루 마무리");
  await save.click();
  await expect(schedule.locator(".schedule-save-status")).toHaveText("일정을 저장했습니다.");
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await showScheduleSlot(page, "06:00");
  await expect(first).toBeEnabled();
  await showScheduleSlot(page, "06:00");
  await expect(first).toHaveValue("");
  await showScheduleSlot(page, "23:30");
  await expect(last).toHaveValue("");
  await showScheduleSlot(page, "06:00");
  await first.fill("다음 날짜 아침");
  await page.getByRole("button", { name: "이전 날", exact: true }).click();
  await showScheduleSlot(page, "06:00");
  await expect(first).toHaveValue("아침 계획");
  await showScheduleSlot(page, "23:30");
  await expect(last).toHaveValue("하루 마무리");
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await showScheduleSlot(page, "06:00");
  await expect(first).toHaveValue("다음 날짜 아침");
  await save.click();
  await expect(schedule.locator(".schedule-save-status")).toHaveText("일정을 저장했습니다.");
  await page.reload();
  await showScheduleSlot(page, "06:00");
  await expect(first).toHaveValue("아침 계획");
  await showScheduleSlot(page, "23:30");
  await expect(last).toHaveValue("하루 마무리");
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await showScheduleSlot(page, "06:00");
  await expect(first).toHaveValue("다음 날짜 아침");
  await showScheduleSlot(page, "23:30");
  await expect(last).toHaveValue("");
  await expect(save).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("an uncertain schedule save keeps slots and replays the same request without another version", async ({ page }) => {
  const keys: string[] = [];
  let loseOnce = true;
  await page.route("**/api/schedule/*", async route => {
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
  const schedule = page.getByRole("region", { name: "하루 일정", exact: true });
  const first = schedule.getByLabel("06:00 일정", { exact: true });
  await showScheduleSlot(page, "06:00");
  await expect(first).toBeEnabled();
  const date = (await page.locator(".date-line").textContent() ?? "").slice(0, 10);
  await showScheduleSlot(page, "06:00");
  await first.fill("응답 유실 후에도 유지할 일정");
  const responseLost = page.waitForEvent("requestfailed", {
    predicate: request => new URL(request.url()).pathname === `/api/schedule/${date}` && request.method() === "PUT",
    timeout: 15000,
  });
  await schedule.getByRole("button", { name: "일정 저장", exact: true }).click();
  await responseLost;
  const retry = schedule.getByRole("button", { name: "같은 일정 다시 저장", exact: true });
  await expect(retry).toBeEnabled();
  await showScheduleSlot(page, "06:00");
  await expect(first).toHaveValue("응답 유실 후에도 유지할 일정");
  await showScheduleSlot(page, "06:00");
  await expect(first).toBeDisabled();
  await expect(page.getByRole("button", { name: "다음 날", exact: true })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "자유롭게 쓰는 글", exact: true, includeHidden: true })).toBeDisabled();
  const committed = await page.request.get(`/api/schedule/${date}`);
  expect(committed.status()).toBe(200);
  expect(await committed.json()).toMatchObject({ date, version: 1, slots: [{ startMinute: 360, title: "응답 유실 후에도 유지할 일정" }] });
  await retry.click();
  await expect(schedule.locator(".schedule-save-status")).toHaveText("일정을 저장했습니다.");
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  const replayed = await page.request.get(`/api/schedule/${date}`);
  expect(await replayed.json()).toMatchObject({ version: 1 });
  await page.reload();
  await showScheduleSlot(page, "06:00");
  await expect(first).toHaveValue("응답 유실 후에도 유지할 일정");
});

test("schedule conflicts preserve slots until the user chooses their draft or the saved schedule", async ({ page }) => {
  await page.goto("/");
  const schedule = page.getByRole("region", { name: "하루 일정", exact: true });
  const first = schedule.getByLabel("06:00 일정", { exact: true });
  const last = schedule.getByLabel("23:30 일정", { exact: true });
  await showScheduleSlot(page, "06:00");
  await expect(first).toBeEnabled();
  const session = await (await page.request.get("/api/session")).json();
  const path = `/api/schedule/${session.serverDate}`;
  await showScheduleSlot(page, "06:00");
  await first.fill("내 아침 일정");
  await showScheduleSlot(page, "23:30");
  await last.fill("내 마지막 일정");
  const remote = await page.request.put(path, {
    headers: { Origin: "http://127.0.0.1:3101", "X-CSRF-Token": session.csrfToken, "Idempotency-Key": randomUUID(), "If-Match": '"v0"' },
    data: { slots: [{ startMinute: 360, title: "먼저 저장된 일정" }] },
  });
  expect(remote.status()).toBe(200);
  await schedule.getByRole("button", { name: "일정 저장", exact: true }).click();
  await expect(schedule.getByRole("button", { name: "내 일정 다시 저장", exact: true })).toBeVisible();
  await showScheduleSlot(page, "06:00");
  await expect(first).toHaveValue("내 아침 일정");
  await showScheduleSlot(page, "23:30");
  await expect(last).toHaveValue("내 마지막 일정");
  await schedule.getByRole("button", { name: "내 일정 다시 저장", exact: true }).click();
  await expect(schedule.locator(".schedule-save-status")).toHaveText("일정을 저장했습니다.");
  const resolved = await page.request.get(path);
  expect(await resolved.json()).toMatchObject({ version: 2, slots: [{ startMinute: 360, title: "내 아침 일정" }, { startMinute: 1410, title: "내 마지막 일정" }] });
  await showScheduleSlot(page, "06:00");
  await first.fill("다시 편집 중인 일정");
  const newer = await page.request.put(path, {
    headers: { Origin: "http://127.0.0.1:3101", "X-CSRF-Token": session.csrfToken, "Idempotency-Key": randomUUID(), "If-Match": '"v2"' },
    data: { slots: [{ startMinute: 1410, title: "선택할 최신 일정" }] },
  });
  expect(newer.status()).toBe(200);
  await schedule.getByRole("button", { name: "일정 저장", exact: true }).click();
  await expect(schedule.getByRole("button", { name: "저장된 일정 사용", exact: true })).toBeVisible();
  await showScheduleSlot(page, "06:00");
  await expect(first).toHaveValue("다시 편집 중인 일정");
  await schedule.getByRole("button", { name: "저장된 일정 사용", exact: true }).click();
  await showScheduleSlot(page, "06:00");
  await expect(first).toHaveValue("");
  await showScheduleSlot(page, "23:30");
  await expect(last).toHaveValue("선택할 최신 일정");
  await page.reload();
  await showScheduleSlot(page, "06:00");
  await expect(first).toHaveValue("");
  await showScheduleSlot(page, "23:30");
  await expect(last).toHaveValue("선택할 최신 일정");
});

test("inline title saves respect composition and row moves survive status changes and reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.", { timeout: 15000 });
  const first = page.getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true });
  await first.dispatchEvent("compositionstart");
  await first.fill("한글 작성");
  await first.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, keyCode: 229 });
  await expect(page.locator(".daily-task-row[data-task-id]")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "2번째 할 일", exact: true })).toBeDisabled();
  await first.dispatchEvent("compositionend", { data: "한글 작성" });
  await first.press("Enter");
  await expect(dailyRow(page, "한글 작성")).toBeVisible();
  const second = page.getByRole("textbox", { name: "2번째 할 일", exact: true });
  await second.fill("두 번째 일");
  await second.press("Tab");
  await expect(dailyRow(page, "두 번째 일")).toBeVisible();
  await addDaily(page, "세 번째 일");
  const edited = dailyRow(page, "두 번째 일");
  const id = await edited.getAttribute("data-task-id");
  await edited.getByRole("textbox").fill("수정한 두 번째 일");
  await edited.getByRole("button", { name: "할 일 저장", exact: true }).click();
  const renamed = dailyRow(page, "수정한 두 번째 일");
  await expect(renamed).toHaveAttribute("data-task-id", id ?? "");
  await expect(page.getByRole("textbox", { name: "2번째 할 일", exact: true })).toHaveValue("수정한 두 번째 일");
  await moveTask(page, "한글 작성", "up");
  await expect(page.getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true })).toHaveValue("한글 작성");
  await moveTask(page, "세 번째 일", "down");
  await expect(page.getByRole("textbox", { name: "3번째 할 일", exact: true })).toHaveValue("세 번째 일");
  await moveTask(page, "수정한 두 번째 일", "up");
  await expect(page.getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true })).toHaveValue("수정한 두 번째 일");
  await expect(renamed.getByRole("button", { name: "수정한 두 번째 일 순서 이동", exact: true })).toBeFocused();
  await setDailyStatus(page, "수정한 두 번째 일", "완료");
  await expect(renamed.locator(".bullet-symbol")).toHaveText("✓");
  await expect(renamed.getByRole("button", { name: "수정한 두 번째 일 상태 변경", exact: true })).toBeFocused();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true })).toHaveValue("수정한 두 번째 일");
  await expect(page.getByRole("textbox", { name: "2번째 할 일", exact: true })).toHaveValue("한글 작성");
  await expect(renamed).toHaveAttribute("data-task-id", id ?? "");
  await moveTask(page, "수정한 두 번째 일", "down");
  await expect(page.getByRole("textbox", { name: "2번째 할 일", exact: true })).toHaveValue("수정한 두 번째 일");
  await expect(renamed.getByRole("button", { name: "수정한 두 번째 일 순서 이동", exact: true })).toBeFocused();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "2번째 할 일", exact: true })).toHaveValue("수정한 두 번째 일");
  await expect(renamed.locator(".bullet-symbol")).toHaveText("✓");
  await expect(page.getByRole("combobox", { name: /우선순위/ })).toHaveCount(0);
  await expect(page.locator(".priority-badge")).toHaveCount(0);
});

test("pointer dragging moves a task to a distant row and Escape cancels keyboard movement", async ({ page, isMobile }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.", { timeout: 15000 });
  for (const title of ["첫 번째 계획", "두 번째 계획", "세 번째 계획"]) await addDaily(page, title);
  const moved = dailyRow(page, "세 번째 계획");
  const sourceId = await moved.getAttribute("data-task-id");
  const targetId = await dailyRow(page, "첫 번째 계획").getAttribute("data-task-id");
  const handle = moved.getByRole("button", { name: "세 번째 계획 순서 이동", exact: true });
  await handle.focus(); await handle.press("Space"); await handle.press("Home");
  await expect(page.getByRole("textbox", { name: "1번째 할 일", exact: true })).toHaveValue("첫 번째 계획");
  await handle.press("Escape");
  await expect(handle).toBeFocused();
  await expect(page.getByRole("textbox", { name: "3번째 할 일", exact: true })).toHaveValue("세 번째 계획");
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === `/api/tasks/${sourceId}` && response.request().method() === "PATCH");
  await dragTask(page, "세 번째 계획", "첫 번째 계획", isMobile);
  const response = await saved;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toEqual({ moveTo: targetId });
  await expect(page.getByRole("textbox", { name: "1번째 할 일", exact: true })).toHaveValue("세 번째 계획");
  await expect(page.getByRole("textbox", { name: "2번째 할 일", exact: true })).toHaveValue("첫 번째 계획");
  await expect(page.getByRole("textbox", { name: "3번째 할 일", exact: true })).toHaveValue("두 번째 계획");
  await expect(moved).toHaveAttribute("data-task-id", sourceId ?? "");
  await expect(handle).toBeFocused();
  await expectViewport(page);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "1번째 할 일", exact: true })).toHaveValue("세 번째 계획");
  await expect(page.getByRole("textbox", { name: "3번째 할 일", exact: true })).toHaveValue("두 번째 계획");
});

test("the visible date picker synchronizes tasks, schedule and journal within compact viewports", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.", { timeout: 15000 });
  const today = (await page.locator(".date-line").textContent() ?? "").slice(0, 10);
  const tomorrow = Temporal.PlainDate.from(today).add({ days: 1 }).toString();
  await addDaily(page, "오늘 날짜의 계획");
  await addDaily(page, "자료 정리하기");
  await addDaily(page, "산책하며 하루 돌아보기");
  await showScheduleSlot(page, "06:00");
  await page.getByLabel("06:00 일정", { exact: true }).fill("오늘 날짜의 일정");
  await page.getByRole("button", { name: "일정 저장", exact: true }).click();
  await expect(page.locator(".schedule-save-status")).toHaveText("일정을 저장했습니다.");
  await showDiaryPage(page, "자유 기록");
  await page.getByLabel("자유롭게 쓰는 글", { exact: true }).fill("오늘 날짜의 자유 기록");
  await page.getByRole("button", { name: "글 저장", exact: true }).click();
  await expect(page.locator(".journal-save-status")).toHaveText("글을 저장했습니다.");
  await pickDate(page, tomorrow);
  await showDiaryPage(page, "할 일·일정");
  await expect(page.locator(".daily-task-row[data-task-id]")).toHaveCount(0);
  await expect(page.getByLabel("06:00 일정", { exact: true })).toHaveValue("");
  await showDiaryPage(page, "자유 기록");
  await expect(page.getByLabel("자유롭게 쓰는 글", { exact: true })).toHaveValue("");
  await pickDate(page, today);
  await showDiaryPage(page, "할 일·일정");
  await expect(dailyRow(page, "오늘 날짜의 계획")).toBeVisible();
  await expect(page.getByLabel("06:00 일정", { exact: true })).toHaveValue("오늘 날짜의 일정");
  await showDiaryPage(page, "자유 기록");
  await expect(page.getByLabel("자유롭게 쓰는 글", { exact: true })).toHaveValue("오늘 날짜의 자유 기록");
  for (const viewport of [{ width: 1366, height: 768 }, { width: 707, height: 978 }, { width: 360, height: 800 }]) {
    await page.setViewportSize(viewport);
    await showDiaryPage(page, "할 일·일정");
    await expectViewport(page);
    for (let row = 1; row <= 5; row++) await expect(page.getByRole("textbox", { name: `${row}번째 할 일`, exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "일정 저장", exact: true })).toBeInViewport({ ratio: 1 });
    await showScheduleSlot(page, "23:30");
    await expect(page.getByLabel("23:30 일정", { exact: true })).toBeInViewport({ ratio: 1 });
    await expectViewport(page);
    await showDiaryPage(page, "자유 기록");
    await expect(page.getByLabel("자유롭게 쓰는 글", { exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "글 저장", exact: true })).toBeInViewport({ ratio: 1 });
    await expectViewport(page);
    const trigger = page.getByRole("button", { name: "날짜 선택", exact: true });
    await expect(trigger).toBeInViewport({ ratio: 1 });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "날짜 선택", exact: true });
    await expect(dialog).toBeInViewport({ ratio: 1 });
    await expectViewport(page);
    if (viewport.width === 707) await page.screenshot({ path: testInfo.outputPath("diary-calendar.png"), fullPage: false });
    await dialog.getByRole("button", { name: "달력 닫기", exact: true }).click();
    await expect(trigger).toBeFocused();
    if (viewport.width === 707) await page.screenshot({ path: testInfo.outputPath("diary-compact.png"), fullPage: false });
  }
});

test("canceling a drag after the server day advances reloads the new day's tasks", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("서버에 저장된 목록입니다.", { timeout: 15000 });
  await addDaily(page, "자정 전 첫 계획");
  await addDaily(page, "자정 전 두 번째 계획");
  const today = (await page.locator(".date-line").textContent() ?? "").slice(0, 10);
  const tomorrow = Temporal.PlainDate.from(today).add({ days: 1 }).toString();
  const tomorrowTask = await createStoredTask(page, "자정 후 계획", { scheduledDate: tomorrow, isUnprocessed: false });
  const row = dailyRow(page, "자정 전 두 번째 계획");
  const id = await row.getAttribute("data-task-id");
  const handle = row.getByRole("button", { name: "자정 전 두 번째 계획 순서 이동", exact: true });
  await handle.focus(); await handle.press("Space"); await handle.press("ArrowUp");
  await expect(handle).toHaveAttribute("aria-pressed", "true");
  await page.route("**/api/session", async route => {
    const current = await route.fetch();
    expect(current.status()).toBe(200);
    await route.fulfill({ response: current, json: { ...await current.json(), serverDate: tomorrow } });
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".diary-current-date")).toContainText("선택한 페이지");
  await expect(page.locator(".date-line")).toContainText(today);
  await expect(row).toBeVisible();
  await handle.press("Escape");
  await expect(page.locator(".date-line")).toContainText(tomorrow);
  await expect(page.locator(".diary-current-date")).toContainText("오늘의 페이지");
  await expect(dailyRow(page, "자정 후 계획")).toHaveAttribute("data-task-id", tomorrowTask.id);
  await expect(dailyRow(page, "자정 전 첫 계획")).toHaveCount(0);
  await expect(dailyRow(page, "자정 전 두 번째 계획")).toHaveCount(0);
  const original = await page.request.get(`/api/tasks/${id}`);
  expect(await original.json()).toMatchObject({ title: "자정 전 두 번째 계획", scheduledDate: today, version: 1 });
});
