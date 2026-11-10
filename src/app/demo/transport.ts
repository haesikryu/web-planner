import { type JournalEntry, journalContent } from "../../domain/journal";
import { calendarDate, dayRange, InputError, object, title, timezone, today, uuidPattern } from "../../domain/rules";
import { normalizeScheduleSlots, type ScheduleEntry, type ScheduleSlot } from "../../domain/schedule";
import { type TaskKind, type TaskPriority, type TaskStatus, taskKind, taskPriority, taskStatus } from "../../domain/task-options";
import { DAILY_TASK_LIMIT, type TaskMove, taskMove } from "../../domain/task-order";
import { taskActivity, taskPlanSnapshot, type TaskActivity, type TaskActivityType } from "../../domain/task-history";
import type { PlannerSession } from "../planner";

const STORAGE_KEY = "web-planner:demo:v1";
const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
type DemoTask = {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  kind: TaskKind;
  scheduledDate: string | null;
  dueDate: string | null;
  dailyOrder: number | null;
  isUnprocessed: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};
type JournalRequest = { key: string; date: string; content: string; version: number; expiresAt: string; response: JournalEntry };
type ScheduleRequest = { key: string; date: string; slots: ScheduleSlot[]; version: number; expiresAt: string; response: ScheduleEntry };
type TaskInput = Partial<Pick<DemoTask, "title" | "scheduledDate" | "dueDate" | "status" | "priority" | "kind" | "isUnprocessed">> & { move?: TaskMove; moveTo?: string };
type TaskRequest = { key: string; method: "POST" | "PATCH"; path: string; input: TaskInput; version: number | null; expiresAt: string; response: DemoTask };
type DemoState = { schemaVersion: 6; timezone: string; settingsVersion: number; tasks: DemoTask[]; activities: TaskActivity[]; journals: JournalEntry[]; journalRequests: JournalRequest[];
  schedules: ScheduleEntry[]; scheduleRequests: ScheduleRequest[]; taskRequests: TaskRequest[] };
type DemoStorage = Pick<Storage, "getItem" | "setItem">;

class DemoRequestError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validJournal(entry: JournalEntry, allowEmpty = false): boolean {
  return calendarDate(entry.date) === entry.date && journalContent(entry.content) === entry.content &&
    (allowEmpty && entry.version === 0 ? entry.content === "" && entry.updatedAt === null : positiveInteger(entry.version) && timestamp(entry.updatedAt));
}

function sameSlots(left: ScheduleSlot[], right: ScheduleSlot[]): boolean {
  return left.length === right.length && left.every((slot, index) => slot.startMinute === right[index].startMinute && slot.title === right[index].title);
}

function validSchedule(entry: ScheduleEntry, allowEmpty = false): boolean {
  return calendarDate(entry.date) === entry.date && sameSlots(normalizeScheduleSlots(entry.slots), entry.slots) &&
    (allowEmpty && entry.version === 0 ? entry.slots.length === 0 && entry.updatedAt === null : positiveInteger(entry.version) && timestamp(entry.updatedAt));
}

function validTask(task: DemoTask): boolean {
  return uuidPattern.test(task.id) && title(task.title) === task.title && positiveInteger(task.version) &&
    taskPriority(task.priority) === task.priority && taskKind(task.kind) === task.kind && taskStatus(task.status) === task.status &&
    typeof task.isUnprocessed === "boolean" && timestamp(task.createdAt) && timestamp(task.updatedAt) &&
    (task.scheduledDate === null || calendarDate(task.scheduledDate) === task.scheduledDate) &&
    (task.dueDate === null || calendarDate(task.dueDate) === task.dueDate) &&
    (task.status === "completed" ? timestamp(task.completedAt) : task.completedAt === null);
}

function validDailyOrder(task: DemoTask, historical = false): boolean {
  return task.scheduledDate === null ? task.dailyOrder === null : (positiveInteger(task.dailyOrder) && task.dailyOrder <= 2147483647) || (historical && task.dailyOrder === null);
}

