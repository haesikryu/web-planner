import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, count, desc, eq, getTableColumns, gt, gte, inArray, isNull, lt, max, ne, or, sql } from "drizzle-orm";
import { calendarDate, dayRange, InputError, object, title, today, uuidPattern } from "../../domain/rules";
import { taskKind, taskPriority, taskStatus, type TaskKind, type TaskPriority, type TaskStatus } from "../../domain/task-options";
import { DAILY_TASK_LIMIT, taskMove, type TaskMove } from "../../domain/task-order";
import { getAuthRuntime } from "../auth/runtime";
import { tasks, taskActivities } from "../db/schema";
import type { TaskActivityDetails } from "../../domain/task-history";
import { type Actor, etag, HttpError, type SavedResponse } from "./http";
import { writeOnce, type Transaction } from "./write";
import { lockDate } from "./date-lock";

export function taskBody(row: typeof tasks.$inferSelect) {
  const { ownerId: _owner, ...value } = row;
  return { ...value, createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString(), completedAt: value.completedAt?.toISOString() ?? null };
}
function planSnapshot(row: typeof tasks.$inferSelect) {
  const { scheduledDate, dueDate, status, dailyOrder } = row;
  return { scheduledDate, dueDate, status: taskStatus(status), dailyOrder };
}
function activityDetails(before: typeof tasks.$inferSelect | null, after: typeof tasks.$inferSelect): TaskActivityDetails {
  return { before: before ? planSnapshot(before) : null, after: planSnapshot(after), version: after.version };
}
function normalizedInput(raw: unknown, create: boolean) {
  const value = object(raw, create ? ["title", "scheduledDate", "dueDate", "isUnprocessed", "priority", "kind"] : ["title", "scheduledDate", "dueDate", "status", "isUnprocessed", "priority", "kind", "move", "moveTo"]);
  if ((!create && !Object.keys(value).length) || (create && !("title" in value))) throw new InputError("body");
  const result: { title?: string; scheduledDate?: string | null; dueDate?: string | null; status?: TaskStatus; isUnprocessed?: boolean; priority?: TaskPriority; kind?: TaskKind; move?: TaskMove; moveTo?: string } = {};
  if ("move" in value) {
    if (create || Object.keys(value).length !== 1) throw new InputError("move");
    result.move = taskMove(value.move);
  }
  if ("moveTo" in value) {
    if (create || Object.keys(value).length !== 1 || typeof value.moveTo !== "string" || !uuidPattern.test(value.moveTo)) throw new InputError("moveTo");
    result.moveTo = value.moveTo.toLowerCase();
  }
  if ("title" in value) result.title = title(value.title);
  if ("scheduledDate" in value) result.scheduledDate = value.scheduledDate === null ? null : calendarDate(value.scheduledDate);
  if ("dueDate" in value) result.dueDate = value.dueDate === null ? null : calendarDate(value.dueDate);
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
  return { ...response, body: { priority: "medium", kind: "task", dailyOrder: null, ...response.body as Record<string, unknown> } };
}
async function owned(tx: Transaction, id: string, owner: string, lock = false) {
  const query = tx.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.ownerId, owner)));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw new HttpError(404, "NOT_FOUND", "항목을 찾을 수 없습니다.");
  return row;
}
async function appendDayOrder(tx: Transaction, owner: string, date: string): Promise<number> {
  await lockDate(tx, "task-day", owner, date);
  const [result] = await tx.select({ total: count(), last: max(tasks.dailyOrder) }).from(tasks).where(and(eq(tasks.ownerId, owner), eq(tasks.scheduledDate, date)));
  if (result.total >= DAILY_TASK_LIMIT) throw new HttpError(422, "DAILY_TASK_LIMIT", "하루의 할 일은 완료·취소 항목을 포함해 최대 5개까지 등록할 수 있습니다.");
  if ((result.last ?? 0) >= 2147483647) throw new InputError("dailyOrder");
  return (result.last ?? 0) + 1;
}
export async function createTask(actor: Actor, key: string, raw: unknown) {
  const input = normalizedInput(raw, true);
  return compatibleTaskResponse(await writeOnce(actor.id, "POST", "/api/tasks", key, input, async tx => {
    const dailyOrder = input.scheduledDate ? await appendDayOrder(tx, actor.id, input.scheduledDate) : null;
    const now = new Date();
    const [row] = await tx.insert(tasks).values({ ownerId: actor.id, title: input.title ?? "", scheduledDate: input.scheduledDate, dueDate: input.dueDate, dailyOrder, isUnprocessed: input.isUnprocessed, priority: input.priority, kind: input.kind, createdAt: now, updatedAt: now }).returning();
    await tx.insert(taskActivities).values({ ownerId: actor.id, taskId: row.id, type: "created", occurredAt: now, details: activityDetails(null, row) });
    return { status: 201, body: taskBody(row), etag: etag(row.version) };
  }));
}
export async function patchTask(actor: Actor, id: string, key: string, version: number, raw: unknown) {
  const input = normalizedInput(raw, false);
  return compatibleTaskResponse(await writeOnce(actor.id, "PATCH", `/api/tasks/${id}`, key, { input, version }, async tx => {
    // Every task write takes day locks before row locks; cross-day writes lock dates in the same order.
    const observed = await owned(tx, id, actor.id);
    if (observed.version !== version) throw new HttpError(412, "VERSION_CONFLICT", "항목이 변경되었습니다. 최신 내용을 확인해주세요.");
    const destination = input.scheduledDate === undefined ? observed.scheduledDate : input.scheduledDate;
    for (const date of [...new Set([observed.scheduledDate, destination].filter((value): value is string => value !== null))].sort()) await lockDate(tx, "task-day", actor.id, date);
    const row = await owned(tx, id, actor.id, true);
    if (row.version !== version) throw new HttpError(412, "VERSION_CONFLICT", "항목이 변경되었습니다. 최신 내용을 확인해주세요.");
    if (input.move || input.moveTo) {
      if (!row.scheduledDate) throw new InputError("scheduledDate");
      if (input.moveTo) {
        // Do not acquire an out-of-order target-date/row lock. The source-day lock already
        // protects any valid target, while another owner's or another day's row is rejected.
        const target = await owned(tx, input.moveTo, actor.id);
        if (target.scheduledDate !== row.scheduledDate) throw new InputError("moveTo");
      }
      const day = await tx.select().from(tasks).where(and(eq(tasks.ownerId, actor.id), eq(tasks.scheduledDate, row.scheduledDate)))
        .orderBy(asc(tasks.dailyOrder), asc(tasks.createdAt), asc(tasks.id)).for("update");
      const index = day.findIndex(task => task.id === id);
      const targetIndex = input.moveTo ? day.findIndex(task => task.id === input.moveTo) : index + (input.move === "up" ? -1 : 1);
      if (targetIndex === index || targetIndex < 0 || targetIndex >= day.length) return { status: 200, body: taskBody(row), etag: etag(row.version) };
      const first = Math.min(index, targetIndex), last = Math.max(index, targetIndex);
      const affected = day.slice(first, last + 1), reordered = [...day];
      reordered.splice(index, 1); reordered.splice(targetIndex, 0, row);
      const positions = reordered.slice(first, last + 1).map((task, offset) => ({ id: task.id, dailyOrder: affected[offset].dailyOrder }));
      if (affected.some(task => task.version >= 2147483647)) throw new InputError("version");
      const now = new Date();
      const orderCases = positions.map(position => sql`WHEN ${tasks.id} = ${position.id} THEN ${position.dailyOrder}::integer`);
      const changed = await tx.update(tasks).set({ dailyOrder: sql`CASE ${sql.join(orderCases, sql` `)} ELSE ${tasks.dailyOrder} END`, version: sql`${tasks.version} + 1`, updatedAt: now })
        .where(and(eq(tasks.ownerId, actor.id), inArray(tasks.id, positions.map(task => task.id)))).returning();
      const updated = changed.find(task => task.id === id);
      if (!updated || changed.length !== affected.length) throw new HttpError(412, "VERSION_CONFLICT", "최신 순서를 확인해주세요.");
      await tx.insert(taskActivities).values(changed.map(task => ({ ownerId: actor.id, taskId: task.id, type: "order_changed", occurredAt: now,
        details: activityDetails(affected.find(original => original.id === task.id) ?? null, task) })));
      return { status: 200, body: taskBody(updated), etag: etag(updated.version) };
    }
    const { move: _move, moveTo: _moveTo, ...changes } = input;
    const nextStatus = input.status ?? row.status;
    const nextDate = input.scheduledDate === undefined ? row.scheduledDate : input.scheduledDate;
    if (nextStatus !== "completed" && nextDate === null) {
      if (input.isUnprocessed === false) throw new InputError("scheduledDate");
      // Keep an undated non-completed item reachable without altering the original replay hash.
      changes.isUnprocessed = true;
    }
    const changed = Object.entries(changes).some(([field, value]) => row[field as keyof typeof changes] !== value);
    if (!changed) return { status: 200, body: taskBody(row), etag: etag(row.version) };
    const dailyOrder = nextDate === row.scheduledDate ? row.dailyOrder : nextDate === null ? null : await appendDayOrder(tx, actor.id, nextDate);
    const now = new Date();
    const [updated] = await tx.update(tasks).set({ ...changes, dailyOrder, version: version + 1, updatedAt: now,
      completedAt: nextStatus === row.status ? row.completedAt : nextStatus === "completed" ? now : null
    }).where(and(eq(tasks.id, id), eq(tasks.ownerId, actor.id), eq(tasks.version, version))).returning();
    if (!updated) throw new HttpError(412, "VERSION_CONFLICT", "최신 내용을 확인해주세요.");
    const details = activityDetails(row, updated);
    if (nextStatus !== row.status) {
      if (row.status === "completed") {
        const [undo] = await tx.insert(taskActivities).values({ ownerId: actor.id, taskId: id, type: "completion_undone", occurredAt: now, details }).returning();
        await tx.update(taskActivities).set({ invalidatedBy: undo.id }).where(and(
          eq(taskActivities.ownerId, actor.id), eq(taskActivities.taskId, id), eq(taskActivities.type, "completed"), isNull(taskActivities.invalidatedBy)
        ));
      }
      if (!(row.status === "completed" && nextStatus === "open")) await tx.insert(taskActivities).values({ ownerId: actor.id, taskId: id,
        type: nextStatus === "open" ? "reopened" : nextStatus, occurredAt: now, details });
    }
    for (const [field, type] of [["scheduledDate", "scheduled_date_changed"], ["dueDate", "due_date_changed"], ["isUnprocessed", "processing_changed"], ["priority", "priority_changed"], ["kind", "kind_changed"]] as const) {
      if (field in changes && changes[field] !== row[field]) await tx.insert(taskActivities).values({ ownerId: actor.id, taskId: id, type, occurredAt: now, details });
    }
    return { status: 200, body: taskBody(updated), etag: etag(updated.version) };
  }, async tx => { await owned(tx, id, actor.id); }));
}
export async function getTask(actor: Actor, id: string) {
  const [row] = await getAuthRuntime().db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.ownerId, actor.id)));
  if (!row) throw new HttpError(404, "NOT_FOUND", "항목을 찾을 수 없습니다.");
  return { status: 200, body: taskBody(row), etag: etag(row.version) };
}
type Cursor = { scope: string; time: string; id: string; order?: number };
const signature = (value: string, secret: string) => createHmac("sha256", secret).update(`planner:cursor:v1:${value}`).digest("base64url");
function decodeCursor(value: string, scope: string, secret: string, ordered = false, preciseTime = false): Cursor {
  if (value.length > 2048) throw new HttpError(400, "INVALID_CURSOR", "목록을 새로 불러와주세요.");
  const [payload, proof, extra] = value.split(".");
  const expected = signature(payload, secret);
  if (!proof || extra || Buffer.byteLength(proof) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(proof), Buffer.from(expected))) throw new HttpError(400, "INVALID_CURSOR", "목록을 새로 불러와주세요.");
  try {
    const result = JSON.parse(Buffer.from(payload, "base64url").toString()) as Cursor;
    const comparableTime = preciseTime && typeof result.time === "string" ? result.time.replace(/\.(\d{3})\d{3}Z$/u, ".$1Z") : result.time;
    if (result.scope !== scope || !uuidPattern.test(result.id) || new Date(result.time).toISOString() !== comparableTime) throw new Error();
    if (ordered && (!Number.isInteger(result.order) || (result.order ?? 0) < 1 || (result.order ?? 0) > 2147483647)) throw new Error();
    return result;
  } catch { throw new HttpError(400, "INVALID_CURSOR", "목록을 새로 불러와주세요."); }
}
export async function listTasks(actor: Actor, url: URL) {
  const params = url.searchParams;
  if ([...params.keys()].some(key => !["view", "date", "limit", "cursor"].includes(key) || params.getAll(key).length !== 1)) throw new InputError("query");
  const view = params.get("view") ?? "inbox", date = params.get("date");
  if (!["inbox", "day", "scheduled", "due", "overdue", "completed"].includes(view) || (view === "inbox" ? date !== null : !date)) throw new InputError("view/date");
  if (date !== null) calendarDate(date);
  const limitText = params.get("limit") ?? "50", limit = Number(limitText);
  if (!/^\d+$/u.test(limitText) || limit < 1 || limit > 100) throw new InputError("limit");
  const filters = [eq(tasks.ownerId, actor.id)];
  if (view === "inbox") filters.push(eq(tasks.isUnprocessed, true));
  if (view === "day") filters.push(eq(tasks.scheduledDate, date ?? ""));
  if (view === "scheduled") filters.push(ne(tasks.status, "completed"), eq(tasks.scheduledDate, date ?? ""));
  if (view === "due") filters.push(inArray(tasks.status, ["open", "deferred"]), eq(tasks.dueDate, date ?? ""), sql`${tasks.scheduledDate} IS DISTINCT FROM ${date}`);
  if (view === "overdue") filters.push(inArray(tasks.status, ["open", "deferred"]), lt(tasks.scheduledDate, date ?? ""));
  if (view === "completed") {
    const { start, end } = dayRange(date ?? "", actor.timezone);
    filters.push(eq(tasks.status, "completed"), gte(tasks.completedAt, start), lt(tasks.completedAt, end));
  }
  const scope = JSON.stringify([actor.id, view, date, actor.timezone, limit, ...(view === "day" ? ["daily-order-v1"] : [])]), rawCursor = params.get("cursor");
  const column = view === "completed" ? tasks.completedAt : tasks.createdAt;
  const cursorTime = sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  if (rawCursor) {
    const cursor = decodeCursor(rawCursor, scope, actor.secret, view === "day", true);
    let instant = cursor.time;
    if (/\.\d{3}Z$/u.test(instant)) {
      // Older cursors truncated database timestamps. Recover their precise boundary
      // only while the same visible anchor still has the recorded millisecond.
      const [anchor] = await getAuthRuntime().db.select({ cursorTime }).from(tasks).where(and(...filters, eq(tasks.id, cursor.id)));
      if (anchor?.cursorTime?.replace(/\.(\d{3})\d{3}Z$/u, ".$1Z") === instant) instant = anchor.cursorTime;
    }
    const byTime = or(view === "completed" ? sql`${column} < ${instant}::timestamptz` : sql`${column} > ${instant}::timestamptz`,
      and(sql`${column} = ${instant}::timestamptz`, gt(tasks.id, cursor.id)));
    const next = view === "day" ? or(gt(tasks.dailyOrder, cursor.order ?? 0), and(eq(tasks.dailyOrder, cursor.order ?? 0), byTime)) : byTime;
    if (next) filters.push(next);
  }
  const rows = await getAuthRuntime().db.select({ ...getTableColumns(tasks), cursorTime }).from(tasks).where(and(...filters))
    .orderBy(...(view === "day" ? [asc(tasks.dailyOrder)] : []), view === "completed" ? desc(column) : asc(column), asc(tasks.id)).limit(limit + 1);
  const selected = rows.slice(0, limit), last = selected.at(-1);
  let nextCursor: string | null = null;
  if (rows.length > limit && last) {
    const payload = Buffer.from(JSON.stringify({ scope, time: last.cursorTime, id: last.id, ...(view === "day" ? { order: last.dailyOrder } : {}) })).toString("base64url");
    nextCursor = `${payload}.${signature(payload, actor.secret)}`;
  }
  return { status: 200, body: { items: selected.map(({ cursorTime: _cursorTime, ...row }) => taskBody(row)), nextCursor, serverDate: today(actor.timezone), timezone: actor.timezone } };
}

