import { and, eq } from "drizzle-orm";
import { normalizeScheduleSlots, type ScheduleEntry } from "../../domain/schedule";
import { object } from "../../domain/rules";
import { getAuthRuntime } from "../auth/runtime";
import { scheduleEntries } from "../db/schema";
import { type Actor, etag, HttpError } from "./http";
import { lockDate } from "./date-lock";
import { writeOnce } from "./write";

function scheduleBody(date: string, row?: typeof scheduleEntries.$inferSelect): ScheduleEntry {
  return row ? { date: row.date, slots: row.slots, version: row.version, updatedAt: row.updatedAt.toISOString() }
    : { date, slots: [], version: 0, updatedAt: null };
}
export async function getSchedule(actor: Actor, date: string) {
  const [row] = await getAuthRuntime().db.select().from(scheduleEntries).where(and(eq(scheduleEntries.ownerId, actor.id), eq(scheduleEntries.date, date)));
  const body = scheduleBody(date, row);
  return { status: 200, body, etag: etag(body.version) };
}
export async function putSchedule(actor: Actor, date: string, key: string, version: number, raw: unknown) {
  const input = object(raw, ["slots"]), slots = normalizeScheduleSlots(input.slots);
  return writeOnce(actor.id, "PUT", `/api/schedule/${date}`, key, { slots, version }, async tx => {
    await lockDate(tx, "schedule", actor.id, date);
    const where = and(eq(scheduleEntries.ownerId, actor.id), eq(scheduleEntries.date, date));
    const [current] = await tx.select().from(scheduleEntries).where(where).for("update");
    if ((current?.version ?? 0) !== version) throw new HttpError(412, "VERSION_CONFLICT", "일정이 변경되었습니다. 최신 내용을 확인해주세요.");
    if (JSON.stringify(normalizeScheduleSlots(current?.slots ?? [])) === JSON.stringify(slots)) return { status: 200, body: scheduleBody(date, current), etag: etag(version) };
    const values = { slots, version: version + 1, updatedAt: new Date() };
    const [saved] = current
      ? await tx.update(scheduleEntries).set(values).where(and(where, eq(scheduleEntries.version, version))).returning()
      : await tx.insert(scheduleEntries).values({ ownerId: actor.id, date, ...values }).returning();
    if (!saved) throw new HttpError(412, "VERSION_CONFLICT", "최신 일정을 확인해주세요.");
    return { status: 200, body: scheduleBody(date, saved), etag: etag(saved.version) };
  });
}