function creationOrder(left: DemoTask, right: DemoTask): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function dayOrder(left: DemoTask, right: DemoTask): number {
  return (left.dailyOrder ?? 0) - (right.dailyOrder ?? 0) || creationOrder(left, right);
}

function taskFields(create: boolean) {
  return create ? ["title", "scheduledDate", "dueDate", "isUnprocessed", "priority", "kind"] : ["title", "scheduledDate", "dueDate", "status", "isUnprocessed", "priority", "kind", "move", "moveTo"];
}

function normalizedTaskInput(raw: unknown, create: boolean): TaskInput {
  const input = object(raw, taskFields(create));
  if ((!create && !Object.keys(input).length) || (create && !("title" in input))) throw new InputError("body");
  if ("move" in input) {
    if (Object.keys(input).length !== 1) throw new InputError("move");
    return { move: taskMove(input.move) };
  }
  if ("moveTo" in input) {
    if (Object.keys(input).length !== 1 || typeof input.moveTo !== "string" || !uuidPattern.test(input.moveTo)) throw new InputError("moveTo");
    return { moveTo: input.moveTo.toLowerCase() };
  }
  const result: TaskInput = {};
  if ("title" in input) result.title = title(input.title);
  if ("scheduledDate" in input) result.scheduledDate = input.scheduledDate === null ? null : calendarDate(input.scheduledDate);
  if ("dueDate" in input) result.dueDate = input.dueDate === null ? null : calendarDate(input.dueDate);
  if ("status" in input) result.status = taskStatus(input.status);
  if ("priority" in input) result.priority = taskPriority(input.priority);
  if ("kind" in input) result.kind = taskKind(input.kind);
  if ("isUnprocessed" in input) {
    if (typeof input.isUnprocessed !== "boolean") throw new InputError("isUnprocessed");
    result.isUnprocessed = input.isUnprocessed;
  }
  if (create && !("scheduledDate" in result)) result.scheduledDate = null;
  if (create && result.isUnprocessed === false && !result.scheduledDate) throw new InputError("scheduledDate");
  return result;
}

function sameTaskInput(left: TaskInput, right: TaskInput): boolean {
  return Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([field, value]) => right[field as keyof TaskInput] === value);
}

