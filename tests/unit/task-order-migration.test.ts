import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { taskMove } from "../../src/domain/task-order";

it("validates the two relative task moves", () => {
  expect(taskMove("up")).toBe("up"); expect(taskMove("down")).toBe("down");
  for (const invalid of [null, "first", 1, true, {}]) expect(() => taskMove(invalid)).toThrow("Invalid move");
});

it("backfills stable per-owner day order while preserving every old field, activity and replay", async () => {
  const db = new PGlite();
  try {
    for (const name of ["0000_auth_and_task_foundation", "0001_active_completion_constraint", "0002_task_priority_kind_and_status", "0003_daily_journal", "0004_daily_schedule"]) await db.exec(await readFile(`migrations/${name}.sql`, "utf8"));
    await db.exec("INSERT INTO users (id,name,email) VALUES ('order-owner','','order@example.test'),('other-owner','','other@example.test')");
    await db.exec("INSERT INTO tasks (id,owner_id,title,scheduled_date,priority,kind,version,created_at) SELECT ('00000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,'order-owner','legacy ' || i,'2026-11-07','high','appointment',7,CASE WHEN i=1 THEN '2026-11-02'::timestamptz ELSE '2026-11-01'::timestamptz END FROM generate_series(1,6) i");
    await db.exec("INSERT INTO tasks (owner_id,title,scheduled_date) VALUES ('order-owner','undated',null),('order-owner','other date','2026-11-08'),('other-owner','other person','2026-11-07')");
    await db.exec("INSERT INTO task_activities (owner_id,task_id,type) VALUES ('order-owner','00000000-0000-4000-8000-000000000001','priority_changed')");
    await db.exec("INSERT INTO idempotency_records (owner_id,method,path,key,request_hash,state,response,expires_at) VALUES ('order-owner','POST','/api/tasks','old-key',repeat('a',64),'completed','{\"status\":201,\"body\":{\"title\":\"old\",\"version\":1}}',now()+interval '1 day')");
    const tasksBefore = (await db.query("SELECT to_jsonb(tasks) AS value FROM tasks ORDER BY id")).rows;
    const activitiesBefore = (await db.query("SELECT * FROM task_activities")).rows;
    const requestsBefore = (await db.query("SELECT * FROM idempotency_records")).rows;
    await db.exec(await readFile("migrations/0005_task_daily_order.sql", "utf8"));
    expect((await db.query("SELECT to_jsonb(tasks)-'daily_order' AS value FROM tasks ORDER BY id")).rows).toEqual(tasksBefore);
    expect((await db.query("SELECT * FROM task_activities")).rows).toEqual(activitiesBefore);
    expect((await db.query("SELECT * FROM idempotency_records")).rows).toEqual(requestsBefore);
    expect((await db.query("SELECT title,daily_order FROM tasks WHERE owner_id='order-owner' AND scheduled_date='2026-11-07' ORDER BY daily_order")).rows).toEqual([2,3,4,5,6,1].map((i, index) => ({ title: `legacy ${i}`, daily_order: index + 1 })));
    expect((await db.query("SELECT title,daily_order FROM tasks WHERE title IN ('undated','other date','other person') ORDER BY title")).rows).toEqual([{ title: "other date", daily_order: 1 }, { title: "other person", daily_order: 1 }, { title: "undated", daily_order: null }]);
    await expect(db.exec("UPDATE tasks SET daily_order=null WHERE title='legacy 1'")).rejects.toThrow();
    await expect(db.exec("UPDATE tasks SET daily_order=0 WHERE title='legacy 1'")).rejects.toThrow();
    await expect(db.exec("UPDATE tasks SET daily_order=1 WHERE title='undated'")).rejects.toThrow();
    await db.exec("INSERT INTO task_activities (owner_id,task_id,type) VALUES ('order-owner','00000000-0000-4000-8000-000000000001','order_changed')");
  } finally { await db.close(); }
}, 30000);
