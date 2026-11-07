import { type Page, expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { Temporal } from "@js-temporal/polyfill";


function dailyRow(page: Page, title: string) {
  return page.locator(".daily-task-row[data-task-id]").filter({ has: page.getByRole("button", { name: `${title} 상태 변경`, exact: true }) });
}
async function addDaily(page: Page, title: string) {
  const index = await page.locator(".daily-task-row[data-task-id]").count() + 1;
  const input = page.getByRole("textbox", { name: `${index}번째 할 일`, exact: true });
  await input.fill(title);
  await input.press("Enter");
  await expect(dailyRow(page, title)).toBeVisible();
}
async function setDailyStatus(page: Page, title: string, state: "완료" | "미루기" | "진행 전" | "취소") {
  await dailyRow(page, title).getByRole("button", { name: `${title} 상태 변경`, exact: true }).click();
  await page.getByRole("group", { name: `${title} 상태 선택`, exact: true }).getByRole("button", { name: state, exact: true }).click();
}

async function openHistory(page: Page) {
  const history = page.locator("details").filter({ has: page.getByText("이전 기록과 입력함", { exact: true }) });
  if (await history.getAttribute("open") === null) await history.locator("summary").click();
}


test("diary pages create directly on the selected day and retain the actual completion date", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.getByRole("status")).toHaveText("이 탭에 저장된 테스트 목록입니다.");
  const today = (await page.locator(".date-line").textContent() ?? "").slice(0, 10);
  const tomorrow = Temporal.PlainDate.from(today).add({ days: 1 });
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await expect(page.locator(".date-line")).toContainText(tomorrow.toString());
  await addDaily(page, "다음 페이지의 할 일");
  await expect(dailyRow(page, "다음 페이지의 할 일")).toBeVisible();
  await page.getByRole("button", { name: "이전 날", exact: true }).click();
  await expect(dailyRow(page, "다음 페이지의 할 일")).toHaveCount(0);
  const calendarToggle = page.getByRole("button", { name: "달력 보기", exact: true });
  if (await calendarToggle.isVisible()) await calendarToggle.click();
  await page.getByRole("button", { name: "다음 달", exact: true }).click();
  await expect(page.locator(".date-line")).toContainText(today);
  await page.getByRole("button", { name: "이전 달", exact: true }).click();
  if (tomorrow.month !== Temporal.PlainDate.from(today).month) await page.getByRole("button", { name: "다음 달", exact: true }).click();
  await page.getByRole("button", { name: `${tomorrow.day}, ${tomorrow.year}년 ${tomorrow.month}월 ${tomorrow.day}일`, exact: true }).click();
  await setDailyStatus(page, "다음 페이지의 할 일", "완료");
  await expect(dailyRow(page, "다음 페이지의 할 일").locator(".bullet-symbol")).toHaveText("✓");
  await expect(page.getByRole("status")).toContainText(`${today}의 완료 기록`);
  await page.getByRole("button", { name: "이전 날", exact: true }).click();
  await openHistory(page);
  await expect(page.getByRole("region", { name: "오늘 완료", exact: true }).getByText("다음 페이지의 할 일", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("paused login offers a working demo with tab persistence and no product API traffic", async ({ page, context, request }) => {
  const apiRequests: string[] = [];
  page.on("request", req => { if (new URL(req.url()).pathname.startsWith("/api/")) apiRequests.push(req.url()); });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Google로 시작하기" })).toBeDisabled();
  await page.getByRole("link", { name: "로그인 없이 테스트하기" }).click();
  await expect(page.getByRole("status")).toHaveText("이 탭에 저장된 테스트 목록입니다.");
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
  const schedule = page.getByRole("region", { name: "하루 일정", exact: true });
  await schedule.getByLabel("06:00 일정", { exact: true }).fill("제품 API 없이 저장할 일정");
  await schedule.getByRole("button", { name: "일정 저장", exact: true }).click();
  await expect(schedule.locator(".schedule-save-status")).toHaveText("일정을 저장했습니다.");
  const journal = page.getByRole("region", { name: "자유 기록", exact: true });
  await journal.getByLabel("자유롭게 쓰는 글", { exact: true }).fill("제품 API 없이 저장할 자유 기록");
  await journal.getByRole("button", { name: "글 저장", exact: true }).click();
  await expect(journal.locator(".journal-save-status")).toHaveText("글을 저장했습니다.");
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
  await expect(page.getByRole("textbox", { name: "1번째 할 일", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "홈으로 돌아가기" }).click();
  await expect(page.getByRole("link", { name: "로그인 없이 테스트하기" })).toBeVisible();
});


test("status menus preserve daily rows and the date editor locks other changes", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.getByRole("status")).toHaveText("이 탭에 저장된 테스트 목록입니다.", { timeout: 15000 });
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
  await expect(page.getByRole("status")).toHaveText("이 탭에 저장된 테스트 목록입니다.");
  await expect(overdue).toHaveCount(0);
  await page.getByRole("button", { name: "이전 날", exact: true }).click();
  await setDailyStatus(page, "상태 변경 확인", "완료");
  await expect(active.locator(".bullet-symbol")).toHaveText("✓");
  await expect(page.getByRole("region", { name: "오늘 완료", exact: true }).getByText("상태 변경 확인", { exact: true })).toBeVisible();
  await setDailyStatus(page, "상태 변경 확인", "진행 전");
  await expect(active.locator(".bullet-symbol")).toHaveText("□");
  await addDaily(page, "편집 중 보호할 다른 일");
  const other = dailyRow(page, "편집 중 보호할 다른 일");
  await active.getByRole("button", { name: "수정", exact: true }).click();
  const editor = page.locator(".edit-panel");
  await editor.getByLabel("실행 예정일", { exact: true }).fill(tomorrow);
  await expect(editor.getByRole("combobox", { name: /유형|우선순위/ })).toHaveCount(0);
  await expect(other.getByRole("textbox")).toBeDisabled();
  await expect(other.getByRole("button", { name: "편집 중 보호할 다른 일 상태 변경", exact: true })).toBeDisabled();
  await expect(other.getByRole("button", { name: "편집 중 보호할 다른 일 위로 이동", exact: true })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "3번째 할 일", exact: true })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "자유롭게 쓰는 글", exact: true })).toBeDisabled();
  await expect(page.getByLabel("06:00 일정", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "다음 날", exact: true })).toBeDisabled();
  await page.getByText(/기준 시간대 설정/).click();
  await expect(page.getByLabel("IANA 시간대")).toBeDisabled();
  await expect(editor.getByLabel("실행 예정일", { exact: true })).toHaveValue(tomorrow);
  await editor.getByLabel("실행 예정일", { exact: true }).fill(currentDay);
  await editor.getByRole("button", { name: "변경 저장", exact: true }).click();
  await expect(other.getByRole("textbox")).toBeEnabled();
  await page.reload();
  await expect(active.locator(".bullet-symbol")).toHaveText("□");
  await expect(page.getByRole("textbox", { name: "1번째 할 일", exact: true })).toHaveValue("상태 변경 확인");
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
  await page.goto("/demo");
  await addDaily(page, "이전에 저장한 기록");
  const today = (await page.locator(".date-line").textContent() ?? "").slice(0, 10);
  // Seed an entry saved by the earlier UI; editing must preserve compatible stored fields.
  await page.evaluate(date => {
    const state = JSON.parse(sessionStorage.getItem("web-planner:demo:v1") ?? "null");
    Object.assign(state.tasks[0], { kind: "appointment", priority: "high", scheduledDate: date, isUnprocessed: false });
    sessionStorage.setItem("web-planner:demo:v1", JSON.stringify(state));
  }, today);
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
  expect(await page.evaluate(() => {
    const state = JSON.parse(sessionStorage.getItem("web-planner:demo:v1") ?? "null");
    return { kind: state.tasks[0].kind, priority: state.tasks[0].priority, title: state.tasks[0].title };
  })).toEqual({ kind: "appointment", priority: "high", title: "제목을 고친 이전 기록" });
});