function readState(storage: DemoStorage): DemoState {
  const stored = storage.getItem(STORAGE_KEY);
  if (stored === null) return { schemaVersion: 6, timezone: "Asia/Seoul", settingsVersion: 1, tasks: [], activities: [], journals: [], journalRequests: [], schedules: [], scheduleRequests: [], taskRequests: [] };
  try {
    const state = JSON.parse(stored) as Omit<DemoState, "schemaVersion"> & { schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 };
    if (![1, 2, 3, 4, 5, 6].includes(state.schemaVersion) || !positiveInteger(state.settingsVersion) || timezone(state.timezone) !== state.timezone || !Array.isArray(state.tasks)) throw new Error();
    const ids = new Set<string>();
    for (const task of state.tasks) {
      // Adapt old entries in memory; persist only with the next successful mutation.
      task.priority = state.schemaVersion === 1 && !("priority" in task) ? "medium" : taskPriority(task.priority);
      task.kind = state.schemaVersion === 1 && !("kind" in task) ? "task" : taskKind(task.kind);
      task.status = taskStatus(task.status);
      if (state.schemaVersion < 6 && !Object.hasOwn(task, "dueDate")) task.dueDate = null;
      if (!validTask(task) || ids.has(task.id)) throw new Error();
      ids.add(task.id);
    }
    if (state.schemaVersion < 5) {
      const nextOrder = new Map<string, number>();
      for (const task of [...state.tasks].sort(creationOrder)) {
        if (task.scheduledDate === null) task.dailyOrder = null;
        else {
          task.dailyOrder = (nextOrder.get(task.scheduledDate) ?? 0) + 1;
          nextOrder.set(task.scheduledDate, task.dailyOrder);
        }
      }
    }
    const dailyPositions = new Set<string>();
    for (const task of state.tasks) {
      const position = `${task.scheduledDate}:${task.dailyOrder}`;
      if (!validDailyOrder(task) || (task.scheduledDate !== null && dailyPositions.has(position))) throw new Error();
      if (task.scheduledDate !== null) dailyPositions.add(position);
    }
    if (state.schemaVersion < 3) {
      state.journals = [];
      state.journalRequests = [];
    }
    if (!Array.isArray(state.journals) || !Array.isArray(state.journalRequests)) throw new Error();
    const dates = new Set<string>();
    for (const entry of state.journals) {
      if (!validJournal(entry) || dates.has(entry.date)) throw new Error();
      dates.add(entry.date);
    }
    const requestKeys = new Set<string>();
    for (const saved of state.journalRequests) {
      const scope = `${saved.date}:${saved.key}`;
      if (!uuidPattern.test(saved.key) || saved.key !== saved.key.toLowerCase() || requestKeys.has(scope) ||
          calendarDate(saved.date) !== saved.date || journalContent(saved.content) !== saved.content ||
          !Number.isSafeInteger(saved.version) || saved.version < 0 || !timestamp(saved.expiresAt) ||
          !validJournal(saved.response, true) || saved.response.date !== saved.date || saved.response.content !== saved.content ||
          saved.response.version < saved.version || saved.response.version > saved.version + 1) throw new Error();
      requestKeys.add(scope);
    }
    if (state.schemaVersion < 4) {
      state.schedules = [];
      state.scheduleRequests = [];
    }
    if (!Array.isArray(state.schedules) || !Array.isArray(state.scheduleRequests)) throw new Error();
    dates.clear(); requestKeys.clear();
    for (const entry of state.schedules) {
      if (!validSchedule(entry) || dates.has(entry.date)) throw new Error();
      dates.add(entry.date);
    }
    for (const saved of state.scheduleRequests) {
      const scope = `${saved.date}:${saved.key}`;
      if (!uuidPattern.test(saved.key) || saved.key !== saved.key.toLowerCase() || requestKeys.has(scope) ||
          calendarDate(saved.date) !== saved.date || !sameSlots(normalizeScheduleSlots(saved.slots), saved.slots) ||
          !Number.isSafeInteger(saved.version) || saved.version < 0 || !timestamp(saved.expiresAt) ||
          !validSchedule(saved.response, true) || saved.response.date !== saved.date || !sameSlots(saved.response.slots, saved.slots) ||
          saved.response.version < saved.version || saved.response.version > saved.version + 1) throw new Error();
      requestKeys.add(scope);
    }
    // Older demo snapshots did not retain task responses; never require a reset.
    if (state.schemaVersion < 5 && !Object.hasOwn(state, "taskRequests")) state.taskRequests = [];
    if (!Array.isArray(state.taskRequests)) throw new Error();
    requestKeys.clear();
    for (const saved of state.taskRequests) {
      // Old response snapshots predate row order; do not invent a historical position.
      if (state.schemaVersion < 5 && !Object.hasOwn(saved.response, "dailyOrder")) saved.response.dailyOrder = null;
      if (state.schemaVersion < 6 && !Object.hasOwn(saved.response, "dueDate")) saved.response.dueDate = null;
      const scope = `${saved.method}:${saved.path}:${saved.key}`;
      const create = saved.method === "POST";
      if (!["POST", "PATCH"].includes(saved.method) || !uuidPattern.test(saved.key) || saved.key !== saved.key.toLowerCase() || requestKeys.has(scope) ||
          (create ? saved.path !== "/api/tasks" || saved.version !== null || saved.response.version !== 1 :
            saved.path !== `/api/tasks/${saved.response.id}` || !positiveInteger(saved.version) || saved.response.version < saved.version || saved.response.version > saved.version + 1) ||
          !sameTaskInput(normalizedTaskInput(saved.input, create), saved.input) || !timestamp(saved.expiresAt) || !validTask(saved.response) || !validDailyOrder(saved.response, true)) throw new Error();
      requestKeys.add(scope);
    }
    // Previous demo versions never retained activities. Do not manufacture historical values.
    if (state.schemaVersion < 6) state.activities = [];
    if (!Array.isArray(state.activities)) throw new Error();
    const activityIds = new Set<string>();
    for (const raw of state.activities) {
      const activity = taskActivity(raw);
      if (!ids.has(activity.taskId) || activityIds.has(activity.id)) throw new Error();
      activityIds.add(activity.id);
    }
    for (const activity of state.activities) {
      if (activity.invalidatedBy !== null && !state.activities.some(other => other.id === activity.invalidatedBy && other.taskId === activity.taskId && other.type === "completion_undone")) throw new Error();
    }
    return { ...state, schemaVersion: 6 };
  } catch {
    throw new Error("브라우저의 테스트 저장 데이터가 손상되어 불러올 수 없습니다.");
  }
}