export async function listTaskActivities(actor: Actor, id: string, url: URL) {
  await getTask(actor, id);
  const params = url.searchParams;
  if ([...params.keys()].some(key => !["limit", "cursor"].includes(key) || params.getAll(key).length !== 1)) throw new InputError("query");
  const limitText = params.get("limit") ?? "50", limit = Number(limitText);
  if (!/^\d+$/u.test(limitText) || limit < 1 || limit > 100) throw new InputError("limit");
  const scope = JSON.stringify([actor.id, id, "activity-history-v1", limit]), rawCursor = params.get("cursor");
  const filters = [eq(taskActivities.ownerId, actor.id), eq(taskActivities.taskId, id)];
  if (rawCursor) {
    const cursor = decodeCursor(rawCursor, scope, actor.secret, false, true);
    // Keep all PostgreSQL timestamp digits: legacy events can be closer than one millisecond.
    filters.push(sql`(${taskActivities.occurredAt} < ${cursor.time}::timestamptz OR (${taskActivities.occurredAt} = ${cursor.time}::timestamptz AND ${taskActivities.id} > ${cursor.id}::uuid))`);
  }
  const rows = await getAuthRuntime().db.select({
    id: taskActivities.id, taskId: taskActivities.taskId, type: taskActivities.type, occurredAt: taskActivities.occurredAt,
    invalidatedBy: taskActivities.invalidatedBy, details: taskActivities.details,
    cursorTime: sql<string>`to_char(${taskActivities.occurredAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
  }).from(taskActivities).where(and(...filters)).orderBy(desc(taskActivities.occurredAt), asc(taskActivities.id)).limit(limit + 1);
  const selected = rows.slice(0, limit), last = selected.at(-1);
  let nextCursor: string | null = null;
  if (rows.length > limit && last) {
    const payload = Buffer.from(JSON.stringify({ scope, time: last.cursorTime, id: last.id })).toString("base64url");
    nextCursor = `${payload}.${signature(payload, actor.secret)}`;
  }
  return { status: 200, body: { items: selected.map(({ cursorTime: _cursorTime, ...row }) => ({ ...row, occurredAt: row.occurredAt.toISOString() })), nextCursor } };
}
