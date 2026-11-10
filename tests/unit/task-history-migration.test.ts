import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("preserves legacy tasks, activities and replay responses, validates new history snapshots", async () => {
  const db = new PGlite();
  try {
    for (const name of ["0000_auth_and_task_foundation", "0001_active_completion_constraint", "0002_task_priority_kind_and_status", "0003_daily_journal", "0004_daily_schedule", "0005_task_daily_order"]) await db.exec(await readFile(`migrations/${name}.sql`, "utf8"));
    await db.exec("INSERT INTO users (id,name,email) VALUES ('history-owner','','history@example.test')");
    const taskId = "00000000-0000-4000-8000-000000000001";
    await db.query("INSERT INTO tasks (id,owner_id,title,scheduled_date,due_date,daily_order,version) VALUES ($1,'history-owner','original','2026-11-07','2026-11-09',1,7)", [taskId]);
    await db.query("INSERT INTO task_activities (owner_id,task_id,type,occurred_at) VALUES ('history-owner',$1,'scheduled_date_changed','2026-11-01T11:22:33.123456Z')", [taskId]);
    await db.exec("INSERT INTO idempotency_records (owner_id,method,path,key,request_hash,state,response,expires_at) VALUES ('history-owner','POST','/api/tasks','old-key',repeat('a',64),'completed','{\"status\":201,\"body\":{\"title\":\"old\",\"version\":1}}',now()+interval '1 day')");
    const tasks = (await db.query("SELECT to_jsonb(tasks) AS value FROM tasks")).rows;
    const activities = (await db.query("SELECT to_jsonb(task_activities) AS value FROM task_activities")).rows;
    const requests = (await db.query("SELECT * FROM idempotency_records")).rows;
    await db.exec(await readFile("migrations/0006_task_plan_history.sql", "utf8"));
    expect((await db.query("SELECT to_jsonb(tasks) AS value FROM tasks")).rows).toEqual(tasks);
    expect((await db.query("SELECT to_jsonb(task_activities)-'details' AS value FROM task_activities")).rows).toEqual(activities);
    expect((await db.query("SELECT details FROM task_activities")).rows).toEqual([{ details: null }]);
    expect((await db.query("SELECT * FROM idempotency_records")).rows).toEqual(requests);
    const before = { scheduledDate: "2026-11-07", dueDate: "2026-11-09", status: "open", dailyOrder: 1 };
    const valid = { before, after: { ...before, dueDate: null }, version: 8 };
    const insert = (details: unknown, type = "due_date_changed") => db.query("INSERT INTO task_activities (owner_id,task_id,type,details) VALUES ('history-owner',$1,$2,$3::jsonb)", [taskId, type, details === null ? null : JSON.stringify(details)]);
    await insert(valid);
    await insert({ before: null, after: before, version: 1 }, "created");
    for (const invalid of [null, {}, { ...valid, extra: true }, { ...valid, version: 1 }, { ...valid, version: 2.5 }, { ...valid, version: 2147483648 }, { ...valid, before: null }, { ...valid, after: { ...before, dueDate: "2026-02-30" } }, { ...valid, after: { ...before, dueDate: "0000-01-01" } }, { ...valid, after: { ...before, scheduledDate: null } }, { ...valid, after: { ...before, dailyOrder: 0 } }, { ...valid, after: { ...before, status: "hidden" } }, { ...valid, after: { ...before, ownerId: "other" } }]) await expect(insert(invalid)).rejects.toThrow();
    await expect(insert(valid, "created")).rejects.toThrow();
    await expect(insert({ ...valid, version: 8 }, "unknown")).rejects.toThrow();
    await insert({ ...valid, after: { ...before, scheduledDate: null, dailyOrder: null, dueDate: "9999-12-31" } });
    await insert({ ...valid, after: { ...before, dueDate: "0001-01-01" } });
  } finally { await db.close(); }
}, 30000);
