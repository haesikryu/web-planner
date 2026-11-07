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
    expect(JSON.parse(storage.getItem(key) ?? "{}").schemaVersion).toBe(2);
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

  it("never falls through to network requests, including unsupported and absolute paths", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network must not be used"));
    try {
      const demo = createDemoTransport(memoryStorage());
      expect((await demo.request("/api/session")).status).toBe(200);
      expect((await demo.request("/api/logout", { method: "POST" })).status).toBe(204);
      expect((await demo.request("/api/auth/sign-in/social", { method: "POST" })).status).toBe(404);
      expect((await demo.request("https://example.test/api/tasks")).status).toBe(404);
      expect((await demo.request("//example.test/api/tasks")).status).toBe(404);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
});
