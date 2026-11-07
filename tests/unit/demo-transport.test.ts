import { describe, expect, it, vi } from "vitest";
import { createDemoTransport } from "../../src/app/demo/transport";

const key = "web-planner:demo:v1";
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, value); }
  };
}
function mutation(method: "POST" | "PATCH", body: object, version?: number): RequestInit {
  return { method, headers: version === undefined ? {} : { "If-Match": `"v${version}"` }, body: JSON.stringify(body) };
}
function journalMutation(content: unknown, version = 0, requestKey = crypto.randomUUID()): RequestInit {
  return { method: "PUT", headers: { "Content-Type": "application/json", "X-CSRF-Token": "demo-browser-only", "Idempotency-Key": requestKey,
    "If-Match": `"v${version}"` }, body: JSON.stringify({ content }) };
}

describe("browser-only demo transport", () => {
  it("starts empty and preserves normalized tasks and settings across recreation", async () => {
    const storage = memoryStorage();
    const demo = createDemoTransport(storage);
    expect(demo.initialSession.timezone).toBe("Asia/Seoul");
    expect((await (await demo.request("/api/tasks?view=inbox")).json()).items).toEqual([]);
    const created = await demo.request("/api/tasks", mutation("POST", { title: "  첫 테스트  " }));
    expect(created.status).toBe(201);
    expect(created.headers.get("ETag")).toBe('"v1"');
    const task = await created.json();
    expect(task).toMatchObject({ title: "첫 테스트", version: 1, scheduledDate: null, isUnprocessed: true, priority: "medium", kind: "task" });
    const saved = await demo.request("/api/settings", mutation("PATCH", { timezone: "America/Los_Angeles" }, 1));
    expect(saved.status).toBe(200);
    const refreshed = createDemoTransport(storage);
    expect(refreshed.initialSession).toMatchObject({ timezone: "America/Los_Angeles", settingsVersion: 2 });
    expect((await (await refreshed.request("/api/tasks?view=inbox")).json()).items).toEqual([task]);
  });

  it("adapts existing v1 diary entries without erasing or eagerly rewriting them", async () => {
    const storage = memoryStorage();
    const legacyTask = { id: "00000000-0000-4000-8000-000000000002", title: "기존 기록", status: "completed", scheduledDate: "2026-11-07",
      isUnprocessed: false, version: 4, createdAt: "2026-11-06T00:00:00.000Z", updatedAt: "2026-11-07T00:00:00.000Z", completedAt: "2026-11-07T00:00:00.000Z" };
    const legacy = JSON.stringify({ schemaVersion: 1, timezone: "Asia/Seoul", settingsVersion: 2, tasks: [legacyTask] });
    storage.setItem(key, legacy);
    const demo = createDemoTransport(storage);
    const adapted = await (await demo.request(`/api/tasks/${legacyTask.id}`)).json();
    expect(adapted).toMatchObject({ ...legacyTask, priority: "medium", kind: "task" });
    expect(storage.getItem(key)).toBe(legacy);
    const setter = vi.spyOn(storage, "setItem").mockImplementation(() => { throw new Error("Quota exceeded"); });
    expect((await demo.request(`/api/tasks/${legacyTask.id}`, mutation("PATCH", { priority: "high" }, 4))).status).toBe(500);
    expect(storage.getItem(key)).toBe(legacy);
    setter.mockRestore();
    expect((await demo.request(`/api/tasks/${legacyTask.id}`, mutation("PATCH", { priority: "high", kind: "event" }, 4))).status).toBe(200);
    expect(JSON.parse(storage.getItem(key) ?? "{}").schemaVersion).toBe(3);
    const restored = createDemoTransport(storage);
    expect(await (await restored.request(`/api/tasks/${legacyTask.id}`)).json()).toMatchObject({ ...legacyTask, priority: "high", kind: "event", version: 5, updatedAt: expect.any(String) });
  });

  it("validates and persists priority and kind without creating no-op versions", async () => {
    const storage = memoryStorage();
    const demo = createDemoTransport(storage);
    const task = await (await demo.request("/api/tasks", mutation("POST", { title: "약속", priority: "high", kind: "appointment" }))).json();
    expect(task).toMatchObject({ priority: "high", kind: "appointment" });
    const unchanged = await (await demo.request(`/api/tasks/${task.id}`, mutation("PATCH", { priority: "high", kind: "appointment" }, 1))).json();
    expect(unchanged.version).toBe(1);
    const before = storage.getItem(key);
    for (const input of [{ priority: "urgent" }, { priority: null }, { kind: "note" }, { kind: false }, { status: "deleted" }]) {
      expect((await demo.request(`/api/tasks/${task.id}`, mutation("PATCH", input, 1))).status).toBe(422);
    }
    expect((await demo.request("/api/tasks", mutation("POST", { title: "잘못된 생성", priority: null }))).status).toBe(422);
    expect(storage.getItem(key)).toBe(before);
    expect((await demo.request(`/api/tasks/${task.id}`, mutation("PATCH", { priority: "low", kind: "event" }, 1))).status).toBe(200);
    expect(await (await createDemoTransport(storage).request(`/api/tasks/${task.id}`)).json()).toMatchObject({ priority: "low", kind: "event", version: 2 });
    for (const corrupted of [
      { ...JSON.parse(before ?? "{}"), schemaVersion: 1, tasks: [{ ...task, priority: null }] },
      { ...JSON.parse(before ?? "{}"), tasks: [{ ...task, kind: "note" }] },
      { ...JSON.parse(before ?? "{}"), tasks: [{ ...task, priority: undefined }] }
    ]) {
      const value = JSON.stringify(corrupted);
      storage.setItem(key, value);
      expect(() => createDemoTransport(storage)).toThrow("손상");
      expect(storage.getItem(key)).toBe(value);
    }
  });

  it("keeps deferred and canceled markers on the planned day and restores completion correctly", async () => {
    const storage = memoryStorage();
    const demo = createDemoTransport(storage, () => new Date("2026-11-07T00:30:00.000Z"));
    const task = await (await demo.request("/api/tasks", mutation("POST", { title: "상태 전환", scheduledDate: "2026-11-07" }))).json();
    let version = 1;
    const change = async (status: string) => {
      const response = await demo.request(`/api/tasks/${task.id}`, mutation("PATCH", { status }, version));
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toMatchObject({ id: task.id, scheduledDate: "2026-11-07", status, version: ++version });
      return result;
    };
    expect((await change("completed")).completedAt).toBe("2026-11-07T00:30:00.000Z");
    expect((await change("canceled")).completedAt).toBeNull();
    expect((await (await demo.request("/api/tasks?view=scheduled&date=2026-11-07")).json()).items).toHaveLength(1);
    expect((await (await demo.request("/api/tasks?view=overdue&date=2026-11-08")).json()).items).toHaveLength(0);
    expect((await (await demo.request("/api/tasks?view=completed&date=2026-11-07")).json()).items).toHaveLength(0);
    await change("open");
    expect((await change("deferred")).completedAt).toBeNull();
    expect((await (await demo.request("/api/tasks?view=scheduled&date=2026-11-07")).json()).items[0].status).toBe("deferred");
    expect((await (await demo.request("/api/tasks?view=scheduled&date=2026-11-08")).json()).items).toHaveLength(0);
    expect((await (await demo.request("/api/tasks?view=overdue&date=2026-11-08")).json()).items).toHaveLength(1);
    await change("completed");
    expect((await (await createDemoTransport(storage).request("/api/tasks?view=completed&date=2026-11-07")).json()).items).toHaveLength(1);
  });

  it("returns undated completed entries to the inbox on restore, deferral or cancellation", async () => {
    for (const status of ["open", "deferred", "canceled"]) {
      const storage = memoryStorage();
      const demo = createDemoTransport(storage);
      const task = await (await demo.request("/api/tasks", mutation("POST", { title: "날짜 없는 기록" }))).json();
      expect((await demo.request(`/api/tasks/${task.id}`, mutation("PATCH", { isUnprocessed: false }, 1))).status).toBe(422);
      const processed = await (await demo.request(`/api/tasks/${task.id}`, mutation("PATCH", { status: "completed", isUnprocessed: false }, 1))).json();
      expect(processed).toMatchObject({ status: "completed", isUnprocessed: false, version: 2 });
      expect((await (await demo.request("/api/tasks?view=inbox")).json()).items).toHaveLength(0);
      const before = storage.getItem(key);
      expect((await demo.request(`/api/tasks/${task.id}`, mutation("PATCH", { status, isUnprocessed: false }, 2))).status).toBe(422);
      expect(storage.getItem(key)).toBe(before);
      const setter = vi.spyOn(storage, "setItem").mockImplementation(() => { throw new Error("Quota exceeded"); });
      expect((await demo.request(`/api/tasks/${task.id}`, mutation("PATCH", { status }, 2))).status).toBe(500);
      expect(storage.getItem(key)).toBe(before);
      setter.mockRestore();
      const reopened = await (await demo.request(`/api/tasks/${task.id}`, mutation("PATCH", { status }, 2))).json();
      expect(reopened).toMatchObject({ id: task.id, status, scheduledDate: null, completedAt: null, isUnprocessed: true, version: 3 });
      expect((await (await demo.request("/api/tasks?view=inbox")).json()).items).toEqual([reopened]);
    }
  });

  it("counts an automatically restored inbox flag as a versioned mutation", async () => {
    const storage = memoryStorage();
    const demo = createDemoTransport(storage);
    const task = await (await demo.request("/api/tasks", mutation("POST", { title: "기존 날짜 없는 항목" }))).json();
    const legacy = JSON.parse(storage.getItem(key) ?? "{}");
    legacy.tasks[0].isUnprocessed = false;
    storage.setItem(key, JSON.stringify(legacy));
    const original = storage.getItem(key);
    expect((await (await demo.request("/api/tasks?view=inbox")).json()).items).toHaveLength(0);
    expect(storage.getItem(key)).toBe(original);
    const repaired = await (await demo.request(`/api/tasks/${task.id}`, mutation("PATCH", { priority: "medium" }, 1))).json();
    expect(repaired).toMatchObject({ isUnprocessed: true, version: 2 });
    const unchanged = await (await demo.request(`/api/tasks/${task.id}`, mutation("PATCH", { priority: "medium" }, 2))).json();
    expect(unchanged.version).toBe(2);
  });

  it("uses optimistic versions across instances and keeps original ID through complete and undo", async () => {
    const storage = memoryStorage();
    const demo = createDemoTransport(storage, () => new Date("2026-11-07T00:30:00.000Z"));
    const other = createDemoTransport(storage);
    const task = await (await demo.request("/api/tasks", mutation("POST", { title: "원본 항목" }))).json();
    const planned = await (await other.request(`/api/tasks/${task.id}`, mutation("PATCH", { scheduledDate: "2026-11-07", isUnprocessed: false }, 1))).json();
    expect(planned).toMatchObject({ id: task.id, version: 2 });
    expect((await demo.request(`/api/tasks/${task.id}`, mutation("PATCH", { title: "오래된 변경" }, 1))).status).toBe(412);
    expect((await demo.request(`/api/tasks/${task.id}`, mutation("PATCH", { status: "completed" }))).status).toBe(428);
    const completed = await (await demo.request(`/api/tasks/${task.id}`, mutation("PATCH", { status: "completed" }, 2))).json();
    expect(completed).toMatchObject({ id: task.id, version: 3, completedAt: "2026-11-07T00:30:00.000Z" });
    expect((await (await demo.request("/api/tasks?view=scheduled&date=2026-11-07")).json()).items).toHaveLength(0);
    expect((await (await demo.request("/api/tasks?view=completed&date=2026-11-07")).json()).items).toHaveLength(1);
    const undone = await (await demo.request(`/api/tasks/${task.id}`, mutation("PATCH", { status: "open" }, 3))).json();
    expect(undone).toMatchObject({ id: task.id, version: 4, scheduledDate: "2026-11-07", completedAt: null });
    expect((await (await demo.request("/api/tasks?view=completed&date=2026-11-07")).json()).items).toHaveLength(0);
    expect((await (await demo.request("/api/tasks?view=overdue&date=2026-11-08")).json()).items).toHaveLength(1);
  });

  it("reinterprets completed timestamps in the selected timezone while preserving scheduled dates", async () => {
    const demo = createDemoTransport(memoryStorage(), () => new Date("2026-11-07T00:30:00.000Z"));
    const task = await (await demo.request("/api/tasks", mutation("POST", { title: "시간대 확인", scheduledDate: "2026-11-07" }))).json();
    await demo.request(`/api/tasks/${task.id}`, mutation("PATCH", { status: "completed" }, 1));
    await demo.request("/api/settings", mutation("PATCH", { timezone: "America/Los_Angeles" }, 1));
    expect((await (await demo.request("/api/session")).json()).serverDate).toBe("2026-11-06");
    expect((await (await demo.request("/api/tasks?view=completed&date=2026-11-07")).json()).items).toHaveLength(0);
    const completed = (await (await demo.request("/api/tasks?view=completed&date=2026-11-06")).json()).items;
    expect(completed).toHaveLength(1);
    expect(completed[0].scheduledDate).toBe("2026-11-07");
    expect((await demo.request("/api/settings", mutation("PATCH", { timezone: "UTC" }, 1))).status).toBe(412);
  });

  it("reports storage write failure without changing saved data or falsely confirming success", async () => {
    const storage = memoryStorage();
    const demo = createDemoTransport(storage);
    const task = await (await demo.request("/api/tasks", mutation("POST", { title: "보존할 원본" }))).json();
    const original = storage.getItem(key);
    const setter = vi.spyOn(storage, "setItem").mockImplementation(() => { throw new Error("Quota exceeded"); });
    expect((await demo.request(`/api/tasks/${task.id}`, mutation("PATCH", { title: "저장 실패 변경" }, 1))).status).toBe(500);
    expect((await demo.request("/api/tasks", mutation("POST", { title: "저장 실패 생성" }))).status).toBe(500);
    expect((await demo.request("/api/settings", mutation("PATCH", { timezone: "UTC" }, 1))).status).toBe(500);
    expect(storage.getItem(key)).toBe(original);
    expect(await (await demo.request(`/api/tasks/${task.id}`)).json()).toMatchObject({ title: "보존할 원본", version: 1 });
    setter.mockRestore();
    expect((await demo.request(`/api/tasks/${task.id}`, mutation("PATCH", { title: "재시도 성공" }, 1))).status).toBe(200);
    const getter = vi.spyOn(storage, "getItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    expect((await demo.request("/api/session")).status).toBe(500);
    expect((await demo.request("/api/tasks?view=inbox")).status).toBe(500);
    getter.mockRestore();
  });

  it("surfaces corrupt stored data and rejects invalid inputs without erasing existing data", async () => {
    const storage = memoryStorage();
    for (const value of ["broken json", JSON.stringify({ schemaVersion: 1, timezone: "Asia/Seoul", settingsVersion: 1, tasks: [{ id: "bad" }] })]) {
      storage.setItem(key, value);
      expect(() => createDemoTransport(storage)).toThrow("손상");
      expect(storage.getItem(key)).toBe(value);
    }
    const clean = memoryStorage();
    const demo = createDemoTransport(clean);
    expect((await demo.request("/api/tasks", mutation("POST", { title: " " }))).status).toBe(422);
    expect((await demo.request("/api/tasks", mutation("POST", { title: "날짜", scheduledDate: "2026-02-30" }))).status).toBe(422);
    expect(clean.getItem(key)).toBeNull();
  });

  it("reads absent journal pages without writes and preserves the initial empty no-op version", async () => {
    const storage = memoryStorage();
    const demo = createDemoTransport(storage);
    const empty = { date: "2026-11-07", content: "", version: 0, updatedAt: null };
    const read = await demo.request("/api/journal/2026-11-07");
    expect(read.status).toBe(200);
    expect(read.headers.get("ETag")).toBe('"v0"');
    expect(await read.json()).toEqual(empty);
    expect(storage.getItem(key)).toBeNull();
    const request = journalMutation("");
    const write = await demo.request("/api/journal/2026-11-07", request);
    expect(write.status).toBe(200);
    expect(write.headers.get("ETag")).toBe('"v0"');
    expect(await write.json()).toEqual(empty);
    expect(await (await createDemoTransport(storage).request("/api/journal/2026-11-07", request)).json()).toEqual(empty);
  });

  it("preserves freeform text per calendar date through reload, timezone changes, no-ops and clearing", async () => {
    const storage = memoryStorage();
    let instant = new Date("2026-11-07T00:30:00.000Z");
    const demo = createDemoTransport(storage, () => instant);
    const first = await (await demo.request("/api/journal/2026-11-07", journalMutation("  첫 줄\r\n\r\n<script>메모</script>  \n"))).json();
    expect(first).toEqual({ date: "2026-11-07", content: "  첫 줄\n\n<script>메모</script>  \n", version: 1, updatedAt: instant.toISOString() });
    const second = await (await demo.request("/api/journal/2026-11-08", journalMutation("다음 날의 글"))).json();
    instant = new Date("2026-11-07T01:30:00.000Z");
    const unchanged = await demo.request("/api/journal/2026-11-07", journalMutation(first.content, 1));
    expect(unchanged.headers.get("ETag")).toBe('"v1"');
    expect(await unchanged.json()).toEqual(first);
    await demo.request("/api/tasks", mutation("POST", { title: "글과 함께 보존할 일" }));
    await demo.request("/api/settings", mutation("PATCH", { timezone: "America/Los_Angeles" }, 1));
    const restored = createDemoTransport(storage, () => instant);
    expect(restored.initialSession.serverDate).toBe("2026-11-06");
    expect(await (await restored.request("/api/journal/2026-11-07")).json()).toEqual(first);
    expect(await (await restored.request("/api/journal/2026-11-08")).json()).toEqual(second);
    expect(await (await restored.request("/api/journal/2026-11-06")).json()).toMatchObject({ content: "", version: 0 });
    const cleared = await restored.request("/api/journal/2026-11-07", journalMutation("", 1));
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ date: "2026-11-07", content: "", version: 2, updatedAt: instant.toISOString() });
    expect(await (await createDemoTransport(storage).request("/api/journal/2026-11-08")).json()).toEqual(second);
    expect((await (await restored.request("/api/tasks?view=inbox")).json()).items).toHaveLength(1);
  });

  it("replays the original successful journal response after recreation and later edits", async () => {
    const storage = memoryStorage();
    const demo = createDemoTransport(storage);
    const requestKey = crypto.randomUUID();
    const firstRequest = journalMutation("첫째\r\n둘째", 0, requestKey);
    const first = await (await demo.request("/api/journal/2026-11-07", firstRequest)).json();
    const latest = await (await demo.request("/api/journal/2026-11-07", journalMutation("새로운 글", 1))).json();
    const refreshed = createDemoTransport(storage);
    const before = storage.getItem(key);
    const replay = await refreshed.request("/api/journal/2026-11-07", journalMutation("첫째\n둘째", 0, requestKey));
    expect(replay.status).toBe(200);
    expect(replay.headers.get("ETag")).toBe('"v1"');
    expect(await replay.json()).toEqual(first);
    expect(storage.getItem(key)).toBe(before);
    expect(await (await refreshed.request("/api/journal/2026-11-07")).json()).toEqual(latest);
    for (const request of [journalMutation("다른 글", 0, requestKey), journalMutation("첫째\n둘째", 1, requestKey)]) {
      const conflict = await refreshed.request("/api/journal/2026-11-07", request);
      expect(conflict.status).toBe(409);
      expect((await conflict.json()).code).toBe("IDEMPOTENCY_KEY_REUSED");
    }
    expect(storage.getItem(key)).toBe(before);
    expect((await refreshed.request("/api/journal/2026-11-07", journalMutation("경합한 글", 1))).status).toBe(412);
    expect((await refreshed.request("/api/journal/2026-11-08", firstRequest)).status).toBe(200);
  });

  it("expires journal replay records after 24 hours without rewriting storage on reads or failed retries", async () => {
    const storage = memoryStorage();
    let instant = new Date("2026-11-07T00:00:00.000Z");
    const demo = createDemoTransport(storage, () => instant);
    const requestKey = crypto.randomUUID();
    const request = journalMutation("첫 글", 0, requestKey);
    expect((await demo.request("/api/journal/2026-11-07", request)).status).toBe(200);
    instant = new Date("2026-11-07T23:59:59.999Z");
    expect((await demo.request("/api/journal/2026-11-07", request)).status).toBe(200);
    instant = new Date("2026-11-08T00:00:00.000Z");
    const before = storage.getItem(key);
    expect((await demo.request("/api/journal/2026-11-07")).status).toBe(200);
    expect((await demo.request("/api/journal/2026-11-07", request)).status).toBe(412);
    expect(storage.getItem(key)).toBe(before);
    expect((await demo.request("/api/journal/2026-11-07", journalMutation("다음 글", 1, requestKey))).status).toBe(200);
    expect(JSON.parse(storage.getItem(key) ?? "{}").journalRequests).toHaveLength(1);
  });

  it("lazily upgrades v1 and v2 task storage when saving a journal without losing existing records", async () => {
    for (const schemaVersion of [1, 2]) {
      const storage = memoryStorage();
      const seed = createDemoTransport(storage);
      const task = await (await seed.request("/api/tasks", mutation("POST", { title: "기존 할 일", scheduledDate: "2026-11-07" }))).json();
      const oldTask = { ...task };
      if (schemaVersion === 1) { delete oldTask.priority; delete oldTask.kind; }
      const legacy = JSON.stringify({ schemaVersion, timezone: "Asia/Seoul", settingsVersion: 2, tasks: [oldTask] });
      storage.setItem(key, legacy);
      const demo = createDemoTransport(storage);
      expect(await (await demo.request(`/api/tasks/${task.id}`)).json()).toEqual(task);
      expect(await (await demo.request("/api/journal/2026-11-07")).json()).toMatchObject({ content: "", version: 0 });
      expect(storage.getItem(key)).toBe(legacy);
      expect((await demo.request("/api/journal/2026-11-07", journalMutation("새로운 다이어리"))).status).toBe(200);
      const restored = createDemoTransport(storage);
      expect(JSON.parse(storage.getItem(key) ?? "{}").schemaVersion).toBe(3);
      expect(restored.initialSession.settingsVersion).toBe(2);
      expect(await (await restored.request(`/api/tasks/${task.id}`)).json()).toEqual(task);
      expect(await (await restored.request("/api/journal/2026-11-07")).json()).toMatchObject({ content: "새로운 다이어리", version: 1 });
    }
  });

  it("validates journal content by Unicode points and requires version, request key and CSRF headers", async () => {
    const storage = memoryStorage();
    const demo = createDemoTransport(storage);
    const path = "/api/journal/2026-11-07";
    for (const content of [null, 42, "금지\0문자", "😀".repeat(10001)]) expect((await demo.request(path, journalMutation(content))).status).toBe(422);
    expect((await demo.request("/api/journal/2026-02-30", journalMutation("잘못된 날짜"))).status).toBe(422);
    for (const [header, value, status] of [
      ["If-Match", null, 428], ["If-Match", '"v01"', 422], ["If-Match", '"v2147483647"', 422],
      ["Idempotency-Key", null, 422], ["Idempotency-Key", "bad-key", 422], ["X-CSRF-Token", null, 403], ["Content-Type", "text/plain", 422]
    ] as const) {
      const request = journalMutation("유효한 글");
      const headers = new Headers(request.headers);
      if (value === null) headers.delete(header); else headers.set(header, value);
      expect((await demo.request(path, { ...request, headers })).status).toBe(status);
    }
    expect((await demo.request(path, { ...journalMutation("유효한 글"), body: JSON.stringify({ content: "유효한 글", title: "금지 필드" }) })).status).toBe(422);
    expect(storage.getItem(key)).toBeNull();
    const unicode = "😀".repeat(10000);
    expect((await demo.request(path, journalMutation(unicode))).status).toBe(200);
    expect(await (await createDemoTransport(storage).request(path)).json()).toMatchObject({ content: unicode, version: 1 });
  });

  it("keeps journal writes and replay records atomic when browser storage fails", async () => {
    const storage = memoryStorage();
    const demo = createDemoTransport(storage);
    const path = "/api/journal/2026-11-07";
    const original = await (await demo.request(path, journalMutation("보존할 글"))).json();
    const before = storage.getItem(key);
    const request = journalMutation("재시도할 글", 1);
    const setter = vi.spyOn(storage, "setItem").mockImplementation(() => { throw new Error("Quota exceeded"); });
    expect((await demo.request(path, request)).status).toBe(500);
    expect(storage.getItem(key)).toBe(before);
    expect(await (await demo.request(path)).json()).toEqual(original);
    setter.mockRestore();
    expect((await demo.request(path, request)).status).toBe(200);
    const replay = await createDemoTransport(storage).request(path, request);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ content: "재시도할 글", version: 2 });
  });

  it("refuses to overwrite malformed saved journal text or replay data", async () => {
    const storage = memoryStorage();
    const demo = createDemoTransport(storage);
    const path = "/api/journal/2026-11-07";
    await demo.request(path, journalMutation("보존할 글"));
    const valid = JSON.parse(storage.getItem(key) ?? "{}");
    const entry = valid.journals[0];
    const request = valid.journalRequests[0];
    for (const corrupted of [
      { ...valid, journals: undefined }, { ...valid, journals: [{ ...entry, content: "원문\r\n변형" }] },
      { ...valid, journals: [{ ...entry, version: 0 }] }, { ...valid, journals: [entry, entry] },
      { ...valid, journalRequests: [{ ...request, expiresAt: "invalid" }] },
      { ...valid, journalRequests: [{ ...request, response: { ...entry, content: "다른 글" } }] }
    ]) {
      const raw = JSON.stringify(corrupted);
      storage.setItem(key, raw);
      expect(() => createDemoTransport(storage)).toThrow("손상");
      expect((await demo.request(path)).status).toBe(500);
      expect((await demo.request(path, journalMutation("덮어쓰기 금지", 1))).status).toBe(500);
      expect(storage.getItem(key)).toBe(raw);
    }
  });

  it("never falls through to network requests, including unsupported and absolute paths", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network must not be used"));
    try {
      const demo = createDemoTransport(memoryStorage());
      expect((await demo.request("/api/session")).status).toBe(200);
      expect((await demo.request("/api/journal/2026-11-07", journalMutation("네트워크 없는 글"))).status).toBe(200);
      expect((await demo.request("/api/journal/2026-11-07")).status).toBe(200);
      expect((await demo.request("/api/logout", { method: "POST" })).status).toBe(204);
      expect((await demo.request("/api/auth/sign-in/social", { method: "POST" })).status).toBe(404);
      expect((await demo.request("https://example.test/api/tasks")).status).toBe(404);
      expect((await demo.request("//example.test/api/tasks")).status).toBe(404);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
});