test("left-page tasks and right-page journal preserve separate dated entries and unsaved drafts", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.getByRole("status")).toHaveText("이 탭에 저장된 테스트 목록입니다.", { timeout: 15000 });
  const left = page.locator(".diary-page-left"), right = page.locator(".diary-page-right");
  await expect(left.getByRole("textbox", { name: "1번째 할 일", exact: true })).toBeVisible();
  await expect(left.getByRole("region", { name: "오늘의 할 일", exact: true })).toBeVisible();
  await expect(left.getByRole("region", { name: "하루 일정", exact: true })).toBeVisible();
  for (const name of ["오늘 완료", "입력함", "이전 날짜의 미완료"]) {
    await expect(left.getByRole("region", { name, exact: true, includeHidden: true })).toBeHidden();
    await expect(right.getByRole("region", { name, exact: true, includeHidden: true })).toHaveCount(0);
  }
  await openHistory(page);
  for (const name of ["오늘 완료", "입력함", "이전 날짜의 미완료"]) await expect(left.getByRole("region", { name, exact: true })).toBeVisible();
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
  await page.getByRole("button", { name: "테스트 나가기", exact: true }).click();
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

test("five sequential lines keep completed and canceled tasks until one is moved", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.getByRole("status")).toHaveText("이 탭에 저장된 테스트 목록입니다.", { timeout: 15000 });
  const day = page.getByRole("region", { name: "오늘의 할 일", exact: true });
  await expect(day.locator(".daily-task-row")).toHaveCount(5);
  await expect(day.getByRole("textbox", { name: "1번째 할 일", exact: true })).toBeEnabled();
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
  await moving.getByRole("button", { name: "수정", exact: true }).click();
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
  await page.goto("/demo");
  await expect(page.getByRole("status")).toHaveText("이 탭에 저장된 테스트 목록입니다.", { timeout: 15000 });
  const schedule = page.getByRole("region", { name: "하루 일정", exact: true });
  const first = schedule.getByRole("textbox", { name: "06:00 일정", exact: true });
  const last = schedule.getByRole("textbox", { name: "23:30 일정", exact: true });
  const save = schedule.getByRole("button", { name: "일정 저장", exact: true });
  await expect(schedule.getByRole("textbox")).toHaveCount(36);
  for (let minute = 360; minute < 1440; minute += 30) {
    const label = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")} 일정`;
    await expect(schedule.getByRole("textbox", { name: label, exact: true })).toHaveCount(1);
  }
  await expect(schedule).toContainText(/06:00\s*[–-]\s*06:30/);
  await expect(schedule).toContainText(/23:30\s*[–-]\s*24:00/);
  await expect(first).toBeEnabled();
  await expect(save).toBeDisabled();
  await first.fill("아침 계획");
  await last.fill("하루 마무리");
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "테스트 나가기", exact: true }).click();
  await expect(first).toHaveValue("아침 계획");
  await expect(last).toHaveValue("하루 마무리");
  await save.click();
  await expect(schedule.locator(".schedule-save-status")).toHaveText("일정을 저장했습니다.");
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await expect(first).toBeEnabled();
  await expect(first).toHaveValue("");
  await expect(last).toHaveValue("");
  await first.fill("다음 날짜 아침");
  await page.getByRole("button", { name: "이전 날", exact: true }).click();
  await expect(first).toHaveValue("아침 계획");
  await expect(last).toHaveValue("하루 마무리");
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await expect(first).toHaveValue("다음 날짜 아침");
  await save.click();
  await expect(schedule.locator(".schedule-save-status")).toHaveText("일정을 저장했습니다.");
  await page.reload();
  await expect(first).toHaveValue("아침 계획");
  await expect(last).toHaveValue("하루 마무리");
  await page.getByRole("button", { name: "다음 날", exact: true }).click();
  await expect(first).toHaveValue("다음 날짜 아침");
  await expect(last).toHaveValue("");
  await expect(save).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("inline title saves respect composition and row moves survive status changes and reload", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.getByRole("status")).toHaveText("이 탭에 저장된 테스트 목록입니다.", { timeout: 15000 });
  const first = page.getByRole("textbox", { name: "1번째 할 일", exact: true });
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
  await expect(dailyRow(page, "한글 작성").getByRole("button", { name: "한글 작성 위로 이동", exact: true })).toBeDisabled();
  await expect(dailyRow(page, "세 번째 일").getByRole("button", { name: "세 번째 일 아래로 이동", exact: true })).toBeDisabled();
  await renamed.getByRole("button", { name: "수정한 두 번째 일 위로 이동", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "1번째 할 일", exact: true })).toHaveValue("수정한 두 번째 일");
  await expect(renamed.getByRole("textbox")).toBeFocused();
  await setDailyStatus(page, "수정한 두 번째 일", "완료");
  await expect(renamed.locator(".bullet-symbol")).toHaveText("✓");
  await expect(renamed.getByRole("button", { name: "수정한 두 번째 일 상태 변경", exact: true })).toBeFocused();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "1번째 할 일", exact: true })).toHaveValue("수정한 두 번째 일");
  await expect(page.getByRole("textbox", { name: "2번째 할 일", exact: true })).toHaveValue("한글 작성");
  await expect(renamed).toHaveAttribute("data-task-id", id ?? "");
  await renamed.getByRole("button", { name: "수정한 두 번째 일 아래로 이동", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "2번째 할 일", exact: true })).toHaveValue("수정한 두 번째 일");
  await expect(renamed.getByRole("button", { name: "수정한 두 번째 일 아래로 이동", exact: true })).toBeFocused();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "2번째 할 일", exact: true })).toHaveValue("수정한 두 번째 일");
  await expect(renamed.locator(".bullet-symbol")).toHaveText("✓");
  await expect(page.getByRole("combobox", { name: /우선순위/ })).toHaveCount(0);
  await expect(page.locator(".priority-badge")).toHaveCount(0);
});