function session(state: DemoState, now: Date): PlannerSession {
  return { userId: "00000000-0000-4000-8000-000000000001", csrfToken: "demo-browser-only",
    timezone: state.timezone, settingsVersion: state.settingsVersion, serverDate: today(state.timezone, now) };
}

function json(body: unknown, status = 200, version?: number): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (version !== undefined) headers.set("ETag", `"v${version}"`);
  return Response.json(body, { status, headers });
}

function body(init: RequestInit, fields: readonly string[]): Record<string, unknown> {
  if (typeof init.body !== "string") throw new InputError("body");
  let parsed: unknown;
  try { parsed = JSON.parse(init.body); } catch { throw new InputError("body"); }
  return object(parsed, fields);
}

function requestVersion(init: RequestInit, allowZero = false): number {
  const value = new Headers(init.headers).get("If-Match");
  if (!value) throw new DemoRequestError(428, "PRECONDITION_REQUIRED", "항목 버전이 필요합니다.");
  if (!(allowZero ? /^"v(?:0|[1-9]\d*)"$/u : /^"v[1-9]\d*"$/u).test(value)) throw new InputError("version");
  const version = Number(value.slice(2, -1));
  if (!Number.isSafeInteger(version) || version > 2147483646) throw new InputError("version");
  return version;
}

function checkVersion(init: RequestInit, current: number) {
  if (requestVersion(init) !== current) throw new DemoRequestError(412, "VERSION_CONFLICT", "항목이 변경되었습니다. 최신 내용을 확인해주세요.");
}

function writeKey(init: RequestInit, maxBytes = 65536) {
  const headers = new Headers(init.headers);
  if (headers.get("X-CSRF-Token") !== "demo-browser-only") throw new DemoRequestError(403, "FORBIDDEN", "요청을 다시 확인해주세요.");
  const suppliedKey = headers.get("Idempotency-Key");
  if (!suppliedKey || !uuidPattern.test(suppliedKey)) throw new InputError("Idempotency-Key");
  if (headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json" ||
      typeof init.body !== "string" || new TextEncoder().encode(init.body).byteLength > maxBytes) throw new InputError("body");
  return suppliedKey.toLowerCase();
}

function documentWrite(init: RequestInit) {
  return { key: writeKey(init), version: requestVersion(init, true) };
}

