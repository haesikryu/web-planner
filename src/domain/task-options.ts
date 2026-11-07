import { InputError } from "./rules";

export const TASK_PRIORITIES = ["high", "medium", "low"] as const;
export const TASK_KINDS = ["task", "appointment", "event"] as const;
export const TASK_STATUSES = ["open", "completed", "deferred", "canceled"] as const;
export type TaskPriority = typeof TASK_PRIORITIES[number];
export type TaskKind = typeof TASK_KINDS[number];
export type TaskStatus = typeof TASK_STATUSES[number];

export function taskPriority(value: unknown): TaskPriority {
  if (typeof value !== "string" || !TASK_PRIORITIES.includes(value as TaskPriority)) throw new InputError("priority");
  return value as TaskPriority;
}
export function taskKind(value: unknown): TaskKind {
  if (typeof value !== "string" || !TASK_KINDS.includes(value as TaskKind)) throw new InputError("kind");
  return value as TaskKind;
}
export function taskStatus(value: unknown): TaskStatus {
  if (typeof value !== "string" || !TASK_STATUSES.includes(value as TaskStatus)) throw new InputError("status");
  return value as TaskStatus;
}
