import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { calendarDate, dayRange, InputError, object, title, today, uuidPattern } from "../../domain/rules";
import { taskKind, taskPriority, taskStatus, type TaskKind, type TaskPriority, type TaskStatus } from "../../domain/task-options";
import { getAuthRuntime } from "../auth/runtime";
import { tasks, taskActivities } from "../db/schema";
import { type Actor, etag, HttpError, type SavedResponse } from "./http";
import { writeOnce, type Transaction } from "./write";
import { lockDate } from "./date-lock";

export function taskBody(row: typeof tasks.$inferSelect) {
  const { ownerId: _owner, ...value } = row;
  return { ...value, createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString(), completedAt: value.completedAt?.toISOString() ?? null };
}
function normalizedInput(raw: unknown, create: boolean) {
  const value = object(raw, create ? ["title", "scheduledDate", "isUnprocessed", "priority", "kind"] : ["title", "scheduledDate", "status", "isUnprocessed", "priority", "kind"]);
  if ((!create && !Object.keys(value).length) || (create && !("title" in value))) throw new InputError("body");
  const result: { title?: string; scheduledDate?: string | null; status?: TaskStatus; isUnprocessed?: boolean; priority?: TaskPriority; kind?: TaskKind } = {};
  if ("title" in value) result.title = title(value.title);
  if ("scheduledDate" in value) result.scheduledDate = value.scheduledDate === null ? null : calendarDate(value.scheduledDate);
  if ("status" in value) result.status = taskStatus(value.status);
  if ("priority" in value) result.priority = taskPriority(value.priority);
  if ("kind" in value) result.kind = taskKind(value.kind);
  if ("isUnprocessed" in value) {
    if (typeof value.isUnprocessed !== "boolean") throw new InputError("isUnprocessed");
    result.isUnprocessed = value.isUnprocessed;
  }
  if (create && !("scheduledDate" in result)) result.scheduledDate = null;
  if (create && result.isUnprocessed === false && !result.scheduledDate) throw new InputError("scheduledDate");
  return result;
}
export function taskId(value: string): string {
  if (!uuidPattern.test(value)) throw new InputError("taskId");
  return value.toLowerCase();
}
function compatibleTaskResponse(response: SavedResponse): SavedResponse {
  // Unexpired responses created before these additive fields retain their original version and content.
  return { ...response, body: { priority: "medium", kind: "task", ...response.body as Record<string, unknown> } };
}
async function owned(tx: Transaction, id: string, owner: string, lock = false) {
  const query = tx.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.ownerId, owner)));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw new HttpError(404, "NOT_FOUND", "항목을 찾을 수 없습니다.");
  return row;
}
async function requireDayCapacity(tx: Transaction, owner: string, date: string) {
  await lockDate(tx, "task-day", owner, date);
  const [result] = await tx.select({ total: count() }).from(tasks).where(and(eq(tasks.ownerId, owner), eq(tasks.scheduledDate, date)));
  if (result.total >= 5) throw new HttpError(422, "DAILY_TASK_LIMIT", "하루의 할 일은 완료·취소 항목을 포함해 최대 5개까지 등록할 수 있습니다.");
}
export async function createTask(actor: Actor, key: string, raw: unknown) {
  const input = normalizedInput(raw, true);
  return compatibleTaskResponse(await writeOnce(actor.id, "POST", "/api/tasks", key, input, async tx => {
    if (input.scheduledDate) await requireDayCapacity(tx, actor.id, input.scheduledDate);
    const now = new Date();
    const [row] = await tx.insert(tasks).values({ ownerId: actor.id, title: input.title ?? "", scheduledDate: input.scheduledDate, isUnprocessed: input.isUnprocessed, priority: input.priority, kind: input.kind, createdAt: now, updatedAt: now }).returning();
    return { status: 201, body: taskBody(row), etag: etag(row.version) };
  }));
}
export async function patchTask(actor: Actor, id: string, key: string, version: number, raw: unknown) {
  const input = normalizedInput(raw, false);
  return compatibleTaskResponse(await writeOnce(actor.id, "PATCH", `/api/tasks/${id}`, key, { input, version }, async tx => {
    const row = await owned(tx, id, actor.id, true);
    if (row.version !== version) throw new HttpError(412, "VERSION_CONFLICT", "항목이 변경되었습니다. 최신 내용을 확인해주세요.");
    const changes = { ...input }, nextStatus = input.status ?? row.status;
    const nextDate = input.scheduledDate === undefined ? row.scheduledDate : input.scheduledDate;
    if (nextStatus !== "completed" && nextDate === null) {
      if (input.isUnprocessed === false) throw new InputError("scheduledDate");
      // Keep an undated non-completed item reachable without altering the original replay hash.
      changes.isUnprocessed = true;
    }
    const changed = Object.entries(changes).some(([field, value]) => row[field as keyof typeof changes] !== value);
    if (!changed) return { status: 200, body: taskBody(row), etag: etag(row.version) };
    if (nextDate !== null && nextDate !== row.scheduledDate) await requireDayCapacity(tx, actor.id, nextDate);
    const now = new Date();
    const [updated] = await tx.update(tasks).set({ ...changes, version: version + 1, updatedAt: now,
      completedAt: nextStatus === row.status ? row.completedAt : nextStatus === "completed" ? now : null
    }).where(and(eq(tasks.id, id), eq(tasks.ownerId, actor.id), eq(tasks.version, version))).returning();
    if (!updated) throw new HttpError(412, "VERSION_CONFLICT", "최신 내용을 확인해주세요.");
    if (nextStatus !== row.status) {
      if (row.status === "completed") {
        const [undo] = await tx.insert(taskActivities).values({ ownerId: actor.id, taskId: id, type: "completion_undone", occurredAt: now }).returning();
        await tx.update(taskActivities).set({ invalidatedBy: undo.id }).where(and(
          eq(taskActivities.ownerId, actor.id), eq(taskActivities.taskId, id), eq(taskActivities.type, "completed"), isNull(taskActivities.invalidatedBy)
        ));
      }
      if (!(row.status === "completed" && nextStatus === "open")) await tx.insert(taskActivities).values({ ownerId: actor.id, taskId: id,
        type: nextStatus === "open" ? "reopened" : nextStatus, occurredAt: now });
    }
    for (const [field, type] of [["scheduledDate", "scheduled_date_changed"], ["isUnprocessed", "processing_changed"], ["priority", "priority_changed"], ["kind", "kind_changed"]] as const) {
      if (field in changes && changes[field] !== row[field]) await tx.insert(taskActivities).values({ ownerId: actor.id, taskId: id, type, occurredAt: now });
    }
    return { status: 200, body: taskBody(updated), etag: etag(updated.version) };
  }, async tx => { await owned(tx, id, actor.id); }));
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
  if (!["inbox", "day", "scheduled", "overdue", "completed"].includes(view) || (view === "inbox" ? date !== null : !date)) throw new InputError("view/date");
  if (date !== null) calendarDate(date);
  const limitText = params.get("limit") ?? "50", limit = Number(limitText);
  if (!/^\d+$/u.test(limitText) || limit < 1 || limit > 100) throw new InputError("limit");
  const filters = [eq(tasks.ownerId, actor.id)];
  if (view === "inbox") filters.push(eq(tasks.isUnprocessed, true));
  if (view === "day") filters.push(eq(tasks.scheduledDate, date ?? ""));
  if (view === "scheduled") filters.push(ne(tasks.status, "completed"), eq(tasks.scheduledDate, date ?? ""));
  if (view === "overdue") filters.push(inArray(tasks.status, ["open", "deferred"]), lt(tasks.scheduledDate, date ?? ""));
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