function taskWrite(state: DemoState, method: TaskRequest["method"], path: string, init: RequestInit, instant: Date) {
  const key = writeKey(init, 16384), version = method === "PATCH" ? requestVersion(init) : null;
  const input = normalizedTaskInput(body(init, taskFields(method === "POST")), method === "POST");
  const saved = state.taskRequests.find(item => item.method === method && item.path === path && item.key === key && Date.parse(item.expiresAt) > instant.getTime());
  if (saved && (saved.version !== version || JSON.stringify(saved.input) !== JSON.stringify(input))) throw new DemoRequestError(409, "IDEMPOTENCY_KEY_REUSED", "다른 내용에 사용한 요청 키입니다.");
  return { key, method, path, version, input, saved };
}

function rememberTask(state: DemoState, value: Omit<TaskRequest, "expiresAt">, instant: Date) {
  state.taskRequests = [...state.taskRequests.filter(saved => Date.parse(saved.expiresAt) > instant.getTime()),
    { ...value, expiresAt: new Date(instant.getTime() + REQUEST_TTL_MS).toISOString() }];
}

function checkDailyCapacity(state: DemoState, date: string | null) {
  if (date !== null && state.tasks.filter(task => task.scheduledDate === date).length >= DAILY_TASK_LIMIT) {
    throw new DemoRequestError(422, "DAILY_TASK_LIMIT", "하루에 할 일은 최대 5개까지 계획할 수 있습니다.");
  }
}

function appendedOrder(state: DemoState, date: string | null): number | null {
  if (date === null) return null;
  const next = state.tasks.reduce((maximum, task) => task.scheduledDate === date ? Math.max(maximum, task.dailyOrder ?? 0) : maximum, 0) + 1;
  if (!positiveInteger(next) || next > 2147483647) throw new InputError("dailyOrder");
  return next;
}

function listTasks(state: DemoState, params: URLSearchParams, now: Date) {
  const view = params.get("view") ?? "inbox";
  if (!["inbox", "day", "scheduled", "overdue", "completed", "due"].includes(view)) throw new InputError("view");
  const date = view === "inbox" ? null : calendarDate(params.get("date"));
  const range = view === "completed" && date ? dayRange(date, state.timezone) : null;
  const items = state.tasks.filter(task => {
    if (view === "inbox") return task.isUnprocessed;
    if (view === "day") return task.scheduledDate === date;
    if (view === "due") return (task.status === "open" || task.status === "deferred") && task.dueDate === date && task.scheduledDate !== date;
    if (view === "scheduled") return task.status !== "completed" && task.scheduledDate === date;
    if (view === "overdue") return (task.status === "open" || task.status === "deferred") && task.scheduledDate !== null && task.scheduledDate < (date ?? "");
    return task.status === "completed" && task.completedAt !== null && range !== null &&
      Date.parse(task.completedAt) >= range.start.getTime() && Date.parse(task.completedAt) < range.end.getTime();
  });
  items.sort((left, right) => {
    if (view === "day") return dayOrder(left, right);
    const order = view === "completed"
      ? (right.completedAt ?? "").localeCompare(left.completedAt ?? "")
      : left.createdAt.localeCompare(right.createdAt);
    return order || left.id.localeCompare(right.id);
  });
  return { items, nextCursor: null, timezone: state.timezone, serverDate: today(state.timezone, now) };
}

function appendActivity(state: DemoState, type: TaskActivityType, before: DemoTask | null, after: DemoTask, instant: Date): TaskActivity {
  const activity: TaskActivity = { id: crypto.randomUUID(), taskId: after.id, type, occurredAt: instant.toISOString(), invalidatedBy: null,
    details: { before: before ? taskPlanSnapshot(before) : null, after: taskPlanSnapshot(after), version: after.version } };
  state.activities.push(activity);
  return activity;
}

