import { calendarDate, dayRange, InputError, object, title, timezone, today, uuidPattern } from "../../domain/rules";
import type { PlannerSession } from "../planner";

const STORAGE_KEY = "web-planner:demo:v1";
type DemoTask = {
  id: string;
  title: string;
  status: "open" | "completed";
  scheduledDate: string | null;
  isUnprocessed: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};
type DemoState = { schemaVersion: 1; timezone: string; settingsVersion: number; tasks: DemoTask[] };
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

function readState(storage: DemoStorage): DemoState {
  const stored = storage.getItem(STORAGE_KEY);
  if (stored === null) return { schemaVersion: 1, timezone: "Asia/Seoul", settingsVersion: 1, tasks: [] };
  try {
    const state = JSON.parse(stored) as DemoState;
    if (state.schemaVersion !== 1 || !positiveInteger(state.settingsVersion) || timezone(state.timezone) !== state.timezone || !Array.isArray(state.tasks)) throw new Error();
    const ids = new Set<string>();
    for (const task of state.tasks) {
      if (!uuidPattern.test(task.id) || ids.has(task.id) || title(task.title) !== task.title || !positiveInteger(task.version) ||
          typeof task.isUnprocessed !== "boolean" || !timestamp(task.createdAt) || !timestamp(task.updatedAt) ||
          (task.scheduledDate !== null && calendarDate(task.scheduledDate) !== task.scheduledDate) ||
          (task.status !== "open" && task.status !== "completed") ||
          (task.status === "completed" ? !timestamp(task.completedAt) : task.completedAt !== null)) throw new Error();
      ids.add(task.id);
    }
    return state;
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

function checkVersion(init: RequestInit, current: number) {
  const value = new Headers(init.headers).get("If-Match");
  if (!value) throw new DemoRequestError(428, "PRECONDITION_REQUIRED", "항목 버전이 필요합니다.");
  if (!/^"v[1-9]\d*"$/u.test(value)) throw new InputError("version");
  if (value !== `"v${current}"`) throw new DemoRequestError(412, "VERSION_CONFLICT", "항목이 변경되었습니다. 최신 내용을 확인해주세요.");
}

function listTasks(state: DemoState, params: URLSearchParams, now: Date) {
  const view = params.get("view") ?? "inbox";
  if (!["inbox", "scheduled", "overdue", "completed"].includes(view)) throw new InputError("view");
  const date = view === "inbox" ? null : calendarDate(params.get("date"));
  const range = view === "completed" && date ? dayRange(date, state.timezone) : null;
  const items = state.tasks.filter(task => {
    if (view === "inbox") return task.isUnprocessed;
    if (view === "scheduled") return task.status === "open" && task.scheduledDate === date;
    if (view === "overdue") return task.status === "open" && task.scheduledDate !== null && task.scheduledDate < (date ?? "");
    return task.status === "completed" && task.completedAt !== null && range !== null &&
      Date.parse(task.completedAt) >= range.start.getTime() && Date.parse(task.completedAt) < range.end.getTime();
  });
  items.sort((left, right) => {
    const order = view === "completed"
      ? (right.completedAt ?? "").localeCompare(left.completedAt ?? "")
      : left.createdAt.localeCompare(right.createdAt);
    return order || left.id.localeCompare(right.id);
  });
  return { items, nextCursor: null, timezone: state.timezone, serverDate: today(state.timezone, now) };
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
      if (method === "GET" && url.pathname === "/api/tasks") return json(listTasks(state, url.searchParams, instant));
      if (method === "POST" && url.pathname === "/api/tasks") {
        const input = body(init, ["title", "scheduledDate"]);
        const task: DemoTask = {
          id: crypto.randomUUID(), title: title(input.title), status: "open", isUnprocessed: true, version: 1,
          scheduledDate: input.scheduledDate == null ? null : calendarDate(input.scheduledDate),
          createdAt: instant.toISOString(), updatedAt: instant.toISOString(), completedAt: null
        };
        state.tasks.push(task);
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
      const match = /^\/api\/tasks\/([^/]+)$/u.exec(url.pathname);
      if (!match || !["GET", "PATCH"].includes(method)) return json({ code: "NOT_FOUND" }, 404);
      const task = state.tasks.find(item => item.id === match[1]);
      if (!task) return json({ code: "NOT_FOUND" }, 404);
      if (method === "GET") return json(task, 200, task.version);
      checkVersion(init, task.version);
      const input = body(init, ["title", "scheduledDate", "isUnprocessed", "status"]);
      if (!Object.keys(input).length) throw new InputError("body");
      const next = { ...task };
      if ("title" in input) next.title = title(input.title);
      if ("scheduledDate" in input) next.scheduledDate = input.scheduledDate === null ? null : calendarDate(input.scheduledDate);
      if ("isUnprocessed" in input) {
        if (typeof input.isUnprocessed !== "boolean") throw new InputError("isUnprocessed");
        next.isUnprocessed = input.isUnprocessed;
      }
      if ("status" in input) {
        if (input.status !== "open" && input.status !== "completed") throw new InputError("status");
        next.status = input.status;
        if (next.status !== task.status) next.completedAt = next.status === "completed" ? instant.toISOString() : null;
      }
      const changed = Object.keys(input).some(field => next[field as keyof DemoTask] !== task[field as keyof DemoTask]);
      if (changed) {
        next.version++;
        next.updatedAt = instant.toISOString();
        state.tasks[state.tasks.indexOf(task)] = next;
        storage.setItem(STORAGE_KEY, JSON.stringify(state));
      }
      return json(next, 200, next.version);
    } catch (error) {
      if (error instanceof InputError) return json({ code: "INVALID_INPUT", message: "입력값을 확인해주세요." }, 422);
      if (error instanceof DemoRequestError) return json({ code: error.code, message: error.message }, error.status);
      return json({ code: "DEMO_STORAGE_UNAVAILABLE", message: "테스트 저장소를 사용할 수 없습니다. 입력을 보존하고 다시 시도해주세요." }, 500);
    }
  }
  return { request, initialSession };
}
