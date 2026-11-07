import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../src/server/db/schema";
import { csrfToken } from "../../src/server/auth/security";
import { PATCH as settingsRoute } from "../../src/app/api/settings/route";
import { GET as listTasksRoute, POST as createTaskRoute } from "../../src/app/api/tasks/route";
import { GET as getTaskRoute, PATCH as patchTaskRoute } from "../../src/app/api/tasks/[taskId]/route";
import { checked } from "../contract";
import { today } from "../../src/domain/rules";

const testUrl = process.env.PLANNER_TEST_DATABASE_URL;
if (testUrl && (new URL(testUrl).pathname !== "/planner_test_product" || new URL(testUrl).hostname !== "127.0.0.1")) throw new Error("Use only the named loopback disposable test database");
const pool = testUrl ? new Pool({ connectionString: testUrl, max: 6 }) : null;
const pg = pool ? null : new PGlite();
// Both drivers use the same PostgreSQL schema and SQL. Cast only the test driver's result interface.
const db = pg ? drizzle(pg, { schema }) : drizzlePg(pool as Pool, { schema }) as unknown as ReturnType<typeof drizzle<typeof schema>>;
const alice = "20000000-0000-4000-8000-000000000001", bob = "20000000-0000-4000-8000-000000000002";
const config = { baseUrl: "https://planner.example", secret: "synthetic-product-test-secret" };
const settings = (request: Request) => checked(settingsRoute(request), "/api/settings", "patch");
const createTask = (request: Request) => checked(createTaskRoute(request), "/api/tasks", "post");
const listTasks = (request: Request) => checked(listTasksRoute(request), "/api/tasks", "get");
const getTask = (request: Request, context: Parameters<typeof getTaskRoute>[1]) => checked(getTaskRoute(request, context), "/api/tasks/{taskId}", "get");
const patchTask = (request: Request, context: Parameters<typeof patchTaskRoute>[1]) => checked(patchTaskRoute(request, context), "/api/tasks/{taskId}", "patch");
vi.mock("../../src/server/auth/runtime", () => ({ getAuthRuntime: () => ({ db, config }) }));
vi.mock("../../src/server/auth/session", () => ({ resolveSession: async (headers: Headers) => {
  const id = headers.get("cookie");
  if (![alice, bob].includes(id ?? "")) return null;
  const [user] = await db.select().from(schema.user).where(eq(schema.user.id, id ?? ""));
  return { user, session: { id: `session-${id}` } };
} }));
function request(path: string, method: string, body?: unknown, options: { actor?: string; key?: string; version?: number; csrf?: string; origin?: string } = {}) {
  const id = options.actor ?? alice;
  return new Request(`${config.baseUrl}${path}`, { method, headers: {
    cookie: id, origin: options.origin ?? config.baseUrl, "content-type": "application/json",
    "x-csrf-token": options.csrf ?? csrfToken(`session-${id}`, config.secret), "idempotency-key": options.key ?? randomUUID(),
    ...(options.version ? { "if-match": `"v${options.version}"` } : {})
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeAll(async () => {
  if (pool) await migratePg(drizzlePg(pool), { migrationsFolder: "./migrations" });
  else await migrate(db, { migrationsFolder: "./migrations" });
  await db.delete(schema.user).where(inArray(schema.user.id, [alice, bob]));
  await db.insert(schema.user).values([{ id: alice, name: "", email: "a@example.test" }, { id: bob, name: "", email: "b@example.test" }]);
}, 30000);
afterAll(async () => { if (pool) await pool.end(); else await pg?.close(); });

describe("account settings contract and replay", () => {
  it("changes account zone atomically and replays before the old version check", async () => {
    const [original] = await db.insert(schema.tasks).values({ ownerId: alice, title: "calendar preservation", status: "completed", scheduledDate: "2026-11-07", dueDate: "2026-11-08", completedAt: new Date("2026-11-06T15:30:00Z") }).returning();
    const [activity] = await db.insert(schema.taskActivities).values({ ownerId: alice, taskId: original.id, type: "completed", occurredAt: original.completedAt ?? new Date() }).returning();
    const key = randomUUID();
    const first = await settings(request("/api/settings", "PATCH", { timezone: "Asia/Seoul" }, { version: 1, key }));
    expect(first.status).toBe(200); expect(first.headers.get("etag")).toBe('"v2"');
    const expected = await first.json();
    expect(expected).toEqual({ timezone: "Asia/Seoul", version: 2 });
    const replay = await settings(request("/api/settings", "PATCH", { timezone: "Asia/Seoul" }, { version: 1, key }));
    expect(await replay.json()).toEqual(expected);
    expect((await settings(request("/api/settings", "PATCH", { timezone: "UTC" }, { version: 1, key }))).status).toBe(409);
    expect((await settings(request("/api/settings", "PATCH", { timezone: "UTC" }, { version: 1 }))).status).toBe(412);
    const unchanged = await settings(request("/api/settings", "PATCH", { timezone: "Asia/Seoul" }, { version: 2 }));
    expect(unchanged.headers.get("etag")).toBe('"v2"');
    expect((await db.select().from(schema.user).where(eq(schema.user.id, bob)))[0].timezone).toBe("UTC");
    expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, original.id)))[0]).toEqual(original);
    expect((await db.select().from(schema.taskActivities).where(eq(schema.taskActivities.id, activity.id)))[0]).toEqual(activity);
  });
  it("rejects invalid input, missing versions and request protection without consuming keys", async () => {
    for (const body of [{ timezone: "Mars/Base" }, { timezone: "+09:00" }, { timezone: "UTC", unknown: true }]) {
      expect((await settings(request("/api/settings", "PATCH", body, { version: 2 }))).status).toBe(422);
    }
    expect((await settings(request("/api/settings", "PATCH", { timezone: "UTC" }))).status).toBe(428);
    expect((await settings(request("/api/settings", "PATCH", { timezone: "UTC" }, { version: 2, csrf: "wrong" }))).status).toBe(403);
    expect((await settings(request("/api/settings", "PATCH", { timezone: "UTC" }, { version: 2, actor: "anonymous" }))).status).toBe(401);
    expect((await db.select().from(schema.idempotencyRecords))).toHaveLength(2);
  });
});

