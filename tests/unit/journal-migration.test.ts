import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("adds isolated daily journals without changing tasks, and enforces ownership and content constraints", async () => {
  const db = new PGlite();
  try {
    for (const name of ["0000_auth_and_task_foundation", "0001_active_completion_constraint", "0002_task_priority_kind_and_status"]) {
      await db.exec(await readFile(`migrations/${name}.sql`, "utf8"));
    }
    await db.exec("INSERT INTO users (id,name,email) VALUES ('journal-owner','','journal@example.test'),('other-owner','','other@example.test')");
    await db.exec("INSERT INTO tasks (owner_id,title,scheduled_date,priority,kind,version) VALUES ('journal-owner','기존 기록','2026-11-07','high','appointment',7)");
    const oldTasks = (await db.query("SELECT * FROM tasks")).rows;
    await db.exec(await readFile("migrations/0003_daily_journal.sql", "utf8"));
    expect((await db.query("SELECT * FROM tasks")).rows).toEqual(oldTasks);
    await db.query("INSERT INTO journal_entries (owner_id,entry_date,content) VALUES ($1,$2,$3)", ["journal-owner", "2026-11-07", "  e\u0301\n😀\r끝  "]);
    await db.query("INSERT INTO journal_entries (owner_id,entry_date,content) VALUES ($1,$2,$3)", ["other-owner", "2026-11-07", "other"]);
    await expect(db.exec("INSERT INTO journal_entries (owner_id,entry_date,content) VALUES ('journal-owner','2026-11-07','duplicate')")).rejects.toThrow();
    await expect(db.exec("INSERT INTO journal_entries (owner_id,entry_date,content) VALUES ('unknown-owner','2026-11-07','unowned')")).rejects.toThrow();
    for (const content of ["x".repeat(10001), "CRLF\r\n", "NUL\0"]) {
      await expect(db.query("UPDATE journal_entries SET content=$1 WHERE owner_id='journal-owner'", [content])).rejects.toThrow();
    }
    await expect(db.exec("UPDATE journal_entries SET version=0 WHERE owner_id='journal-owner'")).rejects.toThrow();
    await expect(db.exec("UPDATE journal_entries SET entry_date='10000-01-01' WHERE owner_id='journal-owner'")).rejects.toThrow();
    await db.query("UPDATE journal_entries SET content=$1 WHERE owner_id='journal-owner'", ["😀".repeat(10000)]);
    await db.exec("UPDATE journal_entries SET content='' WHERE owner_id='journal-owner'");
    expect((await db.query("SELECT content FROM journal_entries WHERE owner_id='journal-owner'")).rows).toEqual([{ content: "" }]);
    await db.exec("DELETE FROM users WHERE id='journal-owner'");
    expect((await db.query("SELECT owner_id,content FROM journal_entries")).rows).toEqual([{ owner_id: "other-owner", content: "other" }]);
  } finally { await db.close(); }
}, 30000);
