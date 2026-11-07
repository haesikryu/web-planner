import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, gt, gte, isNull, lt, or } from "drizzle-orm";
import { calendarDate, dayRange, InputError, object, title, today, uuidPattern } from "../../domain/rules";
import { getAuthRuntime } from "../auth/runtime";
import { tasks, taskActivities } from "../db/schema";
import { type Actor, etag, HttpError } from "./http";
import { writeOnce, type Transaction } from "./write";

export function taskBody(row: typeof tasks.$inferSelect) {
  const { ownerId: _owner, ...value } = row;
  return { ...value, createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString(), completedAt: value.completedAt?.toISOString() ?? null };
}
function normalizedInput(raw: unknown, create: boolean) {
  const value = object(raw, create ? ["title", "scheduledDate"] : ["title", "scheduledDate", "status", "isUnprocessed"]);
  if ((!create && !Object.keys(value).length) || (create && !("title" in value))) throw new InputError("body");
  const result: { title?: string; scheduledDate?: string | null; status?: "open" | "completed"; isUnprocessed?: boolean } = {};
  if ("title" in value) result.title = title(value.title);
  if ("scheduledDate" in value) result.scheduledDate = value.scheduledDate === null ? null : calendarDate(value.scheduledDate);
  if ("status" in value) {
    if (value.status !== "open" && value.status !== "completed") throw new InputError("status");
    result.status = value.status;
  }
  if ("isUnprocessed" in value) {
    if (typeof value.isUnprocessed !== "boolean") throw new InputError("isUnprocessed");
    result.isUnprocessed = value.isUnprocessed;
  }
  if (create && !("scheduledDate" in result)) result.scheduledDate = null;
  return result;
}
export function taskId(value: string): string {
  if (!uuidPattern.test(value)) throw new InputError("taskId");
  return value.toLowerCase();
}
async function owned(tx: Transaction, id: string, owner: string, lock = false) {
  const query = tx.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.ownerId, owner)));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw new HttpError(404, "NOT_FOUND", "항목을 찾을 수 없습니다.");
  return row;
}
export async function createTask(actor: Actor, key: string, raw: unknown) {
  const input = normalizedInput(raw, true);
  return writeOnce(actor.id, "POST", "/api/tasks", key, input, async tx => {
    const now = new Date();
    const [row] = await tx.insert(tasks).values({ ownerId: actor.id, title: input.title ?? "", scheduledDate: input.scheduledDate, createdAt: now, updatedAt: now }).returning();
    return { status: 201, body: taskBody(row), etag: etag(row.version) };
  });
}
export async function patchTask(actor: Actor, id: string, key: string, version: number, raw: unknown) {
  const input = normalizedInput(raw, false);
  return writeOnce(actor.id, "PATCH", `/api/tasks/${id}`, key, { input, version }, async tx => {
    const row = await owned(tx, id, actor.id, true);
    if (row.version !== version) throw new HttpError(412, "VERSION_CONFLICT", "항목이 변경되었습니다. 최신 내용을 확인해주세요.");
    const changed = Object.entries(input).some(([field, value]) => row[field as keyof typeof input] !== value);
    if (!changed) return { status: 200, body: taskBody(row), etag: etag(row.version) };
    const now = new Date(), nextStatus = input.status ?? row.status;
    const [updated] = await tx.update(tasks).set({ ...input, version: version + 1, updatedAt: now,
      completedAt: nextStatus === row.status ? row.completedAt : nextStatus === "completed" ? now : null
    }).where(and(eq(tasks.id, id), eq(tasks.ownerId, actor.id), eq(tasks.version, version))).returning();
    if (!updated) throw new HttpError(412, "VERSION_CONFLICT", "최신 내용을 확인해주세요.");
    if (nextStatus !== row.status) {
      const [activity] = await tx.insert(taskActivities).values({ ownerId: actor.id, taskId: id,
        type: nextStatus === "completed" ? "completed" : "completion_undone", occurredAt: now }).returning();
      if (nextStatus === "open") await tx.update(taskActivities).set({ invalidatedBy: activity.id }).where(and(
        eq(taskActivities.ownerId, actor.id), eq(taskActivities.taskId, id), eq(taskActivities.type, "completed"), isNull(taskActivities.invalidatedBy)
      ));
    }
    for (const [field, type] of [["scheduledDate", "scheduled_date_changed"], ["isUnprocessed", "processing_changed"]] as const) {
      if (field in input && input[field] !== row[field]) await tx.insert(taskActivities).values({ ownerId: actor.id, taskId: id, type, occurredAt: now });
    }
    return { status: 200, body: taskBody(updated), etag: etag(updated.version) };
  }, async tx => { await owned(tx, id, actor.id); });
}
export async function getTask(actor: Actor, id: string) {
  const [row] = await getAuthRuntime().db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.ownerId, actor.id)));
  if (!row) throw new HttpError(404, "NOT_FOUND", "항목을 찾을 수 없습니다.");
  return { status: 200, body: taskBody(row), etag: etag(row.version) };
}
type Cursor = { scope: string; time: string; id: string };
const signature = (value: string, secret: string) => createHmac("sha256", secret).update(`planner:cursor:v1:${value}`).digest("base64url");
function decodeCursor(value: string, scope: string, secret: string): Cursor {
  if (value.length > 2048) throw new HttpError(400, "INVALID_CURSOR", "목록을 새로 불러와주세요.");
  const [payload, proof, extra] = value.split(".");
  const expected = signature(payload, secret);
  if (!proof || extra || Buffer.byteLength(proof) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(proof), Buffer.from(expected))) throw new HttpError(400, "INVALID_CURSOR", "목록을 새로 불러와주세요.");
  try {
    const result = JSON.parse(Buffer.from(payload, "base64url").toString()) as Cursor;
    if (result.scope !== scope || !uuidPattern.test(result.id) || new Date(result.time).toISOString() !== result.time) throw new Error();
    return result;
  } catch { throw new HttpError(400, "INVALID_CURSOR", "목록을 새로 불러와주세요."); }
}
export async function listTasks(actor: Actor, url: URL) {
  const params = url.searchParams;
  if ([...params.keys()].some(key => !["view", "date", "limit", "cursor"].includes(key) || params.getAll(key).length !== 1)) throw new InputError("query");
  const view = params.get("view") ?? "inbox", date = params.get("date");
  if (!["inbox", "scheduled", "overdue", "completed"].includes(view) || (view === "inbox" ? date !== null : !date)) throw new InputError("view/date");
  if (date !== null) calendarDate(date);
  const limitText = params.get("limit") ?? "50", limit = Number(limitText);
  if (!/^\d+$/u.test(limitText) || limit < 1 || limit > 100) throw new InputError("limit");
  const filters = [eq(tasks.ownerId, actor.id)];
  if (view === "inbox") filters.push(eq(tasks.isUnprocessed, true));
  if (view === "scheduled") filters.push(eq(tasks.status, "open"), eq(tasks.scheduledDate, date ?? ""));
  if (view === "overdue") filters.push(eq(tasks.status, "open"), lt(tasks.scheduledDate, date ?? ""));
  if (view === "completed") {
    const { start, end } = dayRange(date ?? "", actor.timezone);
    filters.push(eq(tasks.status, "completed"), gte(tasks.completedAt, start), lt(tasks.completedAt, end));
  }
  const scope = JSON.stringify([actor.id, view, date, actor.timezone, limit]), rawCursor = params.get("cursor");
  const column = view === "completed" ? tasks.completedAt : tasks.createdAt;
  if (rawCursor) {
    const cursor = decodeCursor(rawCursor, scope, actor.secret), instant = new Date(cursor.time);
    const next = or(view === "completed" ? lt(column, instant) : gt(column, instant), and(eq(column, instant), gt(tasks.id, cursor.id)));
    if (next) filters.push(next);
  }
  const rows = await getAuthRuntime().db.select().from(tasks).where(and(...filters))
    .orderBy(view === "completed" ? desc(column) : asc(column), asc(tasks.id)).limit(limit + 1);
  const selected = rows.slice(0, limit), last = selected.at(-1);
  let nextCursor: string | null = null;
  if (rows.length > limit && last) {
    const payload = Buffer.from(JSON.stringify({ scope, time: (view === "completed" ? last.completedAt : last.createdAt)?.toISOString(), id: last.id })).toString("base64url");
    nextCursor = `${payload}.${signature(payload, actor.secret)}`;
  }
  return { status: 200, body: { items: selected.map(taskBody), nextCursor, serverDate: today(actor.timezone), timezone: actor.timezone } };
}