describe("task API ownership, atomic changes and pagination", () => {
  beforeEach(async () => {
    await db.delete(schema.taskActivities); await db.delete(schema.tasks); await db.delete(schema.idempotencyRecords);
  });
  const context = (id: string) => ({ params: Promise.resolve({ taskId: id }) });
  const create = (body: unknown, options: Parameters<typeof request>[3] = {}) => createTask(request("/api/tasks", "POST", body, options));
  const patch = (id: string, body: unknown, options: Parameters<typeof request>[3] = {}) => patchTask(request(`/api/tasks/${id}`, "PATCH", body, options), context(id));
  it("creates normalized tasks and replays one logical request without duplication", async () => {
    const key = randomUUID();
    const first = await create({ title: "  e\u0301 할 일  " }, { key });
    expect(first.status).toBe(201); expect(first.headers.get("etag")).toBe('"v1"');
    const body = await first.json();
    expect(body).toMatchObject({ title: "é 할 일", status: "open", priority: "medium", kind: "task", isUnprocessed: true, scheduledDate: null, dueDate: null, completedAt: null, version: 1 });
    expect(body.ownerId).toBeUndefined();
    const replay = await create({ title: "é 할 일", scheduledDate: null }, { key });
    expect(await replay.json()).toEqual(body);
    expect((await create({ title: "changed" }, { key })).status).toBe(409);
    expect(await db.select().from(schema.tasks)).toHaveLength(1);
    expect((await create({ title: "other owner" }, { key, actor: bob })).status).toBe(201);
  });
  it("keeps anonymous and other-owner reads/updates private without consuming keys", async () => {
    const task = await (await create({ title: "private" })).json();
    const key = randomUUID();
    for (const actor of [bob, "anonymous"]) {
      const read = await getTask(request(`/api/tasks/${task.id}`, "GET", undefined, { actor }), context(task.id));
      expect(read.status).toBe(actor === bob ? 404 : 401);
      expect((await patch(task.id, { title: "stolen" }, { actor, key, version: 1 })).status).toBe(actor === bob ? 404 : 401);
    }
    expect((await patch(task.id, { title: "safe" }, { key, version: 1, csrf: "bad" })).status).toBe(403);
    expect(await db.select().from(schema.idempotencyRecords)).toHaveLength(1);
    expect((await patch(task.id, { title: "safe" }, { key, version: 1 })).status).toBe(200);
  });
  it("stores priority and kind with validation, version checks and audit activities", async () => {
    for (const body of [{ title: "bad", priority: "urgent" }, { title: "bad", priority: null }, { title: "bad", kind: "note" }, { title: "bad", kind: null }]) {
      expect((await create(body)).status).toBe(422);
    }
    const task = await (await create({ title: "appointment", priority: "high", kind: "appointment" })).json();
    expect(task).toMatchObject({ priority: "high", kind: "appointment", version: 1 });
    for (const body of [{ priority: "urgent" }, { kind: "note" }, { status: "deleted" }, { status: null }]) {
      expect((await patch(task.id, body, { version: 1 })).status).toBe(422);
    }
    expect((await patch(task.id, { priority: "low", kind: "event" }, { actor: bob, version: 1 })).status).toBe(404);
    const key = randomUUID();
    const changed = await patch(task.id, { priority: "low", kind: "event" }, { key, version: 1 });
    expect(await changed.json()).toMatchObject({ priority: "low", kind: "event", version: 2 });
    expect((await patch(task.id, { priority: "low", kind: "event" }, { key, version: 1 })).status).toBe(200);
    expect((await patch(task.id, { priority: "low", kind: "event" }, { version: 2 })).headers.get("etag")).toBe('"v2"');
    expect((await patch(task.id, { priority: "high" }, { version: 1 })).status).toBe(412);
    expect((await db.select().from(schema.taskActivities)).map(item => item.type).sort()).toEqual(["kind_changed", "priority_changed"]);
  });
  it("keeps legacy replay payload hashes and supplies additive task defaults", async () => {
    const key = randomUUID();
    const task = await (await create({ title: "before additive fields" }, { key })).json();
    const record = (await db.select().from(schema.idempotencyRecords).where(eq(schema.idempotencyRecords.key, key)))[0];
    const { priority: _priority, kind: _kind, ...oldBody } = task;
    await db.update(schema.idempotencyRecords).set({ response: { status: 201, body: oldBody, etag: '"v1"' } }).where(eq(schema.idempotencyRecords.key, key));
    const replay = await create({ title: "before additive fields" }, { key });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(task);
    const stored = (await db.select().from(schema.idempotencyRecords).where(eq(schema.idempotencyRecords.key, key)))[0];
    expect(stored.requestHash).toBe(record.requestHash);
    expect(stored.response).toEqual({ status: 201, body: oldBody, etag: '"v1"' });
    expect(await db.select().from(schema.tasks)).toHaveLength(1);
  });
  it("preserves canceled markers, restores tasks and invalidates completion across all states", async () => {
    const date = "2026-01-01";
    const task = await (await create({ title: "state transitions", scheduledDate: date })).json();
    const transition = async (status: string, version: number) => {
      const result = await patch(task.id, { status, isUnprocessed: false }, { version });
      expect(result.status).toBe(200);
      return result.json();
    };
    expect(await transition("completed", 1)).toMatchObject({ status: "completed", version: 2, completedAt: expect.any(String) });
    expect(await transition("canceled", 2)).toMatchObject({ status: "canceled", version: 3, completedAt: null, scheduledDate: date });
    const canceledPage = await listTasks(request(`/api/tasks?view=scheduled&date=${date}`, "GET"));
    expect((await canceledPage.json()).items).toMatchObject([{ id: task.id, status: "canceled" }]);
    const overdueCanceled = await listTasks(request("/api/tasks?view=overdue&date=2026-01-02", "GET"));
    expect((await overdueCanceled.json()).items).toHaveLength(0);
    expect(await transition("open", 3)).toMatchObject({ status: "open", version: 4, completedAt: null });
    expect(await transition("deferred", 4)).toMatchObject({ status: "deferred", version: 5, completedAt: null, scheduledDate: date });
    const deferredPage = await listTasks(request("/api/tasks?view=overdue&date=2026-01-02", "GET"));
    expect((await deferredPage.json()).items).toMatchObject([{ id: task.id, status: "deferred" }]);
    expect(await transition("completed", 5)).toMatchObject({ status: "completed", version: 6, completedAt: expect.any(String) });
    const activities = await db.select().from(schema.taskActivities);
    expect(activities.filter(item => item.type === "completed" && item.invalidatedBy === null)).toHaveLength(1);
    expect(activities.filter(item => item.type === "completed" && item.invalidatedBy !== null)).toHaveLength(1);
    expect(activities.map(item => item.type)).toEqual(expect.arrayContaining(["completion_undone", "canceled", "reopened", "deferred"]));
    expect((await patch(task.id, { status: "canceled" }, { actor: bob, version: 6 })).status).toBe(404);
  });
  it.each(["open", "deferred", "canceled"])("returns an undated processed completion to the inbox when set to %s", async status => {
    const task = await (await create({ title: "undated completion" })).json();
    expect((await patch(task.id, { status: "completed", isUnprocessed: false }, { version: 1 })).status).toBe(200);
    const key = randomUUID();
    expect((await patch(task.id, { status, isUnprocessed: false }, { key, version: 2 })).status).toBe(422);
    const restored = await patch(task.id, { status }, { key, version: 2 });
    expect(restored.status).toBe(200);
    const body = await restored.json();
    expect(body).toMatchObject({ status, scheduledDate: null, completedAt: null, isUnprocessed: true, version: 3 });
    const replay = await patch(task.id, { status }, { key, version: 2 });
    expect(await replay.json()).toEqual(body);
    expect((await patch(task.id, { status }, { version: 3 })).headers.get("etag")).toBe('"v3"');
    const stored = (await db.select().from(schema.idempotencyRecords).where(eq(schema.idempotencyRecords.key, key)))[0];
    expect(stored.requestHash).toBe(createHash("sha256").update(JSON.stringify({ input: { status }, version: 2 })).digest("hex"));
    expect((await (await listTasks(request("/api/tasks?view=inbox", "GET"))).json()).items).toMatchObject([{ id: task.id, status, isUnprocessed: true }]);
    const activities = await db.select().from(schema.taskActivities);
    expect(activities.filter(item => item.type === "processing_changed")).toHaveLength(2);
    expect(activities.filter(item => item.type === "completed" && item.invalidatedBy === null)).toHaveLength(0);
    expect(activities.filter(item => item.type === "completion_undone")).toHaveLength(1);
  });
  it("rejects hiding undated non-completed items and returns a date-cleared item to the inbox", async () => {
    const undated = await (await create({ title: "keep reachable" })).json();
    expect((await patch(undated.id, { isUnprocessed: false }, { version: 1 })).status).toBe(422);
    expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, undated.id)))[0]).toMatchObject({ isUnprocessed: true, version: 1 });
    const dated = await (await create({ title: "date can be removed", scheduledDate: "2026-11-07" })).json();
    expect((await patch(dated.id, { status: "deferred", isUnprocessed: false }, { version: 1 })).status).toBe(200);
    expect((await patch(dated.id, { scheduledDate: null, isUnprocessed: false }, { version: 2 })).status).toBe(422);
    expect(await (await patch(dated.id, { scheduledDate: null }, { version: 2 })).json()).toMatchObject({ scheduledDate: null, status: "deferred", isUnprocessed: true, version: 3 });
    const activities = await db.select().from(schema.taskActivities).where(eq(schema.taskActivities.taskId, dated.id));
    expect(activities.filter(item => item.type === "processing_changed")).toHaveLength(2);
    expect(activities.filter(item => item.type === "scheduled_date_changed")).toHaveLength(1);
  });
  it("increments a version when inbox protection is the only derived change", async () => {
    const [legacy] = await db.insert(schema.tasks).values({ ownerId: alice, title: "legacy undated", isUnprocessed: false }).returning();
    expect(await (await patch(legacy.id, { priority: "medium" }, { version: 1 })).json()).toMatchObject({ isUnprocessed: true, version: 2 });
    expect((await patch(legacy.id, { priority: "medium" }, { version: 2 })).headers.get("etag")).toBe('"v2"');
    expect((await db.select().from(schema.taskActivities)).map(item => item.type)).toEqual(["processing_changed"]);
  });
  it("completes, undoes and completes again atomically with one active completion", async () => {
    const date = today("Asia/Seoul");
    const task = await (await create({ title: "finish", scheduledDate: date })).json();
    const key = randomUUID();
    const completed = await patch(task.id, { status: "completed", isUnprocessed: false }, { key, version: 1 });
    const result = await completed.json(); expect(result.version).toBe(2);
    const replay = await patch(task.id, { status: "completed", isUnprocessed: false }, { key, version: 1 });
    expect(replay.headers.get("etag")).toBe('"v2"'); expect(await replay.json()).toEqual(result);
    expect((await patch(task.id, { status: "completed" }, { version: 2 })).headers.get("etag")).toBe('"v2"');
    const undone = await patch(task.id, { status: "open" }, { version: 2 });
    expect(await undone.json()).toMatchObject({ id: task.id, scheduledDate: date, completedAt: null, isUnprocessed: false, version: 3 });
    expect((await patch(task.id, { status: "completed" }, { version: 3 })).status).toBe(200);
    const activities = await db.select().from(schema.taskActivities);
    expect(activities.filter(item => item.type === "completed" && item.invalidatedBy === null)).toHaveLength(1);
    expect(activities.filter(item => item.type === "completed" && item.invalidatedBy !== null)).toHaveLength(1);
    const list = await listTasks(request(`/api/tasks?view=completed&date=${date}`, "GET"));
    expect((await list.json()).items).toHaveLength(1);
  });
  it("rejects invalid input, stale versions and reused keys without changing tasks or activities", async () => {
    for (const body of [{ title: "" }, { title: "😀".repeat(201) }, { title: "x", scheduledDate: "2026-02-30" }, { title: "x", ownerId: bob }]) expect((await create(body)).status).toBe(422);
    const task = await (await create({ title: "valid" })).json();
    expect((await patch(task.id, {} , { version: 1 })).status).toBe(422);
    expect((await patch(task.id, { title: "missing version" })).status).toBe(428);
    const key = randomUUID();
    expect((await patch(task.id, { title: "winner" }, { key, version: 1 })).status).toBe(200);
    expect((await patch(task.id, { title: "loser" }, { version: 1 })).status).toBe(412);
    expect((await patch(task.id, { title: "winner" }, { key, version: 2 })).status).toBe(409);
    expect((await db.select().from(schema.tasks))[0]).toMatchObject({ title: "winner", version: 2 });
    expect(await db.select().from(schema.taskActivities)).toHaveLength(0);
  });
  it("binds signed cursors to owner and filters, with stable no-duplicate pages", async () => {
    for (let i = 0; i < 5; i++) await create({ title: `item ${i}` });
    await create({ title: "other person" }, { actor: bob });
    const all: string[] = []; let cursor: string | null = null;
    do {
      const response = await listTasks(request(`/api/tasks?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, "GET"));
      expect(response.status).toBe(200);
      const page = await response.json(); all.push(...page.items.map((item: { id: string }) => item.id)); cursor = page.nextCursor;
      if (cursor) {
        expect((await listTasks(request(`/api/tasks?limit=2&cursor=${cursor}`, "GET", undefined, { actor: bob }))).status).toBe(400);
        expect((await listTasks(request(`/api/tasks?limit=3&cursor=${cursor}`, "GET"))).status).toBe(400);
        expect((await listTasks(request(`/api/tasks?limit=2&cursor=${cursor}x`, "GET"))).status).toBe(400);
      }
    } while (cursor);
    expect(all).toHaveLength(5); expect(new Set(all).size).toBe(5);
    expect((await listTasks(request("/api/tasks?view=scheduled", "GET"))).status).toBe(422);
  });
  it("retains one winner for concurrent version changes", async () => {
    const task = await (await create({ title: "race" })).json();
    const responses = await Promise.all([patch(task.id, { status: "completed" }, { version: 1 }), patch(task.id, { title: "other edit" }, { version: 1 })]);
    expect(responses.map(value => value.status).sort()).toEqual([200, 412]);
    expect((await db.select().from(schema.tasks))[0].version).toBe(2);
  });
  it("reuses identical concurrent creations and expires request keys after 24 hours", async () => {
    const key = randomUUID();
    const results = await Promise.all([create({ title: "one" }, { key }), create({ title: "one" }, { key })]);
    expect(results.some(item => item.status === 201)).toBe(true);
    for (const item of results) expect([201, 409]).toContain(item.status);
    expect(await db.select().from(schema.tasks)).toHaveLength(1);
    expect((await create({ title: "one" }, { key })).status).toBe(201);
    await db.update(schema.idempotencyRecords).set({ expiresAt: new Date(Date.now() - 1) });
    expect((await create({ title: "one" }, { key })).status).toBe(201);
    expect(await db.select().from(schema.tasks)).toHaveLength(2);
  });
  it("rolls back task, activity and replay key when an activity write fails", async () => {
    const task = await (await create({ title: "rollback" })).json();
    await db.execute(sql`CREATE FUNCTION reject_test_activity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-test-fault'; END $$`);
    await db.execute(sql`CREATE TRIGGER test_activity_failure BEFORE INSERT ON task_activities FOR EACH ROW EXECUTE FUNCTION reject_test_activity()`);
    const key = randomUUID();
    try {
      const failed = await patch(task.id, { status: "completed" }, { key, version: 1 });
      expect(failed.status).toBe(500);
      expect(JSON.stringify(await failed.json())).not.toContain("synthetic-test-fault");
      expect((await db.select().from(schema.tasks))[0]).toMatchObject({ status: "open", completedAt: null, version: 1 });
      expect(await db.select().from(schema.taskActivities)).toHaveLength(0);
      expect(await db.select().from(schema.idempotencyRecords)).toHaveLength(1);
    } finally {
      await db.execute(sql`DROP TRIGGER test_activity_failure ON task_activities`);
      await db.execute(sql`DROP FUNCTION reject_test_activity()`);
    }
    expect((await patch(task.id, { status: "completed" }, { key, version: 1 })).status).toBe(200);
  });
  it.skipIf(!pool)("rejects an in-flight key held by a separate PostgreSQL connection", async () => {
    const client = await (pool as Pool).connect(), key = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify([alice, "POST", "/api/tasks", key])]);
      const result = await create({ title: "wait" }, { key });
      expect(result.status).toBe(409); expect(result.headers.get("retry-after")).toBe("1");
      expect((await result.json()).code).toBe("REQUEST_IN_PROGRESS");
      expect(await db.select().from(schema.tasks)).toHaveLength(0);
    } finally { await client.query("ROLLBACK"); client.release(); }
    expect((await create({ title: "wait" }, { key })).status).toBe(201);
  });
});
