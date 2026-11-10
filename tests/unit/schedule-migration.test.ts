import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("adds schedule documents while preserving tasks and journal and enforcing canonical slots", async () => {
  const db = new PGlite();
  try {
    for (const name of ["0000_auth_and_task_foundation", "0001_active_completion_constraint", "0002_task_priority_kind_and_status", "0003_daily_journal"]) await db.exec(await readFile(`migrations/${name}.sql`, "utf8"));
    await db.exec("INSERT INTO users (id,name,email) VALUES ('schedule-owner','','schedule@example.test'),('other-owner','','other@example.test')");
    await db.exec("INSERT INTO tasks (owner_id,title,scheduled_date) SELECT 'schedule-owner','legacy ' || i,'2026-11-07' FROM generate_series(1,6) i");
    await db.exec("INSERT INTO journal_entries (owner_id,entry_date,content) VALUES ('schedule-owner','2026-11-07','keep journal')");
    const oldTasks = (await db.query("SELECT * FROM tasks ORDER BY title")).rows, oldJournal = (await db.query("SELECT * FROM journal_entries")).rows;
    await db.exec(await readFile("migrations/0004_daily_schedule.sql", "utf8"));
    expect((await db.query("SELECT * FROM tasks ORDER BY title")).rows).toEqual(oldTasks);
    expect((await db.query("SELECT * FROM journal_entries")).rows).toEqual(oldJournal);
    await db.query("INSERT INTO schedule_entries (owner_id,entry_date,slots) VALUES ($1,$2,$3::jsonb)", ["schedule-owner", "2026-11-07", JSON.stringify([{ startMinute: 360, title: "시작" }, { startMinute: 1410, title: "마지막" }])]);
    await db.exec("INSERT INTO schedule_entries (owner_id,entry_date,slots) VALUES ('other-owner','2026-11-07','[]')");
    await expect(db.exec("INSERT INTO schedule_entries (owner_id,entry_date,slots) VALUES ('schedule-owner','2026-11-07','[]')")).rejects.toThrow();
    await expect(db.exec("INSERT INTO schedule_entries (owner_id,entry_date,slots) VALUES ('unknown-owner','2026-11-07','[]')")).rejects.toThrow();
    for (const slots of [{}, [null], [{ startMinute: 360 }], [{ startMinute: 360, title: "", extra: true }], [{ startMinute: 360, title: " padded " }], [{ startMinute: 360, title: "e\u0301" }], [{ startMinute: 360, title: "bad\n" }], [{ startMinute: 360, title: "x".repeat(201) }], [{ startMinute: 1440, title: "late" }], [{ startMinute: 361, title: "bad" }], [{ startMinute: 360, title: "a" }, { startMinute: 360, title: "b" }], [{ startMinute: 390, title: "a" }, { startMinute: 360, title: "b" }]]) {
      await expect(db.query("UPDATE schedule_entries SET slots=$1::jsonb WHERE owner_id='schedule-owner'", [JSON.stringify(slots)])).rejects.toThrow();
    }
    await expect(db.exec("UPDATE schedule_entries SET version=0 WHERE owner_id='schedule-owner'")).rejects.toThrow();
    await expect(db.exec("UPDATE schedule_entries SET entry_date='10000-01-01' WHERE owner_id='schedule-owner'")).rejects.toThrow();
    await db.exec("UPDATE schedule_entries SET slots='[]' WHERE owner_id='schedule-owner'");
    await db.exec("DELETE FROM users WHERE id='schedule-owner'");
    expect((await db.query("SELECT owner_id,slots FROM schedule_entries")).rows).toEqual([{ owner_id: "other-owner", slots: [] }]);
  } finally { await db.close(); }
}, 30000);