function listActivities(state: DemoState, taskId: string, params: URLSearchParams) {
  if ([...params.keys()].some(key => !["limit", "cursor"].includes(key) || params.getAll(key).length !== 1)) throw new InputError("query");
  const limitText = params.get("limit") ?? "50", limit = Number(limitText);
  if (!/^\d+$/u.test(limitText) || limit < 1 || limit > 100) throw new InputError("limit");
  let items = state.activities.filter(item => item.taskId === taskId).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
  const cursor = params.get("cursor");
  if (cursor !== null) {
    const parts = cursor.split(":");
    const afterId = parts[1];
    const previous = items.find(item => item.id === afterId);
    if (parts.length !== 3 || parts[0] !== taskId || parts[2] !== String(limit) || !previous) throw new DemoRequestError(400, "INVALID_CURSOR", "이력을 새로 불러와주세요.");
    items = items.filter(item => item.occurredAt < previous.occurredAt || item.occurredAt === previous.occurredAt && item.id > previous.id);
  }
  const selected = items.slice(0, limit);
  return { items: selected, nextCursor: items.length > limit ? `${taskId}:${selected.at(-1)?.id}:${limit}` : null };
}

/** All requests stay in this browser's injected storage, including unknown paths. */
export function createDemoTransport(storage: DemoStorage, now: () => Date = () => new Date()) {
  const initialSession = session(readState(storage), now());
  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      if (!path.startsWith("/api/") || path.startsWith("//")) return json({ code: "NOT_FOUND" }, 404);
      const url = new URL(path, "https://demo.invalid");
      const method = (init.method ?? "GET").toUpperCase();
      const state = readState(storage);
      const instant = now();
      if (method === "GET" && url.pathname === "/api/session") return json(session(state, instant));
      if (method === "POST" && url.pathname === "/api/logout") return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
      const journalMatch = /^\/api\/journal\/([^/]+)$/u.exec(url.pathname);
      if (journalMatch && ["GET", "PUT"].includes(method)) {
        const date = calendarDate(journalMatch[1]);
        const current = state.journals.find(entry => entry.date === date) ?? { date, content: "", version: 0, updatedAt: null };
        if (method === "GET") return json(current, 200, current.version);
        const { key, version } = documentWrite(init);
        const content = journalContent(body(init, ["content"]).content);
        const activeRequests = state.journalRequests.filter(saved => Date.parse(saved.expiresAt) > instant.getTime());
        const saved = activeRequests.find(item => item.date === date && item.key === key);
        if (saved) {
          if (saved.content !== content || saved.version !== version) throw new DemoRequestError(409, "IDEMPOTENCY_KEY_REUSED", "다른 내용에 사용한 요청 키입니다.");
          return json(saved.response, 200, saved.response.version);
        }
        if (current.version !== version) throw new DemoRequestError(412, "VERSION_CONFLICT", "글이 변경되었습니다. 최신 내용을 확인해주세요.");
        const next: JournalEntry = content === current.content ? current : { date, content, version: current.version + 1, updatedAt: instant.toISOString() };
        if (next !== current) {
          state.journals = [...state.journals.filter(entry => entry.date !== date), next];
        }
        state.journalRequests = [...activeRequests, { key, date, content, version, response: next, expiresAt: new Date(instant.getTime() + REQUEST_TTL_MS).toISOString() }];
        storage.setItem(STORAGE_KEY, JSON.stringify(state));
        return json(next, 200, next.version);
      }
      const scheduleMatch = /^\/api\/schedule\/([^/]+)$/u.exec(url.pathname);
      if (scheduleMatch && ["GET", "PUT"].includes(method)) {
        const date = calendarDate(scheduleMatch[1]);
        const current = state.schedules.find(entry => entry.date === date) ?? { date, slots: [], version: 0, updatedAt: null };
        if (method === "GET") return json(current, 200, current.version);
        const { key, version } = documentWrite(init);
        const slots = normalizeScheduleSlots(body(init, ["slots"]).slots);
        const activeRequests = state.scheduleRequests.filter(saved => Date.parse(saved.expiresAt) > instant.getTime());
        const saved = activeRequests.find(item => item.date === date && item.key === key);
        if (saved) {
          if (!sameSlots(saved.slots, slots) || saved.version !== version) throw new DemoRequestError(409, "IDEMPOTENCY_KEY_REUSED", "다른 내용에 사용한 요청 키입니다.");
          return json(saved.response, 200, saved.response.version);
        }
        if (current.version !== version) throw new DemoRequestError(412, "VERSION_CONFLICT", "일정이 변경되었습니다. 최신 내용을 확인해주세요.");
        const next: ScheduleEntry = sameSlots(slots, current.slots) ? current : { date, slots, version: current.version + 1, updatedAt: instant.toISOString() };
        if (next !== current) state.schedules = [...state.schedules.filter(entry => entry.date !== date), next];
        state.scheduleRequests = [...activeRequests, { key, date, slots, version, response: next, expiresAt: new Date(instant.getTime() + REQUEST_TTL_MS).toISOString() }];
        storage.setItem(STORAGE_KEY, JSON.stringify(state));
        return json(next, 200, next.version);
      }
      if (method === "GET" && url.pathname === "/api/tasks") return json(listTasks(state, url.searchParams, instant));
      if (method === "POST" && url.pathname === "/api/tasks") {
        const { saved, ...write } = taskWrite(state, "POST", url.pathname, init, instant);
        if (saved) return json(saved.response, 201, saved.response.version);
        const { input } = write;
        const task: DemoTask = {
          id: crypto.randomUUID(), title: input.title ?? "", status: "open", isUnprocessed: input.isUnprocessed !== false, version: 1,
          priority: input.priority ?? "medium", kind: input.kind ?? "task", scheduledDate: input.scheduledDate ?? null,
          dueDate: input.dueDate ?? null,
          dailyOrder: appendedOrder(state, input.scheduledDate ?? null),
          createdAt: instant.toISOString(), updatedAt: instant.toISOString(), completedAt: null
        };
        if (!task.isUnprocessed && task.scheduledDate === null) throw new InputError("isUnprocessed");
        checkDailyCapacity(state, task.scheduledDate);
        state.tasks.push(task);
        appendActivity(state, "created", null, task, instant);
        rememberTask(state, { ...write, response: task }, instant);
        storage.setItem(STORAGE_KEY, JSON.stringify(state));
        return json(task, 201, task.version);
      }
      if (method === "PATCH" && url.pathname === "/api/settings") {
        checkVersion(init, state.settingsVersion);
        const zone = timezone(body(init, ["timezone"]).timezone);
        if (zone !== state.timezone) {
          state.timezone = zone;
          state.settingsVersion++;
          storage.setItem(STORAGE_KEY, JSON.stringify(state));
        }
        return json({ timezone: state.timezone, version: state.settingsVersion }, 200, state.settingsVersion);
      }
      const historyMatch = /^\/api\/tasks\/([^/]+)\/activities$/u.exec(url.pathname);
      if (method === "GET" && historyMatch) {
        if (!state.tasks.some(item => item.id === historyMatch[1])) return json({ code: "NOT_FOUND" }, 404);
        return json(listActivities(state, historyMatch[1], url.searchParams));
      }
      const match = /^\/api\/tasks\/([^/]+)$/u.exec(url.pathname);
      if (!match || !["GET", "PATCH"].includes(method)) return json({ code: "NOT_FOUND" }, 404);
      const task = state.tasks.find(item => item.id === match[1]);
      if (!task) return json({ code: "NOT_FOUND" }, 404);
      if (method === "GET") return json(task, 200, task.version);
      const { saved, ...write } = taskWrite(state, "PATCH", url.pathname, init, instant);
      if (saved) return json(saved.response, 200, saved.response.version);
      if (write.version !== task.version) throw new DemoRequestError(412, "VERSION_CONFLICT", "항목이 변경되었습니다. 최신 내용을 확인해주세요.");
      if (write.input.move || write.input.moveTo) {
        if (task.scheduledDate === null) throw new InputError("scheduledDate");
        if (write.input.moveTo) {
          const target = state.tasks.find(item => item.id === write.input.moveTo);
          if (!target) throw new DemoRequestError(404, "NOT_FOUND", "항목을 찾을 수 없습니다.");
          if (target.scheduledDate !== task.scheduledDate) throw new InputError("moveTo");
        }
        const day = state.tasks.filter(item => item.scheduledDate === task.scheduledDate).sort(dayOrder);
        const index = day.indexOf(task), targetIndex = write.input.moveTo ? day.findIndex(item => item.id === write.input.moveTo) : index + (write.input.move === "up" ? -1 : 1);
        let next = task;
        if (targetIndex !== index && targetIndex >= 0 && targetIndex < day.length) {
          const first = Math.min(index, targetIndex), last = Math.max(index, targetIndex);
          const affected = day.slice(first, last + 1), reordered = [...day];
          if (affected.some(item => item.version >= 2147483647)) throw new InputError("version");
          reordered.splice(index, 1); reordered.splice(targetIndex, 0, task);
          const changed = reordered.slice(first, last + 1).map((item, offset) => ({ ...item, dailyOrder: affected[offset].dailyOrder, version: item.version + 1, updatedAt: instant.toISOString() }));
          state.tasks = state.tasks.map(item => changed.find(candidate => candidate.id === item.id) ?? item);
          for (const item of changed) appendActivity(state, "order_changed", affected.find(original => original.id === item.id) ?? null, item, instant);
          next = changed.find(item => item.id === task.id) ?? task;
        }
        rememberTask(state, { ...write, response: next }, instant);
        storage.setItem(STORAGE_KEY, JSON.stringify(state));
        return json(next, 200, next.version);
      }
      const { input } = write, next = { ...task, ...input };
      if (next.status !== task.status) next.completedAt = next.status === "completed" ? instant.toISOString() : null;
      if (next.status !== "completed" && next.scheduledDate === null) {
        if (input.isUnprocessed === false) throw new InputError("isUnprocessed");
        next.isUnprocessed = true;
      }
      if (next.scheduledDate !== task.scheduledDate) {
        checkDailyCapacity(state, next.scheduledDate);
        next.dailyOrder = appendedOrder(state, next.scheduledDate);
      }
      const changed = next.isUnprocessed !== task.isUnprocessed || Object.keys(input).some(field => next[field as keyof DemoTask] !== task[field as keyof DemoTask]);
      if (changed) {
        next.version++;
        next.updatedAt = instant.toISOString();
        state.tasks[state.tasks.indexOf(task)] = next;
        if (next.status !== task.status) {
          if (task.status === "completed") {
            const undo = appendActivity(state, "completion_undone", task, next, instant);
            for (const activity of state.activities) if (activity.taskId === task.id && activity.type === "completed" && activity.invalidatedBy === null) activity.invalidatedBy = undo.id;
          }
          if (!(task.status === "completed" && next.status === "open")) appendActivity(state, next.status === "open" ? "reopened" : next.status, task, next, instant);
        }
        for (const [field, type] of [["scheduledDate", "scheduled_date_changed"], ["dueDate", "due_date_changed"], ["isUnprocessed", "processing_changed"], ["priority", "priority_changed"], ["kind", "kind_changed"]] as const) {
          if (next[field] !== task[field]) appendActivity(state, type, task, next, instant);
        }
      }
      rememberTask(state, { ...write, response: next }, instant);
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
      return json(next, 200, next.version);
    } catch (error) {
      if (error instanceof InputError) return json({ code: "INVALID_INPUT", message: "입력값을 확인해주세요." }, 422);
      if (error instanceof DemoRequestError) return json({ code: error.code, message: error.message }, error.status);
      return json({ code: "DEMO_STORAGE_UNAVAILABLE", message: "테스트 저장소를 사용할 수 없습니다. 입력을 보존하고 다시 시도해주세요." }, 500);
    }
  }
  return { request, initialSession };
}
