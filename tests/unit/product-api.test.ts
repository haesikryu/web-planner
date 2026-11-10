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
import { GET as getJournalRoute, PUT as putJournalRoute } from "../../src/app/api/journal/[date]/route";
import { GET as getScheduleRoute, PUT as putScheduleRoute } from "../../src/app/api/schedule/[date]/route";
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
    ...(options.version !== undefined ? { "if-match": `"v${options.version}"` } : {})
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
    const [original] = await db.insert(schema.tasks).values({ ownerId: alice, title: "calendar preservation", status: "completed", scheduledDate: "2026-11-07", dailyOrder: 1, dueDate: "2026-11-08", completedAt: new Date("2026-11-06T15:30:00Z") }).returning();
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

describe("daily journal API contract, ownership and concurrent writes", () => {
  const date = "2026-11-07", otherDate = "2026-11-08";
  const context = (value: string) => ({ params: Promise.resolve({ date: value }) });
  const get = (value = date, options: Parameters<typeof request>[3] = {}) => checked(getJournalRoute(request(`/api/journal/${value}`, "GET", undefined, options), context(value)), "/api/journal/{date}", "get");
  const put = (body: unknown, options: Parameters<typeof request>[3] = {}, value = date) => checked(putJournalRoute(request(`/api/journal/${value}`, "PUT", body, options), context(value)), "/api/journal/{date}", "put");
  beforeEach(async () => { await db.delete(schema.journalEntries); await db.delete(schema.idempotencyRecords); });

  it("reads an empty day without creating a row and keeps first empty saves at version zero", async () => {
    const blank = { date, content: "", version: 0, updatedAt: null };
    const read = await get(); expect(read.status).toBe(200); expect(read.headers.get("etag")).toBe('"v0"');
    expect(await read.json()).toEqual(blank);
    const key = randomUUID();
    expect(await (await put({ content: "" }, { key, version: 0 })).json()).toEqual(blank);
    expect(await db.select().from(schema.journalEntries)).toHaveLength(0);
    expect(await (await put({ content: "first" }, { version: 0 })).json()).toMatchObject({ content: "first", version: 1, updatedAt: expect.any(String) });
    expect(await (await put({ content: "" }, { key, version: 0 })).json()).toEqual(blank);
    expect(await (await get()).json()).toMatchObject({ content: "first", version: 1 });
  });
  it("preserves whitespace and Unicode while normalizing CRLF, replaying and clearing content", async () => {
    const key = randomUUID(), content = "  e\u0301\n한글 😀\r끝 \n";
    const first = await put({ content: "  e\u0301\r\n한글 😀\r끝 \r\n" }, { key, version: 0 });
    expect(first.status).toBe(200); const body = await first.json();
    expect(body).toEqual({ date, content, version: 1, updatedAt: expect.any(String) });
    expect(await (await put({ content }, { key, version: 0 })).json()).toEqual(body);
    expect(await (await put({ content }, { version: 1 })).json()).toEqual(body);
    const cleared = await put({ content: "" }, { version: 1 });
    expect(await cleared.json()).toMatchObject({ date, content: "", version: 2, updatedAt: expect.any(String) });
    expect(await (await get()).json()).toMatchObject({ content: "", version: 2 });
    expect(await db.select().from(schema.journalEntries)).toHaveLength(1);
  });
  it("keeps owners and dates separate without leaking another person's text", async () => {
    const key = randomUUID();
    expect((await put({ content: "alice private" }, { key, version: 0 })).status).toBe(200);
    expect(await (await get(date, { actor: bob })).json()).toEqual({ date, content: "", version: 0, updatedAt: null });
    expect((await put({ content: "bob private" }, { actor: bob, key, version: 0 })).status).toBe(200);
    expect((await put({ content: "other day" }, { key, version: 0 }, otherDate)).status).toBe(200);
    expect(await (await get()).json()).toMatchObject({ content: "alice private", version: 1 });
    expect(await (await get(date, { actor: bob })).json()).toMatchObject({ content: "bob private", version: 1 });
    expect(await (await get(otherDate)).json()).toMatchObject({ content: "other day", version: 1 });
    expect((await put({ content: "stolen", ownerId: bob }, { version: 1 })).status).toBe(422);
    expect((await get(date, { actor: "anonymous" })).status).toBe(401);
    expect((await put({ content: "anonymous" }, { actor: "anonymous", version: 0 })).status).toBe(401);
  });
  it("rejects invalid bodies, dates, CSRF, Origin and version headers without consuming keys", async () => {
    const key = randomUUID();
    for (const body of [{}, { content: null }, { content: 42 }, [], { content: "bad\0text" }, { content: "x".repeat(10001) }, { content: "valid", extra: true }]) {
      expect((await put(body, { key, version: 0 })).status).toBe(422);
    }
    for (const invalidDate of ["0000-01-01", "2026-02-30", "2026-1-01", "10000-01-01"]) {
      expect((await get(invalidDate)).status).toBe(422);
      expect((await put({ content: "valid" }, { key, version: 0 }, invalidDate)).status).toBe(422);
    }
    expect((await put({ content: "valid" }, { key })).status).toBe(428);
    for (const headers of [{ csrf: "bad" }, { origin: "https://other.example" }, { origin: "" }]) {
      expect((await put({ content: "valid" }, { key, version: 0, ...headers })).status).toBe(403);
    }
    for (const header of ['"v00"', 'W/"v0"', '"v-1"', '"v2147483647"', '*']) {
      const invalid = request(`/api/journal/${date}`, "PUT", { content: "valid" }, { key, version: 0 }); invalid.headers.set("if-match", header);
      expect((await checked(putJournalRoute(invalid, context(date)), "/api/journal/{date}", "put")).status).toBe(422);
    }
    expect(await db.select().from(schema.journalEntries)).toHaveLength(0);
    expect(await db.select().from(schema.idempotencyRecords)).toHaveLength(0);
    expect((await put({ content: "valid" }, { key, version: 0 })).status).toBe(200);
  });
  it("accepts 10000 Unicode code points with a journal-only bounded request size", async () => {
    const content = "😀".repeat(10000);
    expect(await (await put({ content }, { version: 0 })).json()).toMatchObject({ content, version: 1 });
    expect((await put({ content: `${content}x` }, { version: 1 })).status).toBe(422);
    expect(await (await put({ content: "\r\n".repeat(10000) }, { version: 1 })).json()).toMatchObject({ content: "\n".repeat(10000), version: 2 });
    const oversized = new Request(`${config.baseUrl}/api/journal/${date}`, {
      method: "PUT", headers: request(`/api/journal/${date}`, "PUT", undefined, { version: 2 }).headers,
      body: JSON.stringify({ content: "ok" }) + " ".repeat(65536)
    });
    expect((await checked(putJournalRoute(oversized, context(date)), "/api/journal/{date}", "put")).status).toBe(422);
    expect(await (await get()).json()).toMatchObject({ content: "\n".repeat(10000), version: 2 });
  });
  it("uses replay before version checks and preserves journal content on stale or reused requests", async () => {
    const key = randomUUID();
    const first = await (await put({ content: "one" }, { key, version: 0 })).json();
    expect((await put({ content: "different" }, { key, version: 0 })).status).toBe(409);
    expect((await put({ content: "one" }, { key, version: 1 })).status).toBe(409);
    expect((await put({ content: "two" }, { version: 0 })).status).toBe(412);
    expect((await put({ content: "two" }, { version: 1 })).status).toBe(200);
    expect(await (await put({ content: "one" }, { key, version: 0 })).json()).toEqual(first);
    await db.update(schema.idempotencyRecords).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(schema.idempotencyRecords.key, key));
    expect((await put({ content: "one" }, { key, version: 0 })).status).toBe(412);
    expect(await (await get()).json()).toMatchObject({ content: "two", version: 2 });
    expect((await put({ content: "three" }, { key, version: 2 })).status).toBe(200);
    expect(await (await get()).json()).toMatchObject({ content: "three", version: 3 });
  });
  it("serializes first writes and updates so only one matching version wins", async () => {
    const first = await Promise.all([put({ content: "first writer" }, { version: 0 }), put({ content: "second writer" }, { version: 0 })]);
    expect(first.map(item => item.status).sort()).toEqual([200, 412]);
    const changed = await Promise.all([put({ content: "next writer" }, { version: 1 }), put({ content: "another writer" }, { version: 1 })]);
    expect(changed.map(item => item.status).sort()).toEqual([200, 412]);
    expect(await db.select().from(schema.journalEntries)).toHaveLength(1);
    expect(await (await get()).json()).toMatchObject({ version: 2 });
  });
  it("replays identical simultaneous first saves without creating another version", async () => {
    const key = randomUUID();
    const responses = await Promise.all([put({ content: "same" }, { key, version: 0 }), put({ content: "same" }, { key, version: 0 })]);
    expect(responses.some(item => item.status === 200)).toBe(true);
    for (const item of responses) expect([200, 409]).toContain(item.status);
    expect(await (await put({ content: "same" }, { key, version: 0 })).json()).toMatchObject({ content: "same", version: 1 });
    expect(await db.select().from(schema.journalEntries)).toHaveLength(1);
  });
  it("rolls back the journal and replay key when saving the response fails", async () => {
    await db.execute(sql`CREATE FUNCTION reject_journal_response() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-journal-fault'; END $$`);
    await db.execute(sql`CREATE TRIGGER journal_response_failure BEFORE UPDATE ON idempotency_records FOR EACH ROW EXECUTE FUNCTION reject_journal_response()`);
    const key = randomUUID();
    try {
      const failed = await put({ content: "must roll back" }, { key, version: 0 });
      expect(failed.status).toBe(500); expect(JSON.stringify(await failed.json())).not.toContain("synthetic-journal-fault");
      expect(await db.select().from(schema.journalEntries)).toHaveLength(0);
      expect(await db.select().from(schema.idempotencyRecords)).toHaveLength(0);
    } finally {
      await db.execute(sql`DROP TRIGGER journal_response_failure ON idempotency_records`);
      await db.execute(sql`DROP FUNCTION reject_journal_response()`);
    }
    expect((await put({ content: "must roll back" }, { key, version: 0 })).status).toBe(200);
  });
  it.skipIf(!pool)("returns a retryable response while another connection holds the date lock", async () => {
    const client = await (pool as Pool).connect(), key = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify(["journal", alice, date])]);
      const response = await put({ content: "wait for date" }, { key, version: 0 });
      expect(response.status).toBe(409); expect(response.headers.get("retry-after")).toBe("1");
      expect((await response.json()).code).toBe("REQUEST_IN_PROGRESS");
      expect(await db.select().from(schema.journalEntries)).toHaveLength(0);
      expect(await db.select().from(schema.idempotencyRecords)).toHaveLength(0);
    } finally { await client.query("ROLLBACK"); client.release(); }
    expect((await put({ content: "wait for date" }, { key, version: 0 })).status).toBe(200);
  });
});

