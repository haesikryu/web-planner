import { calendarDate, InputError, object, uuidPattern } from "./rules";
import { taskStatus, type TaskStatus } from "./task-options";

export const activityTypeLabels = {
  created: "과제 생성", scheduled_date_changed: "실행일 변경", due_date_changed: "마감일 변경",
  completed: "완료", completion_undone: "완료 취소", reopened: "진행 전으로 복원", deferred: "미룸",
  canceled: "취소", order_changed: "중요도 순서 변경", processing_changed: "정리 상태 변경",
  priority_changed: "기존 중요도 변경", kind_changed: "기존 유형 변경"
} as const;
export type TaskActivityType = keyof typeof activityTypeLabels;
export type TaskPlanSnapshot = { scheduledDate: string | null; dueDate: string | null; status: TaskStatus; dailyOrder: number | null };
export type TaskActivityDetails = { before: TaskPlanSnapshot | null; after: TaskPlanSnapshot; version: number };
export type TaskActivity = { id: string; taskId: string; type: TaskActivityType; occurredAt: string; invalidatedBy: string | null; details: TaskActivityDetails | null };

export function taskPlanSnapshot(task: TaskPlanSnapshot): TaskPlanSnapshot {
  return { scheduledDate: task.scheduledDate, dueDate: task.dueDate, status: task.status, dailyOrder: task.dailyOrder };
}

function snapshot(raw: unknown): TaskPlanSnapshot {
  const value = object(raw, ["scheduledDate", "dueDate", "status", "dailyOrder"]);
  const scheduledDate = value.scheduledDate === null ? null : calendarDate(value.scheduledDate);
  const dueDate = value.dueDate === null ? null : calendarDate(value.dueDate);
  const status = taskStatus(value.status);
  const order = value.dailyOrder;
  if (scheduledDate === null ? order !== null : !Number.isInteger(order) || Number(order) < 1 || Number(order) > 2147483647) throw new InputError("activity.dailyOrder");
  return { scheduledDate, dueDate, status, dailyOrder: order as number | null };
}

export function taskActivity(raw: unknown): TaskActivity {
  const value = object(raw, ["id", "taskId", "type", "occurredAt", "invalidatedBy", "details"]);
  if (typeof value.id !== "string" || !uuidPattern.test(value.id) || typeof value.taskId !== "string" || !uuidPattern.test(value.taskId) ||
      typeof value.type !== "string" || !Object.hasOwn(activityTypeLabels, value.type) ||
      typeof value.occurredAt !== "string" || !Number.isFinite(Date.parse(value.occurredAt)) || new Date(value.occurredAt).toISOString() !== value.occurredAt ||
      (value.invalidatedBy !== null && (typeof value.invalidatedBy !== "string" || !uuidPattern.test(value.invalidatedBy)))) throw new InputError("activity");
  if (value.invalidatedBy !== null && (value.type !== "completed" || value.invalidatedBy === value.id)) throw new InputError("activity.invalidatedBy");
  let details: TaskActivityDetails | null = null;
  if (value.details !== null) {
    const data = object(value.details, ["before", "after", "version"]);
    if (!Number.isInteger(data.version) || Number(data.version) < 1 || Number(data.version) > 2147483647) throw new InputError("activity.version");
    details = { before: data.before === null ? null : snapshot(data.before), after: snapshot(data.after), version: Number(data.version) };
    if (value.type === "created" ? details.before !== null || details.version !== 1 : details.before === null || details.version < 2) throw new InputError("activity.before/version");
  }
  if (details === null && (value.type === "created" || value.type === "due_date_changed")) throw new InputError("activity.details");
  return { id: value.id, taskId: value.taskId, type: value.type as TaskActivityType, occurredAt: value.occurredAt, invalidatedBy: value.invalidatedBy as string | null, details };
}
