import { type Locator, type Page, expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { Temporal } from "@js-temporal/polyfill";


function primary(page: Page) {
  return page.locator('.planner-day[data-panel="primary"]');
}
function secondary(page: Page) {
  return page.locator('.planner-day[data-panel="secondary"]');
}

function dailyRow(page: Page, title: string, scope: Locator = primary(page)) {
  return scope.locator(".daily-task-row[data-task-id]").filter({ has: page.getByRole("button", { name: `${title} 상태 변경`, exact: true }) });
}
async function addDaily(page: Page, title: string, scope: Locator = primary(page)) {
  await showDiaryPage(page, "할 일·일정", scope);
  await closeHistory(page, scope);
  const index = await scope.locator(".daily-task-row[data-task-id]").count() + 1;
  const input = scope.getByRole("textbox", { name: `${index}번째 할 일`, exact: true });
  await input.fill(title);
  await input.press("Enter");
  await expect(dailyRow(page, title, scope)).toBeVisible();
}
async function setDailyStatus(page: Page, title: string, state: "완료" | "미루기" | "진행 전" | "취소", scope: Locator = primary(page)) {
  await showDiaryPage(page, "할 일·일정", scope);
  await closeHistory(page, scope);
  await dailyRow(page, title, scope).getByRole("button", { name: `${title} 상태 변경`, exact: true }).click();
  await scope.getByRole("group", { name: `${title} 상태 선택`, exact: true }).getByRole("button", { name: state, exact: true }).click();
}

async function showDiaryPage(page: Page, name: "할 일·일정" | "자유 기록", scope: Locator = primary(page)) {
  if (name === "자유 기록") await closeHistory(page, scope);
  const tab = scope.getByRole("tab", { name, exact: true });
  if (await tab.isVisible()) await tab.click();
}
async function showScheduleSlot(page: Page, time: string, scope: Locator = primary(page)) {
  await showDiaryPage(page, "할 일·일정", scope);
  const [hours, minutes] = time.split(":").map(Number);
  await scope.getByRole("combobox", { name: "일정 시간대", exact: true }).selectOption(String(Math.floor((hours * 60 + minutes - 360) / 120)));
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
  const current = Temporal.PlainDate.from((await primary(page).locator(".date-line").textContent() ?? "").slice(0, 10));
  await page.getByRole("button", { name: "날짜 선택", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "날짜 선택", exact: true });
  const difference = (wanted.year - current.year) * 12 + wanted.month - current.month;
  for (let i = 0; i < Math.abs(difference); i++) await dialog.getByRole("button", { name: difference > 0 ? "다음 달" : "이전 달", exact: true }).click();
  await dialog.getByRole("button", { name: `${wanted.day}, ${wanted.year}년 ${wanted.month}월 ${wanted.day}일`, exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(primary(page).locator(".date-line")).toContainText(date);
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
async function expectScheduleSlotInViewport(slot: Locator, viewport: { name: string; width: number; height: number }) {
  const description = `${viewport.name} ${viewport.width}×${viewport.height}: 23:30 일정 must be fully visible`;
  try {
    await expect(slot, description).toBeInViewport({ ratio: 1 });
  } catch (error) {
    const layout = await slot.evaluate(element => {
      const boxes = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node !== element && !node.matches(".schedule-row, fieldset, .schedule-editor, .diary-page-left, .planner-day") && style.overflowX === "visible" && style.overflowY === "visible") continue;
        const rect = node.getBoundingClientRect();
        boxes.push({
          element: `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}.${node.className}`,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
          client: { width: node.clientWidth, height: node.clientHeight }, scroll: { top: node.scrollTop, left: node.scrollLeft, width: node.scrollWidth, height: node.scrollHeight },
          css: { overflowX: style.overflowX, overflowY: style.overflowY, boxSizing: style.boxSizing, minHeight: style.minHeight, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, borderTop: style.borderTopWidth, borderBottom: style.borderBottomWidth, lineHeight: style.lineHeight, gridTemplateRows: style.gridTemplateRows },
        });
      }
      return { viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, visualHeight: visualViewport?.height, visualScale: visualViewport?.scale }, boxes };
    }).catch(cause => ({ diagnosticError: cause instanceof Error ? cause.message : String(cause) }));
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nLayout diagnostics: ${JSON.stringify(layout)}`, { cause: error });
  }
}

async function expectViewport(page: Page) {
  expect(await page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth <= window.innerWidth,
    vertical: document.documentElement.scrollHeight <= window.innerHeight,
    bodyFits: document.body.scrollHeight <= window.innerHeight,
  }))).toEqual({ horizontal: true, vertical: true, bodyFits: true });
}

async function closeHistory(page: Page, scope: Locator = primary(page)) {
  const history = scope.locator("details.archive-tasks[open]");
  if (await history.count()) await history.locator("summary").click();
}
async function openHistory(page: Page, scope: Locator = primary(page)) {
  await showDiaryPage(page, "할 일·일정", scope);
  const history = scope.locator("details").filter({ has: page.getByText("이전 기록과 입력함", { exact: true }) });
  if (await history.getAttribute("open") === null) await history.locator("summary").click();
}


test("diary pages create directly on the selected day and retain the actual completion date", async ({ page }) => {
  await page.goto("/demo");
  await expect(primary(page).getByRole("status")).toHaveText("이 탭에 저장된 테스트 목록입니다.");
  const today = (await primary(page).locator(".date-line").textContent() ?? "").slice(0, 10);
  const tomorrow = Temporal.PlainDate.from(today).add({ days: 1 });
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await expect(primary(page).locator(".date-line")).toContainText(tomorrow.toString());
  await addDaily(page, "다음 페이지의 할 일");
  await expect(dailyRow(page, "다음 페이지의 할 일")).toBeVisible();
  await page.getByRole("button", { name: "이전 날", exact: true }).click();
  await expect(dailyRow(page, "다음 페이지의 할 일")).toHaveCount(0);
  await page.getByRole("button", { name: "날짜 선택", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "날짜 선택", exact: true });
  await dialog.getByRole("button", { name: "다음 달", exact: true }).click();
  await expect(primary(page).locator(".date-line")).toContainText(today);
  await dialog.getByRole("button", { name: "이전 달", exact: true }).click();
  if (tomorrow.month !== Temporal.PlainDate.from(today).month) await dialog.getByRole("button", { name: "다음 달", exact: true }).click();
  await dialog.getByRole("button", { name: `${tomorrow.day}, ${tomorrow.year}년 ${tomorrow.month}월 ${tomorrow.day}일`, exact: true }).click();
  await expect(dialog).toBeHidden();
  await setDailyStatus(page, "다음 페이지의 할 일", "완료");
  await expect(dailyRow(page, "다음 페이지의 할 일").locator(".bullet-symbol")).toHaveText("✓");
  await expect(primary(page).getByRole("status")).toContainText(`${today}의 완료 기록`);
  await page.getByRole("button", { name: "이전 날", exact: true }).click();
  await openHistory(page);
  await expect(primary(page).getByRole("region", { name: "오늘 완료", exact: true }).getByText("다음 페이지의 할 일", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("paused login offers a working demo with tab persistence and no product API traffic", async ({ page, context, request }) => {
  test.setTimeout(60_000); // Multiple dated views, reloads or accessibility scans share this scenario budget.
  const apiRequests: string[] = [];
  page.on("request", req => { if (new URL(req.url()).pathname.startsWith("/api/")) apiRequests.push(req.url()); });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Google로 시작하기" })).toBeDisabled();
  await page.getByRole("link", { name: "로그인 없이 테스트하기" }).click();
  await expect(primary(page).getByRole("status")).toHaveText("이 탭에 저장된 테스트 목록입니다.");
  await addDaily(page, "테스트 할 일");
  const row = dailyRow(page, "테스트 할 일");
  await row.getByRole("textbox").fill("수정한 테스트 할 일");
  await row.getByRole("textbox").press("Enter");
  const renamed = dailyRow(page, "수정한 테스트 할 일");
  await expect(renamed).toBeVisible();
  await setDailyStatus(page, "수정한 테스트 할 일", "완료");
  await expect(renamed.locator(".bullet-symbol")).toHaveText("✓");
  await setDailyStatus(page, "수정한 테스트 할 일", "진행 전");
  await expect(renamed.locator(".bullet-symbol")).toHaveText("□");
  await page.reload();
  await expect(renamed.getByRole("textbox")).toHaveValue("수정한 테스트 할 일");
  const schedule = primary(page).getByRole("region", { name: "하루 일정", exact: true });
  await schedule.getByLabel("06:00 일정", { exact: true }).fill("제품 API 없이 저장할 일정");
  await schedule.getByRole("button", { name: "일정 저장", exact: true }).click();
  await expect(schedule.locator(".schedule-save-status")).toHaveText("일정을 저장했습니다.");
  await showDiaryPage(page, "자유 기록");
  const journal = primary(page).getByRole("region", { name: "자유 기록", exact: true, includeHidden: true });
  await journal.getByLabel("자유롭게 쓰는 글", { exact: true }).fill("제품 API 없이 저장할 자유 기록");
  await journal.getByRole("button", { name: "글 저장", exact: true, includeHidden: true }).click();
  await expect(journal.locator(".journal-save-status")).toHaveText("글을 저장했습니다.");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations).toEqual([]);
  await primary(page).getByText(/기준 시간대 설정/).click();
  await primary(page).getByLabel("IANA 시간대").fill("America/New_York");
  await primary(page).getByRole("button", { name: "시간대 적용" }).click();
  await expect(primary(page).locator(".date-line")).toContainText("America/New_York");
  await page.getByRole("button", { name: "테스트 나가기" }).click();
  await expect(page.getByRole("link", { name: "로그인 없이 테스트하기" })).toBeVisible();
  await page.getByRole("link", { name: "로그인 없이 테스트하기" }).click();
  await expect(primary(page).locator(".date-line")).toContainText("America/New_York");
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
  await expect(primary(page).getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true })).toHaveCount(0);
  await page.getByRole("link", { name: "홈으로 돌아가기" }).click();
  await expect(page.getByRole("link", { name: "로그인 없이 테스트하기" })).toBeVisible();
});


test("status menus preserve daily rows and the date editor locks other changes", async ({ page }) => {
  test.setTimeout(60_000); // Multiple dated views, reloads or accessibility scans share this scenario budget.
  await page.goto("/demo");
  await expect(primary(page).getByRole("status")).toHaveText("이 탭에 저장된 테스트 목록입니다.", { timeout: 15000 });
  await expect(primary(page).getByRole("combobox", { name: /유형|우선순위/ })).toHaveCount(0);
  await expect(primary(page).locator(".priority-badge")).toHaveCount(0);
  await addDaily(page, "상태 변경 확인");
  const active = dailyRow(page, "상태 변경 확인");
  await expect(active.locator(".bullet-symbol")).toHaveText("□");
  const toggle = active.getByRole("button", { name: "상태 변경 확인 상태 변경", exact: true });
  await toggle.focus();
  await page.keyboard.press("Enter");
  const menu = primary(page).getByRole("group", { name: "상태 변경 확인 상태 선택", exact: true });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("button")).toHaveCount(4);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await setDailyStatus(page, "상태 변경 확인", "미루기");
  await expect(active.locator(".bullet-symbol")).toHaveText("→");
  const currentDay = (await primary(page).locator(".date-line").textContent() ?? "").slice(0, 10);
  const tomorrow = Temporal.PlainDate.from(currentDay).add({ days: 1 }).toString();
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await expect(primary(page).locator(".date-line")).toContainText(tomorrow);
  await openHistory(page);
  const overdue = primary(page).getByRole("region", { name: "이전 날짜의 미완료", exact: true }).locator("[data-task-id]").filter({ hasText: "상태 변경 확인" });
  await expect(overdue.locator(".bullet-symbol")).toHaveText("→");
  await page.getByRole("button", { name: "이전 날", exact: true }).click();
  await setDailyStatus(page, "상태 변경 확인", "취소");
  await expect(active.locator(".bullet-symbol")).toHaveText("×");
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await expect(primary(page).getByRole("status")).toHaveText("이 탭에 저장된 테스트 목록입니다.");
  await openHistory(page);
  await expect(overdue).toHaveCount(0);
  await page.getByRole("button", { name: "이전 날", exact: true }).click();
  await setDailyStatus(page, "상태 변경 확인", "완료");
  await expect(active.locator(".bullet-symbol")).toHaveText("✓");
  await openHistory(page);
  await expect(primary(page).getByRole("region", { name: "오늘 완료", exact: true }).getByText("상태 변경 확인", { exact: true })).toBeVisible();
  await setDailyStatus(page, "상태 변경 확인", "진행 전");
  await expect(active.locator(".bullet-symbol")).toHaveText("□");
  await addDaily(page, "편집 중 보호할 다른 일");
  const other = dailyRow(page, "편집 중 보호할 다른 일");
  await active.getByRole("button", { name: / 수정$/ }).click();
  const editor = primary(page).locator(".edit-panel");
  await editor.getByLabel("실행 예정일", { exact: true }).fill(tomorrow);
  await expect(editor.getByRole("combobox", { name: /유형|우선순위/ })).toHaveCount(0);
  await expect(other.getByRole("textbox")).toBeDisabled();
  await expect(other.getByRole("button", { name: "편집 중 보호할 다른 일 상태 변경", exact: true })).toBeDisabled();
  await expect(other.getByRole("button", { name: "편집 중 보호할 다른 일 순서 이동", exact: true })).toBeDisabled();
  await expect(primary(page).getByRole("textbox", { name: "3번째 할 일", exact: true })).toBeDisabled();
  await expect(primary(page).getByRole("textbox", { name: "자유롭게 쓰는 글", exact: true, includeHidden: true })).toBeDisabled();
  await expect(primary(page).getByLabel("06:00 일정", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "다음 날", exact: true })).toBeDisabled();
  await expect(primary(page).locator("#timezone")).toBeDisabled();
  await expect(editor.getByLabel("실행 예정일", { exact: true })).toHaveValue(tomorrow);
  await editor.getByLabel("실행 예정일", { exact: true }).fill(currentDay);
  await editor.getByRole("button", { name: "변경 저장", exact: true }).click();
  await expect(other.getByRole("textbox")).toBeEnabled();
  await page.reload();
  await expect(active.locator(".bullet-symbol")).toHaveText("□");
  await expect(primary(page).getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true })).toHaveValue("상태 변경 확인");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("an unscheduled organized completion returns to inbox after cancellation or completion undo", async ({ page }) => {
  await page.goto("/demo");
  await addDaily(page, "날짜 없는 기록");
  await page.evaluate(() => {
    const state = JSON.parse(sessionStorage.getItem("web-planner:demo:v1") ?? "null");
    Object.assign(state.tasks[0], { scheduledDate: null, dailyOrder: null, isUnprocessed: true });
    sessionStorage.setItem("web-planner:demo:v1", JSON.stringify(state));
  });
  await page.reload();
  await openHistory(page);
  const inbox = primary(page).getByRole("region", { name: "입력함", exact: true });
  const completed = primary(page).getByRole("region", { name: "오늘 완료", exact: true });
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
  await page.goto("/demo");
  await addDaily(page, "이전에 저장한 기록");
  const today = (await primary(page).locator(".date-line").textContent() ?? "").slice(0, 10);
  // Seed an entry saved by the earlier UI; editing must preserve compatible stored fields.
  await page.evaluate(date => {
    const state = JSON.parse(sessionStorage.getItem("web-planner:demo:v1") ?? "null");
    Object.assign(state.tasks[0], { kind: "appointment", priority: "high", scheduledDate: date, isUnprocessed: false });
    sessionStorage.setItem("web-planner:demo:v1", JSON.stringify(state));
  }, today);
  await page.reload();
  const oldCard = dailyRow(page, "이전에 저장한 기록");
  await expect(oldCard.locator(".bullet-symbol")).toHaveText("□");
  await expect(primary(page).getByRole("combobox", { name: /유형|우선순위/ })).toHaveCount(0);
  await expect(primary(page).locator(".priority-badge")).toHaveCount(0);
  await expect(primary(page).locator(".symbol-legend").filter({ hasText: /약속|행사/ })).toHaveCount(0);
  await oldCard.getByRole("textbox").fill("제목을 고친 이전 기록");
  await oldCard.getByRole("textbox").press("Enter");
  const editedCard = dailyRow(page, "제목을 고친 이전 기록");
  await expect(editedCard).toBeVisible();
  await page.reload();
  await expect(editedCard.locator(".bullet-symbol")).toHaveText("□");
  expect(await page.evaluate(() => {
    const state = JSON.parse(sessionStorage.getItem("web-planner:demo:v1") ?? "null");
    return { kind: state.tasks[0].kind, priority: state.tasks[0].priority, title: state.tasks[0].title };
  })).toEqual({ kind: "appointment", priority: "high", title: "제목을 고친 이전 기록" });
});


test("left-page tasks and right-page journal preserve separate dated entries and unsaved drafts", async ({ page }) => {
  test.setTimeout(60_000); // Multiple dated views, reloads or accessibility scans share this scenario budget.
  await page.goto("/demo");
  await expect(primary(page).getByRole("status")).toHaveText("이 탭에 저장된 테스트 목록입니다.", { timeout: 15000 });
  const left = primary(page).locator(".diary-page-left"), right = primary(page).locator(".diary-page-right");
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
  await expect(primary(page).getByRole("status")).toHaveCount(1);
  const today = (await primary(page).locator(".date-line").textContent() ?? "").slice(0, 10);
  const tomorrow = Temporal.PlainDate.from(today).add({ days: 1 }).toString();
  const firstEntry = "  오늘의 생각  \n\n두 번째 문단에는  여백을 남깁니다.\n";
  const secondEntry = "내일의 메모\n  다른 날짜의 글  ";
  await writing.fill(firstEntry);
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "테스트 나가기", exact: true }).click();
  await expect(writing).toHaveValue(firstEntry);
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await showDiaryPage(page, "자유 기록");
  await expect(primary(page).locator(".date-line")).toContainText(tomorrow);
  await expect(writing).toBeEnabled();
  await expect(writing).toHaveValue("");
  await writing.fill(secondEntry);
  await page.getByRole("button", { name: "이전 날", exact: true }).click();
  await showDiaryPage(page, "자유 기록");
  await expect(primary(page).locator(".date-line")).toContainText(today);
  await expect(writing).toHaveValue(firstEntry);
  await save.click();
  await expect(journal.locator(".journal-save-status")).toHaveText("글을 저장했습니다.");
  await expect(save).toBeDisabled();
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await showDiaryPage(page, "자유 기록");
  await expect(writing).toHaveValue(secondEntry);
  await save.click();
  await expect(journal.locator(".journal-save-status")).toHaveText("글을 저장했습니다.");
  await expect(save).toBeDisabled();
  await page.reload();
  await showDiaryPage(page, "자유 기록");
  await expect(primary(page).locator(".date-line")).toContainText(today);
  await expect(writing).toHaveValue(firstEntry);
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await showDiaryPage(page, "자유 기록");
  await expect(writing).toHaveValue(secondEntry);
  await expect(save).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("five sequential lines keep completed and canceled tasks until one is moved", async ({ page }) => {
  test.setTimeout(60_000); // Multiple dated views, reloads or accessibility scans share this scenario budget.
  await page.goto("/demo");
  await expect(primary(page).getByRole("status")).toHaveText("이 탭에 저장된 테스트 목록입니다.", { timeout: 15000 });
  const day = primary(page).getByRole("region", { name: "오늘의 할 일", exact: true });
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
  const date = (await primary(page).locator(".date-line").textContent() ?? "").slice(0, 10);
  const tomorrow = Temporal.PlainDate.from(date).add({ days: 1 }).toString();
  const moving = dailyRow(page, "하루 할 일 3");
  const id = await moving.getAttribute("data-task-id");
  await moving.getByRole("button", { name: / 수정$/ }).click();
  await primary(page).locator(".edit-panel").getByLabel("실행 예정일", { exact: true }).fill(tomorrow);
  await primary(page).getByRole("button", { name: "변경 저장", exact: true }).click();
  await expect(day.locator(".daily-task-row[data-task-id]")).toHaveCount(4);
  await expect(day.getByRole("textbox", { name: "5번째 할 일", exact: true })).toBeEnabled();
  await addDaily(page, "빈 자리에 추가한 일");
  await expect(day.locator(".daily-task-row[data-task-id]")).toHaveCount(5);
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await expect(dailyRow(page, "하루 할 일 3")).toHaveAttribute("data-task-id", id ?? "");
  await expect(primary(page).locator(".daily-task-row[data-task-id]")).toHaveCount(1);
  await page.reload();
  await expect(day.locator(".daily-task-row[data-task-id]")).toHaveCount(5);
  await expect(dailyRow(page, "하루 할 일 1").locator(".bullet-symbol")).toHaveText("✓");
});

test("the 36 half-hour schedule rows keep first and last slots separate by date", async ({ page }) => {
  test.setTimeout(60_000); // Multiple dated views, reloads or accessibility scans share this scenario budget.
  await page.goto("/demo");
  await expect(primary(page).getByRole("status")).toHaveText("이 탭에 저장된 테스트 목록입니다.", { timeout: 15000 });
  const schedule = primary(page).getByRole("region", { name: "하루 일정", exact: true });
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
  await page.getByRole("button", { name: "테스트 나가기", exact: true }).click();
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

test("inline title saves respect composition and row moves survive status changes and reload", async ({ page }) => {
  test.setTimeout(60_000); // Multiple dated views, reloads or accessibility scans share this scenario budget.
  await page.goto("/demo");
  await expect(primary(page).getByRole("status")).toHaveText("이 탭에 저장된 테스트 목록입니다.", { timeout: 15000 });
  const first = primary(page).getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true });
  await first.dispatchEvent("compositionstart");
  await first.fill("한글 작성");
  await first.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, keyCode: 229 });
  await expect(primary(page).locator(".daily-task-row[data-task-id]")).toHaveCount(0);
  await expect(primary(page).getByRole("textbox", { name: "2번째 할 일", exact: true })).toBeDisabled();
  await first.dispatchEvent("compositionend", { data: "한글 작성" });
  await first.press("Enter");
  await expect(dailyRow(page, "한글 작성")).toBeVisible();
  const second = primary(page).getByRole("textbox", { name: "2번째 할 일", exact: true });
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
  await expect(primary(page).getByRole("textbox", { name: "2번째 할 일", exact: true })).toHaveValue("수정한 두 번째 일");
  await moveTask(page, "한글 작성", "up");
  await expect(primary(page).getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true })).toHaveValue("한글 작성");
  await moveTask(page, "세 번째 일", "down");
  await expect(primary(page).getByRole("textbox", { name: "3번째 할 일", exact: true })).toHaveValue("세 번째 일");
  await moveTask(page, "수정한 두 번째 일", "up");
  await expect(primary(page).getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true })).toHaveValue("수정한 두 번째 일");
  await expect(renamed.getByRole("button", { name: "수정한 두 번째 일 순서 이동", exact: true })).toBeFocused();
  await setDailyStatus(page, "수정한 두 번째 일", "완료");
  await expect(renamed.locator(".bullet-symbol")).toHaveText("✓");
  await expect(renamed.getByRole("button", { name: "수정한 두 번째 일 상태 변경", exact: true })).toBeFocused();
  await page.reload();
  await expect(primary(page).getByRole("textbox", { name: "1번째 할 일", exact: true, includeHidden: true })).toHaveValue("수정한 두 번째 일");
  await expect(primary(page).getByRole("textbox", { name: "2번째 할 일", exact: true })).toHaveValue("한글 작성");
  await expect(renamed).toHaveAttribute("data-task-id", id ?? "");
  await moveTask(page, "수정한 두 번째 일", "down");
  await expect(primary(page).getByRole("textbox", { name: "2번째 할 일", exact: true })).toHaveValue("수정한 두 번째 일");
  await expect(renamed.getByRole("button", { name: "수정한 두 번째 일 순서 이동", exact: true })).toBeFocused();
  await page.reload();
  await expect(primary(page).getByRole("textbox", { name: "2번째 할 일", exact: true })).toHaveValue("수정한 두 번째 일");
  await expect(renamed.locator(".bullet-symbol")).toHaveText("✓");
  await expect(primary(page).getByRole("combobox", { name: /우선순위/ })).toHaveCount(0);
  await expect(primary(page).locator(".priority-badge")).toHaveCount(0);
});

test("pointer dragging moves a task to a distant row and Escape cancels keyboard movement", async ({ page, isMobile }) => {
  test.setTimeout(60_000); // Multiple dated views, reloads or accessibility scans share this scenario budget.
  await page.goto("/demo");
  await expect(primary(page).getByRole("status")).toHaveText("이 탭에 저장된 테스트 목록입니다.", { timeout: 15000 });
  for (const title of ["첫 번째 계획", "두 번째 계획", "세 번째 계획"]) await addDaily(page, title);
  const moved = dailyRow(page, "세 번째 계획");
  const sourceId = await moved.getAttribute("data-task-id");
  const targetId = await dailyRow(page, "첫 번째 계획").getAttribute("data-task-id");
  const handle = moved.getByRole("button", { name: "세 번째 계획 순서 이동", exact: true });
  await handle.focus(); await handle.press("Space"); await handle.press("Home");
  await expect(primary(page).getByRole("textbox", { name: "1번째 할 일", exact: true })).toHaveValue("첫 번째 계획");
  await handle.press("Escape");
  await expect(handle).toBeFocused();
  await expect(primary(page).getByRole("textbox", { name: "3번째 할 일", exact: true })).toHaveValue("세 번째 계획");
  expect(targetId).toBeTruthy();
  await dragTask(page, "세 번째 계획", "첫 번째 계획", isMobile);

  await expect(primary(page).getByRole("textbox", { name: "1번째 할 일", exact: true })).toHaveValue("세 번째 계획");
  await expect(primary(page).getByRole("textbox", { name: "2번째 할 일", exact: true })).toHaveValue("첫 번째 계획");
  await expect(primary(page).getByRole("textbox", { name: "3번째 할 일", exact: true })).toHaveValue("두 번째 계획");
  await expect(moved).toHaveAttribute("data-task-id", sourceId ?? "");
  await expect(handle).toBeFocused();
  await expectViewport(page);
  await page.reload();
  await expect(primary(page).getByRole("textbox", { name: "1번째 할 일", exact: true })).toHaveValue("세 번째 계획");
  await expect(primary(page).getByRole("textbox", { name: "3번째 할 일", exact: true })).toHaveValue("두 번째 계획");
});

test("the visible date picker synchronizes tasks, schedule and journal within compact viewports", async ({ page, isMobile }, testInfo) => {
  test.setTimeout(60_000); // Multiple dated views, reloads or accessibility scans share this scenario budget.
  await page.goto("/demo");
  await expect(primary(page).getByRole("status")).toHaveText("이 탭에 저장된 테스트 목록입니다.", { timeout: 15000 });
  const today = (await primary(page).locator(".date-line").textContent() ?? "").slice(0, 10);
  const tomorrow = Temporal.PlainDate.from(today).add({ days: 1 }).toString();
  await addDaily(page, "오늘 날짜의 계획");
  await addDaily(page, "자료 정리하기");
  await addDaily(page, "산책하며 하루 돌아보기");
  await showScheduleSlot(page, "06:00");
  await primary(page).getByLabel("06:00 일정", { exact: true }).fill("오늘 날짜의 일정");
  await primary(page).getByRole("button", { name: "일정 저장", exact: true }).click();
  await expect(primary(page).locator(".schedule-save-status")).toHaveText("일정을 저장했습니다.");
  await showDiaryPage(page, "자유 기록");
  await primary(page).getByLabel("자유롭게 쓰는 글", { exact: true }).fill("오늘 날짜의 자유 기록");
  await primary(page).getByRole("button", { name: "글 저장", exact: true }).click();
  await expect(primary(page).locator(".journal-save-status")).toHaveText("글을 저장했습니다.");
  await pickDate(page, tomorrow);
  await showDiaryPage(page, "할 일·일정");
  await expect(primary(page).locator(".daily-task-row[data-task-id]")).toHaveCount(0);
  await expect(primary(page).getByLabel("06:00 일정", { exact: true })).toHaveValue("");
  await showDiaryPage(page, "자유 기록");
  await expect(primary(page).getByLabel("자유롭게 쓰는 글", { exact: true })).toHaveValue("");
  await pickDate(page, today);
  await showDiaryPage(page, "할 일·일정");
  await expect(dailyRow(page, "오늘 날짜의 계획")).toBeVisible();
  await expect(primary(page).getByLabel("06:00 일정", { exact: true })).toHaveValue("오늘 날짜의 일정");
  await showDiaryPage(page, "자유 기록");
  await expect(primary(page).getByLabel("자유롭게 쓰는 글", { exact: true })).toHaveValue("오늘 날짜의 자유 기록");
  const references = await page.evaluate(() => {
    const ids = Array.from(document.querySelectorAll("[id]"), element => element.id);
    const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
    const missingTargets = Array.from(document.querySelectorAll("label[for], [aria-describedby]"))
      .flatMap(element => (element.getAttribute("for") ?? element.getAttribute("aria-describedby") ?? "").split(/\s+/))
      .filter(id => id && !document.getElementById(id));
    return { duplicateIds, missingTargets };
  });
  expect(references).toEqual({ duplicateIds: [], missingTargets: [] });
  const viewports = isMobile
    ? [{ width: 1024, height: 768, days: 2, name: "tablet-landscape" }, { width: 768, height: 1024, days: 1, name: "tablet-portrait" }, { width: 390, height: 844, days: 1, name: "phone-portrait" }, { width: 844, height: 390, days: 1, name: "phone-landscape" }]
    : [{ width: 1366, height: 768, days: 2, name: "pc-wide" }, { width: 707, height: 978, days: 2, name: "pc-narrow" }];
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expect(page.locator("[data-visible-days]")).toHaveAttribute("data-visible-days", String(viewport.days));
    await expect(primary(page)).toBeVisible();
    if (viewport.days === 2) await expect(secondary(page)).toBeVisible();
    else await expect(secondary(page)).toBeHidden();
    await showDiaryPage(page, "할 일·일정");
    await expectViewport(page);
    for (let row = 1; row <= 5; row++) await expect(primary(page).getByRole("textbox", { name: `${row}번째 할 일`, exact: true })).toBeInViewport({ ratio: 1 });
    await expect(primary(page).getByRole("button", { name: "일정 저장", exact: true })).toBeInViewport({ ratio: 1 });
    await showScheduleSlot(page, "23:30");
    await expectScheduleSlotInViewport(primary(page).getByLabel("23:30 일정", { exact: true }), viewport);
    await expectViewport(page);
    await showDiaryPage(page, "자유 기록");
    await expect(primary(page).getByLabel("자유롭게 쓰는 글", { exact: true })).toBeInViewport({ ratio: 1 });
    await expect(primary(page).getByRole("button", { name: "글 저장", exact: true })).toBeInViewport({ ratio: 1 });
    await expectViewport(page);
    const trigger = page.getByRole("button", { name: "날짜 선택", exact: true });
    await expect(trigger).toBeInViewport({ ratio: 1 });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "날짜 선택", exact: true });
    await expect(dialog).toBeInViewport({ ratio: 1 });
    await expectViewport(page);
    await page.screenshot({ path: testInfo.outputPath(`diary-${viewport.name}-calendar.png`), fullPage: false });
    await dialog.getByRole("button", { name: "달력 닫기", exact: true }).click();
    await expect(trigger).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`diary-${viewport.name}.png`), fullPage: false });
  }
});


test("adjacent dates isolate all three records and preserve both drafts when rotating", async ({ page, isMobile }) => {
  test.setTimeout(60_000); // Multiple dated views, reloads or accessibility scans share this scenario budget.
  await page.setViewportSize(isMobile ? { width: 1024, height: 768 } : { width: 1366, height: 768 });
  await page.goto("/demo");
  await expect(page.locator("[data-visible-days]")).toHaveAttribute("data-visible-days", "2");
  const first = primary(page), second = secondary(page);
  await expect(first.getByRole("status")).toHaveText("이 탭에 저장된 테스트 목록입니다.", { timeout: 15000 });
  await expect(second.getByRole("status")).toHaveText("이 탭에 저장된 테스트 목록입니다.", { timeout: 15000 });
  const firstDate = await first.getAttribute("data-date"), secondDate = await second.getAttribute("data-date");
  expect(secondDate).toBe(Temporal.PlainDate.from(firstDate ?? "").add({ days: 1 }).toString());
  await addDaily(page, "첫 날짜의 할 일", first);
  await addDaily(page, "둘째 날짜의 할 일", second);
  const firstId = await dailyRow(page, "첫 날짜의 할 일", first).getAttribute("data-task-id");
  const secondId = await dailyRow(page, "둘째 날짜의 할 일", second).getAttribute("data-task-id");
  expect(firstId).not.toBe(secondId);
  await expect(dailyRow(page, "둘째 날짜의 할 일", first)).toHaveCount(0);
  await expect(dailyRow(page, "첫 날짜의 할 일", second)).toHaveCount(0);
  await addDaily(page, "옆 날짜로 옮길 일", first);
  const movingId = await dailyRow(page, "옆 날짜로 옮길 일", first).getAttribute("data-task-id");
  await showDiaryPage(page, "자유 기록", second);
  await second.getByLabel("자유롭게 쓰는 글", { exact: true }).fill("둘째 날짜의 미저장 글");
  await showDiaryPage(page, "할 일·일정", second);
  await dailyRow(page, "옆 날짜로 옮길 일", first).getByRole("button", { name: "옆 날짜로 옮길 일 수정", exact: true }).click();
  await first.locator(".edit-panel").getByLabel("실행 예정일", { exact: true }).fill(secondDate ?? "");
  await first.getByRole("button", { name: "변경 저장", exact: true }).click();
  // Both dates were already loaded: the target must update without navigation or manual refresh.
  await expect(dailyRow(page, "옆 날짜로 옮길 일", first)).toHaveCount(0);
  await expect(dailyRow(page, "옆 날짜로 옮길 일", second)).toHaveAttribute("data-task-id", movingId ?? "");
  await expect(dailyRow(page, "옆 날짜로 옮길 일", second)).toBeVisible();
  await expect(second.getByLabel("자유롭게 쓰는 글", { exact: true })).toHaveValue("둘째 날짜의 미저장 글");
  for (const [scope, content] of [[first, "첫 날짜의 일정"], [second, "둘째 날짜의 일정"]] as const) {
    await showScheduleSlot(page, "06:00", scope);
    await scope.getByLabel("06:00 일정", { exact: true }).fill(content);
    await scope.getByRole("button", { name: "일정 저장", exact: true }).click();
    await expect(scope.locator(".schedule-save-status")).toHaveText("일정을 저장했습니다.");
  }
  await showScheduleSlot(page, "20:00", second);
  await expect(second.getByRole("combobox", { name: "일정 시간대", exact: true })).toHaveValue("7");
  await showDiaryPage(page, "자유 기록", first);
  await first.getByLabel("자유롭게 쓰는 글", { exact: true }).fill("첫 날짜의 미저장 글");
  await showDiaryPage(page, "자유 기록", second);
  await second.getByLabel("자유롭게 쓰는 글", { exact: true }).fill("둘째 날짜의 미저장 글");
  await page.setViewportSize(isMobile ? { width: 768, height: 1024 } : { width: 390, height: 844 });
  await expect(page.locator("[data-visible-days]")).toHaveAttribute("data-visible-days", "1");
  await expect(page.locator("[data-single-panel]")).toHaveAttribute("data-single-panel", "secondary");
  await expect(second).toBeVisible();
  await expect(first).toBeHidden();
  await expect(second.getByLabel("자유롭게 쓰는 글", { exact: true })).toHaveValue("둘째 날짜의 미저장 글");
  await page.getByRole("button", { name: "다른 날짜 보기", exact: true }).click();
  await expect(first).toBeVisible();
  await expect(second).toBeHidden();
  await showDiaryPage(page, "자유 기록", first);
  await expect(first.getByLabel("자유롭게 쓰는 글", { exact: true })).toHaveValue("첫 날짜의 미저장 글");
  await page.setViewportSize(isMobile ? { width: 1024, height: 768 } : { width: 1366, height: 768 });
  await expect(page.locator("[data-visible-days]")).toHaveAttribute("data-visible-days", "2");
  await showDiaryPage(page, "할 일·일정", second);
  await expect(second.getByRole("combobox", { name: "일정 시간대", exact: true })).toHaveValue("7");
  await expect(second.getByRole("textbox", { name: "20:00 일정", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await expect(primary(page)).toHaveAttribute("data-date", secondDate ?? "");
  await expect(primary(page).getByRole("combobox", { name: "일정 시간대", exact: true, includeHidden: true })).toHaveValue("7");
  await showDiaryPage(page, "자유 기록");
  await expect(primary(page).getByLabel("자유롭게 쓰는 글", { exact: true })).toHaveValue("둘째 날짜의 미저장 글");
  await page.getByRole("button", { name: "이전 날", exact: true }).click();
  await expect(primary(page)).toHaveAttribute("data-date", firstDate ?? "");
  for (const [scope, content] of [[first, "첫 날짜의 미저장 글"], [second, "둘째 날짜의 미저장 글"]] as const) {
    await showDiaryPage(page, "자유 기록", scope);
    await expect(scope.getByLabel("자유롭게 쓰는 글", { exact: true })).toHaveValue(content);
    await scope.getByRole("button", { name: "글 저장", exact: true }).click();
    await expect(scope.locator(".journal-save-status")).toHaveText("글을 저장했습니다.");
  }
  await page.reload();
  for (const [scope, task, schedule, journal] of [[first, "첫 날짜의 할 일", "첫 날짜의 일정", "첫 날짜의 미저장 글"], [second, "둘째 날짜의 할 일", "둘째 날짜의 일정", "둘째 날짜의 미저장 글"]] as const) {
    await showDiaryPage(page, "할 일·일정", scope);
    await expect(dailyRow(page, task, scope)).toBeVisible();
    await showScheduleSlot(page, "06:00", scope);
    await expect(scope.getByLabel("06:00 일정", { exact: true })).toHaveValue(schedule);
    await showDiaryPage(page, "자유 기록", scope);
    await expect(scope.getByLabel("자유롭게 쓰는 글", { exact: true })).toHaveValue(journal);
  }
  await showDiaryPage(page, "할 일·일정", second);
  await expect(dailyRow(page, "옆 날짜로 옮길 일", second)).toHaveAttribute("data-task-id", movingId ?? "");
  await expectViewport(page);
});
