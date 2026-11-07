import { and, eq, sql } from "drizzle-orm";
import { journalContent, type JournalEntry } from "../../domain/journal";
import { object } from "../../domain/rules";
import { getAuthRuntime } from "../auth/runtime";
import { journalEntries } from "../db/schema";
import { type Actor, etag, HttpError } from "./http";
import { writeOnce } from "./write";

function journalBody(date: string, row?: typeof journalEntries.$inferSelect): JournalEntry {
  return row ? { date: row.date, content: row.content, version: row.version, updatedAt: row.updatedAt.toISOString() }
    : { date, content: "", version: 0, updatedAt: null };
}
export async function getJournal(actor: Actor, date: string) {
  const [row] = await getAuthRuntime().db.select().from(journalEntries).where(and(eq(journalEntries.ownerId, actor.id), eq(journalEntries.date, date)));
  const body = journalBody(date, row);
  return { status: 200, body, etag: etag(body.version) };
}
export async function putJournal(actor: Actor, date: string, key: string, version: number, raw: unknown) {
  const input = object(raw, ["content"]), content = journalContent(input.content);
  return writeOnce(actor.id, "PUT", `/api/journal/${date}`, key, { content, version }, async tx => {
    // A row lock alone cannot serialize first writes because an empty day has no row yet.
    try {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["journal", actor.id, date])}, 0))`);
    } catch (error) {
      const cause = error instanceof Error && "cause" in error ? error.cause : error;
      if (cause && typeof cause === "object" && "code" in cause && cause.code === "55P03") {
        throw new HttpError(409, "REQUEST_IN_PROGRESS", "같은 날짜의 글을 저장 중입니다. 같은 요청으로 다시 시도해주세요.");
      }
      throw error;
    }
    const where = and(eq(journalEntries.ownerId, actor.id), eq(journalEntries.date, date));
    const [current] = await tx.select().from(journalEntries).where(where).for("update");
    if ((current?.version ?? 0) !== version) throw new HttpError(412, "VERSION_CONFLICT", "글이 변경되었습니다. 최신 내용을 확인해주세요.");
    if ((current?.content ?? "") === content) return { status: 200, body: journalBody(date, current), etag: etag(version) };
    const values = { content, version: version + 1, updatedAt: new Date() };
    const [saved] = current
      ? await tx.update(journalEntries).set(values).where(and(where, eq(journalEntries.version, version))).returning()
      : await tx.insert(journalEntries).values({ ownerId: actor.id, date, ...values }).returning();
    if (!saved) throw new HttpError(412, "VERSION_CONFLICT", "최신 글을 확인해주세요.");
    return { status: 200, body: journalBody(date, saved), etag: etag(saved.version) };
  });
}
