import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("adds defaults without losing pre-existing task content and enforces new value constraints", async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile("migrations/0000_auth_and_task_foundation.sql", "utf8"));
    await db.exec(await readFile("migrations/0001_active_completion_constraint.sql", "utf8"));
    await db.exec("INSERT INTO users (id,name,email) VALUES ('migration-owner','','migration@example.test')");
    await db.exec("INSERT INTO tasks (id,owner_id,title,status,scheduled_date,version) VALUES ('00000000-0000-4000-8000-000000000001','migration-owner','기존 제목','open','2026-11-07',7)");
    await db.exec(await readFile("migrations/0002_task_priority_kind_and_status.sql", "utf8"));
    const rows = await db.query("SELECT title,status,scheduled_date::text,version,priority,kind FROM tasks");
    expect(rows.rows).toEqual([{ title: "기존 제목", status: "open", scheduled_date: "2026-11-07", version: 7, priority: "medium", kind: "task" }]);
    await expect(db.exec("UPDATE tasks SET priority='urgent'")).rejects.toThrow();
    await expect(db.exec("UPDATE tasks SET kind='note'")).rejects.toThrow();
    await expect(db.exec("UPDATE tasks SET status='canceled',completed_at=now()")).rejects.toThrow();
    await db.exec("UPDATE tasks SET status='deferred'");
    expect((await db.query("SELECT completed_at FROM tasks")).rows).toEqual([{ completed_at: null }]);
  } finally { await db.close(); }
}, 30000);