describe("daily schedule API contract and isolation", () => {
  const date = "2026-11-07", otherDate = "2026-11-08";
  const context = (value: string) => ({ params: Promise.resolve({ date: value }) });
  const get = (value = date, options: Parameters<typeof request>[3] = {}) => checked(getScheduleRoute(request(`/api/schedule/${value}`, "GET", undefined, options), context(value)), "/api/schedule/{date}", "get");
  const put = (body: unknown, options: Parameters<typeof request>[3] = {}, value = date) => checked(putScheduleRoute(request(`/api/schedule/${value}`, "PUT", body, options), context(value)), "/api/schedule/{date}", "put");
  beforeEach(async () => { await db.delete(schema.scheduleEntries); await db.delete(schema.idempotencyRecords); });
  it("returns a virtual empty day, normalizes slots and preserves no-op versions before clearing", async () => {
    const blank = { date, slots: [], version: 0, updatedAt: null };
    expect(await (await get()).json()).toEqual(blank);
    expect(await (await put({ slots: [] }, { version: 0 })).json()).toEqual(blank);
    expect(await db.select().from(schema.scheduleEntries)).toHaveLength(0);
    const tasksBefore = await db.select().from(schema.tasks), journalBefore = await db.select().from(schema.journalEntries);
    const key = randomUUID(), input = [{ startMinute: 1410, title: "마지막" }, { startMinute: 360, title: " e\u0301 " }];
    const first = await (await put({ slots: input }, { key, version: 0 })).json();
    expect(first).toEqual({ date, slots: [{ startMinute: 360, title: "é" }, { startMinute: 1410, title: "마지막" }], version: 1, updatedAt: expect.any(String) });
    expect(await (await put({ slots: first.slots }, { key, version: 0 })).json()).toEqual(first);
    expect(await (await put({ slots: input }, { version: 1 })).json()).toEqual(first);
    expect(await (await put({ slots: [] }, { version: 1 })).json()).toMatchObject({ slots: [], version: 2 });
    expect(await (await get()).json()).toMatchObject({ slots: [], version: 2 });
    expect(await db.select().from(schema.scheduleEntries)).toHaveLength(1);
    expect(await db.select().from(schema.tasks)).toEqual(tasksBefore);
    expect(await db.select().from(schema.journalEntries)).toEqual(journalBefore);
  });
  it("isolates owners and dates and requires auth, origin, CSRF and canonical versions", async () => {
    const key = randomUUID(), slots = [{ startMinute: 360, title: "private" }];
    expect((await put({ slots }, { key, version: 0 })).status).toBe(200);
    expect(await (await get(date, { actor: bob })).json()).toMatchObject({ slots: [], version: 0 });
    expect((await put({ slots: [{ startMinute: 390, title: "bob" }] }, { key, actor: bob, version: 0 })).status).toBe(200);
    expect((await put({ slots }, { key, version: 0 }, otherDate)).status).toBe(200);
    expect(await (await get()).json()).toMatchObject({ slots, version: 1 });
    expect((await get(date, { actor: "anonymous" })).status).toBe(401);
    expect((await put({ slots }, { actor: "anonymous", version: 1 })).status).toBe(401);
    expect((await put({ slots }, { version: 1, csrf: "bad" })).status).toBe(403);
    expect((await put({ slots }, { version: 1, origin: "https://other.example" })).status).toBe(403);
    expect((await put({ slots })).status).toBe(428);
    const invalid = request(`/api/schedule/${date}`, "PUT", { slots }, { version: 1 }); invalid.headers.set("if-match", '"v00"');
    expect((await checked(putScheduleRoute(invalid, context(date)), "/api/schedule/{date}", "put")).status).toBe(422);
  });
  it("rejects invalid dates and slot documents without consuming keys", async () => {
    const key = randomUUID();
    for (const body of [{}, { slots: null }, { slots: {} }, { slots: [], ownerId: bob }, { slots: [{ startMinute: 360, title: " " }] }, { slots: [{ startMinute: 360, title: "line\nbreak" }] }, { slots: [{ startMinute: 1440, title: "late" }] }, { slots: [{ startMinute: 361, title: "offset" }] }, { slots: [{ startMinute: 360, title: "one" }, { startMinute: 360, title: "duplicate" }] }]) {
      expect((await put(body, { key, version: 0 })).status).toBe(422);
    }
    for (const invalidDate of ["0000-01-01", "2026-02-30", "2026-1-01"]) {
      expect((await get(invalidDate)).status).toBe(422);
      expect((await put({ slots: [] }, { key, version: 0 }, invalidDate)).status).toBe(422);
    }
    expect(await db.select().from(schema.scheduleEntries)).toHaveLength(0);
    expect(await db.select().from(schema.idempotencyRecords)).toHaveLength(0);
    const slots = Array.from({ length: 36 }, (_, i) => ({ startMinute: 360 + i * 30, title: "😀".repeat(200) }));
    expect(await (await put({ slots }, { key, version: 0 })).json()).toMatchObject({ slots, version: 1 });
  });
  it("replays before stale version checks and expires keys after 24 hours", async () => {
    const key = randomUUID(), slots = [{ startMinute: 360, title: "first" }];
    const first = await (await put({ slots }, { key, version: 0 })).json();
    expect((await put({ slots: [] }, { key, version: 0 })).status).toBe(409);
    expect((await put({ slots }, { key, version: 1 })).status).toBe(409);
    expect((await put({ slots: [] }, { version: 0 })).status).toBe(412);
    expect((await put({ slots: [] }, { version: 1 })).status).toBe(200);
    expect(await (await put({ slots }, { key, version: 0 })).json()).toEqual(first);
    await db.update(schema.idempotencyRecords).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(schema.idempotencyRecords.key, key));
    expect((await put({ slots }, { key, version: 0 })).status).toBe(412);
    expect(await (await put({ slots }, { key, version: 2 })).json()).toMatchObject({ version: 3 });
  });
  it("serializes first writes and concurrent changes and replays duplicate requests", async () => {
    const a = [{ startMinute: 360, title: "A" }], b = [{ startMinute: 390, title: "B" }];
    const first = await Promise.all([put({ slots: a }, { version: 0 }), put({ slots: b }, { version: 0 })]);
    expect(first.map(item => item.status).sort()).toEqual([200, 412]);
    const changed = await Promise.all([put({ slots: [{ startMinute: 420, title: "C" }] }, { version: 1 }), put({ slots: [{ startMinute: 450, title: "D" }] }, { version: 1 })]);
    expect(changed.map(item => item.status).sort()).toEqual([200, 412]);
    const key = randomUUID();
    const duplicate = await Promise.all([put({ slots: a }, { key, version: 2 }), put({ slots: a }, { key, version: 2 })]);
    expect(duplicate.some(item => item.status === 200)).toBe(true);
    for (const item of duplicate) expect([200, 409]).toContain(item.status);
    expect(await (await put({ slots: a }, { key, version: 2 })).json()).toMatchObject({ slots: a, version: 3 });
    expect(await db.select().from(schema.scheduleEntries)).toHaveLength(1);
  });
  it("rolls back schedule and key together when response persistence fails", async () => {
    await db.execute(sql`CREATE FUNCTION reject_schedule_response() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-schedule-fault'; END $$`);
    await db.execute(sql`CREATE TRIGGER schedule_response_failure BEFORE UPDATE ON idempotency_records FOR EACH ROW EXECUTE FUNCTION reject_schedule_response()`);
    const key = randomUUID(), slots = [{ startMinute: 360, title: "rollback" }];
    try {
      const failed = await put({ slots }, { key, version: 0 });
      expect(failed.status).toBe(500); expect(JSON.stringify(await failed.json())).not.toContain("synthetic-schedule-fault");
      expect(await db.select().from(schema.scheduleEntries)).toHaveLength(0);
      expect(await db.select().from(schema.idempotencyRecords)).toHaveLength(0);
    } finally {
      await db.execute(sql`DROP TRIGGER schedule_response_failure ON idempotency_records`);
      await db.execute(sql`DROP FUNCTION reject_schedule_response()`);
    }
    expect((await put({ slots }, { key, version: 0 })).status).toBe(200);
  });
  it.skipIf(!pool)("returns a retryable response while another connection holds the schedule lock", async () => {
    const client = await (pool as Pool).connect(), key = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify(["schedule", alice, date])]);
      const response = await put({ slots: [{ startMinute: 360, title: "wait" }] }, { key, version: 0 });
      expect(response.status).toBe(409); expect(response.headers.get("retry-after")).toBe("1");
      expect(await db.select().from(schema.scheduleEntries)).toHaveLength(0);
      expect(await db.select().from(schema.idempotencyRecords)).toHaveLength(0);
    } finally { await client.query("ROLLBACK"); client.release(); }
    expect((await put({ slots: [{ startMinute: 360, title: "wait" }] }, { key, version: 0 })).status).toBe(200);
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
  it("allows processed creation only with a date and counts completed and canceled tasks in day view", async () => {
    const date = "2026-11-07";
    expect((await create({ title: "hidden", isUnprocessed: false })).status).toBe(422);
    expect((await create({ title: "hidden", scheduledDate: null, isUnprocessed: false })).status).toBe(422);
    expect((await create({ title: "invalid", scheduledDate: date, isUnprocessed: "false" })).status).toBe(422);
    const items = [];
    for (let i = 0; i < 5; i++) items.push(await (await create({ title: `day ${i}`, scheduledDate: date, isUnprocessed: false })).json());
    expect(items[0]).toMatchObject({ scheduledDate: date, isUnprocessed: false });
    expect((await patch(items[0].id, { status: "completed" }, { version: 1 })).status).toBe(200);
    expect((await patch(items[1].id, { status: "canceled" }, { version: 1 })).status).toBe(200);
    const day = await (await listTasks(request(`/api/tasks?view=day&date=${date}`, "GET"))).json();
    expect(day.items).toHaveLength(5);
    expect(day.items.map((item: { status: string }) => item.status)).toEqual(expect.arrayContaining(["completed", "canceled"]));
    const scheduled = await (await listTasks(request(`/api/tasks?view=scheduled&date=${date}`, "GET"))).json();
    expect(scheduled.items).toHaveLength(4);
    const key = randomUUID(), limited = await create({ title: "sixth", scheduledDate: date }, { key });
    expect(limited.status).toBe(422); expect(await limited.json()).toMatchObject({ code: "DAILY_TASK_LIMIT" });
    expect(await db.select().from(schema.idempotencyRecords).where(eq(schema.idempotencyRecords.key, key))).toHaveLength(0);
    expect((await create({ title: "other owner", scheduledDate: date, isUnprocessed: false }, { actor: bob })).status).toBe(201);
    expect((await listTasks(request("/api/tasks?view=day", "GET"))).status).toBe(422);
  });
  it("preserves legacy over-limit days while allowing same-day edits and moves out", async () => {
    const date = "2026-11-07";
    const legacy = await db.insert(schema.tasks).values(Array.from({ length: 6 }, (_, i) => ({ ownerId: alice, title: `legacy ${i}`, scheduledDate: date, dailyOrder: i + 1, isUnprocessed: false }))).returning();
    expect((await patch(legacy[0].id, { title: "edited", scheduledDate: date }, { version: 1 })).status).toBe(200);
    expect((await patch(legacy[1].id, { status: "completed" }, { version: 1 })).status).toBe(200);
    const incoming = await (await create({ title: "inbox" })).json();
    const denied = await patch(incoming.id, { scheduledDate: date, isUnprocessed: false }, { version: 1 });
    expect(denied.status).toBe(422); expect(await denied.json()).toMatchObject({ code: "DAILY_TASK_LIMIT" });
    expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, incoming.id)))[0]).toMatchObject({ version: 1, scheduledDate: null, isUnprocessed: true });
    expect((await patch(legacy[2].id, { scheduledDate: "2026-11-08" }, { version: 1 })).status).toBe(200);
    expect((await (await listTasks(request(`/api/tasks?view=day&date=${date}`, "GET"))).json()).items).toHaveLength(5);
  });
  it("replays a successful fifth task without applying the daily limit again", async () => {
    const date = "2026-11-07", key = randomUUID();
    for (let i = 0; i < 4; i++) await create({ title: `existing ${i}`, scheduledDate: date });
    const input = { title: "fifth", scheduledDate: date, isUnprocessed: false };
    const first = await (await create(input, { key })).json();
    expect(await (await create(input, { key })).json()).toEqual(first);
    expect(await db.select().from(schema.tasks)).toHaveLength(5);
  });
  it("serializes simultaneous creates, moves and mixed arrivals into the fifth place", async () => {
    for (const mode of ["create", "move", "mixed"]) {
      await db.delete(schema.taskActivities); await db.delete(schema.tasks); await db.delete(schema.idempotencyRecords);
      const date = "2026-11-07";
      for (let i = 0; i < 4; i++) await create({ title: `existing ${i}`, scheduledDate: date });
      const a = await (await create({ title: "incoming A" })).json(), b = await (await create({ title: "incoming B" })).json();
      const createIncoming = () => create({ title: "new", scheduledDate: date, isUnprocessed: false });
      const move = (id: string) => patch(id, { scheduledDate: date, isUnprocessed: false }, { version: 1 });
      const responses = await Promise.all(mode === "create" ? [createIncoming(), createIncoming()] : mode === "move" ? [move(a.id), move(b.id)] : [createIncoming(), move(a.id)]);
      expect(responses.filter(response => response.status === 200 || response.status === 201)).toHaveLength(1);
      const denied = responses.find(response => response.status === 422);
      expect(denied).toBeDefined(); expect(await denied?.json()).toMatchObject({ code: "DAILY_TASK_LIMIT" });
      expect((await (await listTasks(request(`/api/tasks?view=day&date=${date}`, "GET"))).json()).items).toHaveLength(5);
    }
  });
  it("appends day order and atomically swaps adjacent tasks without changing their content or status", async () => {
    const date = "2026-11-07";
    const a = await (await create({ title: "A", scheduledDate: date })).json();
    const b = await (await create({ title: "B", scheduledDate: date })).json();
    const c = await (await create({ title: "C", scheduledDate: date })).json();
    expect([a.dailyOrder, b.dailyOrder, c.dailyOrder]).toEqual([1, 2, 3]);
    const key = randomUUID(), moved = await (await patch(b.id, { move: "up" }, { key, version: 1 })).json();
    expect(moved).toMatchObject({ id: b.id, title: "B", dailyOrder: 1, version: 2, status: "open" });
    const neighbor = await (await getTask(request(`/api/tasks/${a.id}`, "GET"), context(a.id))).json();
    expect(neighbor).toMatchObject({ id: a.id, dailyOrder: 2, version: 2, title: "A", status: "open" });
    expect(neighbor.updatedAt).toBe(moved.updatedAt);
    expect(await (await patch(b.id, { move: "up" }, { key, version: 1 })).json()).toEqual(moved);
    expect(await (await patch(b.id, { move: "up" }, { version: 2 })).json()).toEqual(moved);
    expect((await patch(a.id, { title: "stale" }, { version: 1 })).status).toBe(412);
    const changed = await (await patch(a.id, { title: "updated", priority: "low", status: "canceled" }, { version: 2 })).json();
    expect(changed).toMatchObject({ dailyOrder: 2, version: 3, status: "canceled" });
    expect(await (await patch(c.id, { move: "down" }, { version: 1 })).json()).toMatchObject({ dailyOrder: 3, version: 1 });
    const day = await (await listTasks(request(`/api/tasks?view=day&date=${date}`, "GET"))).json();
    expect(day.items.map((task: { id: string }) => task.id)).toEqual([b.id, a.id, c.id]);
    expect((await db.select().from(schema.taskActivities)).filter(item => item.type === "order_changed")).toHaveLength(2);
  });
  it("inserts a dragged row at the target position and atomically shifts the whole range with gaps intact", async () => {
    const date = "2026-11-07", items = [];
    for (const title of ["A", "B", "C", "D", "E"]) items.push(await (await create({ title, scheduledDate: date })).json());
    await patch(items[1].id, { scheduledDate: null }, { version: 1 });
    const completed = await (await patch(items[2].id, { status: "completed" }, { version: 1 })).json();
    const canceled = await (await patch(items[3].id, { status: "canceled" }, { version: 1 })).json();
    const key = randomUUID(), input = { moveTo: items[3].id.toUpperCase() };
    const response = await patch(items[0].id, input, { key, version: 1 });
    expect(response.status).toBe(200); expect(response.headers.get("etag")).toBe('"v2"');
    const moved = await response.json();
    expect(moved).toMatchObject({ id: items[0].id, dailyOrder: 4, version: 2 });
    const list = async () => (await (await listTasks(request(`/api/tasks?view=day&date=${date}`, "GET"))).json()).items;
    const day = await list();
    expect(day.map((task: { id: string; dailyOrder: number }) => [task.id, task.dailyOrder])).toEqual([[items[2].id, 1], [items[3].id, 3], [items[0].id, 4], [items[4].id, 5]]);
    expect(day[0]).toEqual({ ...completed, dailyOrder: 1, version: 3, updatedAt: moved.updatedAt });
    expect(day[1]).toEqual({ ...canceled, dailyOrder: 3, version: 3, updatedAt: moved.updatedAt });
    expect(day[3]).toEqual(items[4]);
    expect((await db.select().from(schema.taskActivities)).filter(item => item.type === "completed" && item.invalidatedBy === null)).toHaveLength(1);
    expect((await db.select().from(schema.taskActivities)).filter(item => item.type === "order_changed")).toHaveLength(3);
    expect((await patch(items[2].id, { title: "stale middle" }, { version: 2 })).status).toBe(412);
    expect((await patch(items[0].id, { moveTo: items[2].id }, { version: 2 })).status).toBe(200);
    const restored = await list();
    expect(restored.map((task: { id: string }) => task.id)).toEqual([items[0].id, items[2].id, items[3].id, items[4].id]);
    expect(await (await patch(items[0].id, { moveTo: items[3].id }, { key, version: 1 })).json()).toEqual(moved);
    expect(await list()).toEqual(restored);
    expect((await patch(items[0].id, { moveTo: items[2].id }, { key, version: 1 })).status).toBe(409);
    expect((await db.select().from(schema.taskActivities)).filter(item => item.type === "order_changed")).toHaveLength(6);
  });
  it("validates isolated drag targets and makes self drops replayable no-ops", async () => {
    const date = "2026-11-07", a = await (await create({ title: "A", scheduledDate: date })).json();
    const otherDay = await (await create({ title: "other day", scheduledDate: "2026-11-08" })).json();
    const undated = await (await create({ title: "undated" })).json();
    const privateTarget = await (await create({ title: "private", scheduledDate: date }, { actor: bob })).json();
    const key = randomUUID(), before = await db.select().from(schema.tasks).orderBy(schema.tasks.id);
    for (const input of [{ moveTo: null }, { moveTo: "invalid" }, { moveTo: a.id, move: "up" }, { moveTo: a.id, title: "hidden change" }, { moveTo: otherDay.id }, { moveTo: undated.id }]) {
      expect((await patch(a.id, input, { key, version: 1 })).status).toBe(422);
    }
    for (const target of [randomUUID(), privateTarget.id]) expect((await patch(a.id, { moveTo: target }, { key, version: 1 })).status).toBe(404);
    expect((await patch(a.id, { moveTo: a.id }, { key, version: 1, actor: bob })).status).toBe(404);
    expect((await patch(undated.id, { moveTo: a.id }, { key, version: 1 })).status).toBe(422);
    expect((await create({ title: "invalid", moveTo: a.id })).status).toBe(422);
    expect(await db.select().from(schema.idempotencyRecords).where(eq(schema.idempotencyRecords.key, key))).toHaveLength(0);
    expect(await db.select().from(schema.tasks).orderBy(schema.tasks.id)).toEqual(before);
    expect(await (await patch(a.id, { moveTo: a.id }, { key, version: 1 })).json()).toEqual(a);
    await patch(a.id, { title: "later title" }, { version: 1 });
    expect(await (await patch(a.id, { moveTo: a.id }, { key, version: 1 })).json()).toEqual(a);
    expect((await db.select().from(schema.taskActivities)).filter(item => item.type === "order_changed")).toHaveLength(0);
  });
  it("serializes overlapping long-range drags and rolls back every shifted row on a fault", async () => {
    const date = "2026-11-07", items = [];
    for (const title of ["A", "B", "C", "D"]) items.push(await (await create({ title, scheduledDate: date })).json());
    const responses = await Promise.all([patch(items[0].id, { moveTo: items[3].id }, { version: 1 }), patch(items[3].id, { moveTo: items[0].id }, { version: 1 })]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 412]);
    const before = await db.select().from(schema.tasks).orderBy(schema.tasks.dailyOrder);
    expect(before.map(task => task.version)).toEqual([2, 2, 2, 2]);
    expect(before.map(task => task.dailyOrder)).toEqual([1, 2, 3, 4]);
    const activities = await db.select().from(schema.taskActivities).orderBy(schema.taskActivities.id), key = randomUUID();
    expect(activities).toHaveLength(4);
    await db.execute(sql`CREATE FUNCTION reject_drag_activity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-drag-fault'; END $$`);
    await db.execute(sql`CREATE TRIGGER drag_activity_failure BEFORE INSERT ON task_activities FOR EACH ROW EXECUTE FUNCTION reject_drag_activity()`);
    try {
      expect((await patch(before[0].id, { moveTo: before[3].id }, { key, version: 2 })).status).toBe(500);
      expect(await db.select().from(schema.tasks).orderBy(schema.tasks.dailyOrder)).toEqual(before);
      expect(await db.select().from(schema.taskActivities).orderBy(schema.taskActivities.id)).toEqual(activities);
      expect(await db.select().from(schema.idempotencyRecords).where(eq(schema.idempotencyRecords.key, key))).toHaveLength(0);
    } finally { await db.execute(sql`DROP TRIGGER drag_activity_failure ON task_activities`); await db.execute(sql`DROP FUNCTION reject_drag_activity()`); }
    expect(await (await patch(before[0].id, { moveTo: before[3].id }, { key, version: 2 })).json()).toMatchObject({ dailyOrder: 4, version: 3 });
  });
  it("serializes arbitrary drags with concurrent target transfers and new arrivals without losing rows", async () => {
    const first = "2026-11-07", second = "2026-11-08";
    const a = await (await create({ title: "A", scheduledDate: first })).json();
    const b = await (await create({ title: "B", scheduledDate: first })).json();
    const c = await (await create({ title: "C", scheduledDate: first })).json();
    const d = await (await create({ title: "D", scheduledDate: second })).json();
    const responses = await Promise.all([
      patch(a.id, { moveTo: c.id }, { version: 1 }), patch(c.id, { scheduledDate: second }, { version: 1 }),
      patch(d.id, { scheduledDate: first }, { version: 1 }), patch(b.id, { moveTo: a.id }, { version: 1 }),
      create({ title: "E", scheduledDate: first })
    ]);
    for (const response of responses) {
      expect([200, 201, 412, 422]).toContain(response.status);
      if (response.status === 422) expect(await response.json()).toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(responses[2].status).toBe(200); expect(responses[4].status).toBe(201);
    const all = await db.select().from(schema.tasks);
    expect(all.map(task => task.title).sort()).toEqual(["A", "B", "C", "D", "E"]);
    for (const date of [first, second]) {
      const day = all.filter(task => task.scheduledDate === date);
      expect(day.length).toBeLessThanOrEqual(5);
      expect(new Set(day.map(task => task.dailyOrder)).size).toBe(day.length);
      expect(day.every(task => (task.dailyOrder ?? 0) > 0)).toBe(true);
    }
  });
  it("keeps gaps and appends moved tasks after the destination's maximum order", async () => {
    const date = "2026-11-07", other = "2026-11-08";
    const a = await (await create({ title: "A", scheduledDate: date })).json();
    const b = await (await create({ title: "B", scheduledDate: date })).json();
    const c = await (await create({ title: "C", scheduledDate: date })).json();
    await create({ title: "destination", scheduledDate: other });
    expect(await (await patch(b.id, { scheduledDate: other }, { version: 1 })).json()).toMatchObject({ dailyOrder: 2, version: 2 });
    const d = await (await create({ title: "D", scheduledDate: date })).json();
    expect(d.dailyOrder).toBe(4);
    expect(await (await patch(c.id, { scheduledDate: null }, { version: 1 })).json()).toMatchObject({ dailyOrder: null, scheduledDate: null, version: 2 });
    expect(await (await patch(c.id, { scheduledDate: other }, { version: 2 })).json()).toMatchObject({ dailyOrder: 3, version: 3 });
    expect((await (await listTasks(request(`/api/tasks?view=day&date=${date}`, "GET"))).json()).items.map((item: { id: string; dailyOrder: number }) => [item.id, item.dailyOrder])).toEqual([[a.id, 1], [d.id, 4]]);
  });
  it("preserves an existing deadline when rescheduling, clearing and reassigning the execution date", async () => {
    // Deadline editing is outside the current API; exercise preservation of a persisted non-null value.
    const dueDate = "2026-11-10";
    const [original] = await db.insert(schema.tasks).values({ ownerId: alice, title: "fixed deadline", scheduledDate: "2026-11-07", dailyOrder: 1, dueDate, isUnprocessed: false }).returning();
    const firstKey = randomUUID();
    let firstResponse: unknown;
    for (const [index, scheduledDate] of ["2026-11-12", null, "2026-11-08"].entries()) {
      const version = index + 1;
      const result = await patch(original.id, { scheduledDate }, { version, ...(index === 0 ? { key: firstKey } : {}) });
      expect(result.status).toBe(200); expect(result.headers.get("etag")).toBe(`"v${version + 1}"`);
      const body = await result.json();
      expect(body).toMatchObject({ id: original.id, scheduledDate, dueDate, dailyOrder: scheduledDate === null ? null : 1, version: version + 1 });
      if (index === 0) firstResponse = body;
      const read = await getTask(request(`/api/tasks/${original.id}`, "GET"), context(original.id));
      expect(read.status).toBe(200); expect(read.headers.get("etag")).toBe(result.headers.get("etag"));
      expect(await read.json()).toEqual(body);
      const page = await listTasks(request(scheduledDate === null ? "/api/tasks?view=inbox" : `/api/tasks?view=day&date=${scheduledDate}`, "GET"));
      expect((await page.json()).items).toEqual([body]);
      expect(await db.select().from(schema.tasks)).toMatchObject([{ id: original.id, ownerId: alice, scheduledDate, dueDate, version: version + 1 }]);
    }
    const saved = (await db.select().from(schema.tasks))[0];
    const replay = await patch(original.id, { scheduledDate: "2026-11-12" }, { version: 1, key: firstKey });
    expect(replay.status).toBe(200); expect(replay.headers.get("etag")).toBe('"v2"');
    expect(await replay.json()).toEqual(firstResponse);
    expect(await db.select().from(schema.tasks)).toEqual([saved]);
    expect((await db.select().from(schema.taskActivities)).filter(activity => activity.type === "scheduled_date_changed")).toHaveLength(3);
  });
  it("preserves the deadline and original row when a reschedule is rejected by capacity or version", async () => {
    const destination = "2026-11-12", dueDate = "2026-11-10";
    const [original] = await db.insert(schema.tasks).values({ ownerId: alice, title: "deadline survives rejected move", scheduledDate: "2026-11-07", dailyOrder: 1, dueDate, isUnprocessed: false }).returning();
    for (let i = 0; i < 5; i++) await create({ title: `destination ${i}`, scheduledDate: destination });
    const key = randomUUID();
    const capacity = await patch(original.id, { scheduledDate: destination }, { version: 1, key });
    expect(capacity.status).toBe(422); expect((await capacity.json()).code).toBe("DAILY_TASK_LIMIT");
    expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, original.id)))[0]).toEqual(original);
    expect(await db.select().from(schema.idempotencyRecords).where(eq(schema.idempotencyRecords.key, key))).toHaveLength(0);
    expect(await db.select().from(schema.taskActivities).where(eq(schema.taskActivities.taskId, original.id))).toHaveLength(0);
    const changed = await patch(original.id, { scheduledDate: "2026-11-08" }, { version: 1, key });
    expect(changed.status).toBe(200); expect(await changed.json()).toMatchObject({ scheduledDate: "2026-11-08", dueDate, version: 2 });
    const saved = (await db.select().from(schema.tasks).where(eq(schema.tasks.id, original.id)))[0];
    const stale = await patch(original.id, { scheduledDate: null }, { version: 1 });
    expect(stale.status).toBe(412); expect((await stale.json()).code).toBe("VERSION_CONFLICT");
    expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, original.id)))[0]).toEqual(saved);
    const read = await getTask(request(`/api/tasks/${original.id}`, "GET"), context(original.id));
    expect(read.headers.get("etag")).toBe('"v2"');
    expect(await read.json()).toMatchObject({ id: original.id, scheduledDate: "2026-11-08", dueDate, version: 2 });
  });
  it("validates standalone relative moves and owner isolation without consuming rejected keys", async () => {
    const undated = await (await create({ title: "undated" })).json(), key = randomUUID();
    for (const body of [{ move: "left" }, { move: null }, { move: "up", title: "changed" }, { move: "down", scheduledDate: "2026-11-07" }, { dailyOrder: 1 }]) {
      expect((await patch(undated.id, body, { key, version: 1 })).status).toBe(422);
    }
    expect((await patch(undated.id, { move: "up" }, { key, version: 1 })).status).toBe(422);
    expect((await patch(undated.id, { move: "up" }, { key, version: 1, actor: bob })).status).toBe(404);
    expect((await create({ title: "forged", scheduledDate: "2026-11-07", dailyOrder: 10 })).status).toBe(422);
    expect(await db.select().from(schema.idempotencyRecords).where(eq(schema.idempotencyRecords.key, key))).toHaveLength(0);
    expect(await db.select().from(schema.taskActivities)).toHaveLength(0);
  });
  it("paginates day order after swaps with stable tie breakers and owner-bound cursors", async () => {
    const date = "2026-11-07", items = [];
    for (let i = 0; i < 5; i++) items.push(await (await create({ title: `ordered ${i}`, scheduledDate: date })).json());
    await patch(items[4].id, { move: "up" }, { version: 1 });
    const ids: string[] = []; let cursor: string | null = null;
    do {
      const page = await (await listTasks(request(`/api/tasks?view=day&date=${date}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, "GET"))).json();
      ids.push(...page.items.map((item: { id: string }) => item.id)); cursor = page.nextCursor;
      if (cursor) expect((await listTasks(request(`/api/tasks?view=day&date=${date}&limit=2&cursor=${encodeURIComponent(cursor)}`, "GET", undefined, { actor: bob }))).status).toBe(400);
    } while (cursor);
    expect(ids).toEqual([items[0].id, items[1].id, items[2].id, items[4].id, items[3].id]);
  });
  it("preserves old dated replay snapshots when the current task has moved or reordered", async () => {
    const key = randomUUID();
    const task = await (await create({ title: "historical", scheduledDate: "2026-11-07" }, { key })).json();
    const { dailyOrder: _order, ...oldBody } = task;
    await db.update(schema.idempotencyRecords).set({ response: { status: 201, body: oldBody, etag: '"v1"' } }).where(eq(schema.idempotencyRecords.key, key));
    const record = (await db.select().from(schema.idempotencyRecords).where(eq(schema.idempotencyRecords.key, key)))[0];
    await patch(task.id, { scheduledDate: "2026-11-08" }, { version: 1 });
    const replay = await (await create({ title: "historical", scheduledDate: "2026-11-07" }, { key })).json();
    expect(replay).toEqual({ ...oldBody, dailyOrder: null });
    expect((await db.select().from(schema.idempotencyRecords).where(eq(schema.idempotencyRecords.key, key)))[0]).toEqual(record);
    expect((await db.select().from(schema.tasks))[0]).toMatchObject({ scheduledDate: "2026-11-08", dailyOrder: 1, version: 2 });
  });
  it("serializes overlapping reorders so both rows receive exactly one successful swap", async () => {
    const date = "2026-11-07";
    const a = await (await create({ title: "A", scheduledDate: date })).json(), b = await (await create({ title: "B", scheduledDate: date })).json();
    const responses = await Promise.all([patch(a.id, { move: "down" }, { version: 1 }), patch(b.id, { move: "up" }, { version: 1 })]);
    expect(responses.map(item => item.status).sort()).toEqual([200, 412]);
    const rows = await db.select().from(schema.tasks);
    expect(rows.map(row => row.version)).toEqual([2, 2]);
    expect(rows.map(row => row.dailyOrder).sort()).toEqual([1, 2]);
    expect((await db.select().from(schema.taskActivities)).filter(item => item.type === "order_changed")).toHaveLength(2);
  });
  it("keeps date changes, appends and reorders deadlock-free under concurrent writes", async () => {
    const first = "2026-11-07", second = "2026-11-08";
    const a = await (await create({ title: "A", scheduledDate: first })).json(), b = await (await create({ title: "B", scheduledDate: first })).json();
    const c = await (await create({ title: "C", scheduledDate: second })).json(), d = await (await create({ title: "D", scheduledDate: second })).json();
    const responses = await Promise.all([
      patch(a.id, { scheduledDate: second }, { version: 1 }), patch(c.id, { scheduledDate: first }, { version: 1 }),
      patch(b.id, { move: "up" }, { version: 1 }), patch(d.id, { move: "up" }, { version: 1 }),
      create({ title: "appended", scheduledDate: first })
    ]);
    for (const response of responses) expect([200, 201, 412]).toContain(response.status);
    for (const date of [first, second]) {
      const rows = (await db.select().from(schema.tasks)).filter(row => row.scheduledDate === date);
      expect(rows.length).toBeLessThanOrEqual(5);
      expect(new Set(rows.map(row => row.dailyOrder)).size).toBe(rows.length);
      expect(rows.every(row => (row.dailyOrder ?? 0) > 0)).toBe(true);
    }
  });
  it("rolls back both swapped rows and the replay key when an order activity fails", async () => {
    const date = "2026-11-07", key = randomUUID();
    const a = await (await create({ title: "A", scheduledDate: date })).json(), b = await (await create({ title: "B", scheduledDate: date })).json();
    const before = await db.select().from(schema.tasks).orderBy(schema.tasks.id);
    await db.execute(sql`CREATE FUNCTION reject_order_activity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-order-fault'; END $$`);
    await db.execute(sql`CREATE TRIGGER order_activity_failure BEFORE INSERT ON task_activities FOR EACH ROW EXECUTE FUNCTION reject_order_activity()`);
    try {
      expect((await patch(b.id, { move: "up" }, { key, version: 1 })).status).toBe(500);
      expect(await db.select().from(schema.tasks).orderBy(schema.tasks.id)).toEqual(before);
      expect(await db.select().from(schema.taskActivities)).toHaveLength(0);
      expect(await db.select().from(schema.idempotencyRecords).where(eq(schema.idempotencyRecords.key, key))).toHaveLength(0);
    } finally { await db.execute(sql`DROP TRIGGER order_activity_failure ON task_activities`); await db.execute(sql`DROP FUNCTION reject_order_activity()`); }
    expect(await (await patch(b.id, { move: "up" }, { key, version: 1 })).json()).toMatchObject({ dailyOrder: a.dailyOrder, version: 2 });
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
