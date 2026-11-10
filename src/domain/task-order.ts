import { InputError } from "./rules";

export const DAILY_TASK_LIMIT = 5;
export const TASK_MOVES = ["up", "down"] as const;
export type TaskMove = typeof TASK_MOVES[number];
export function taskMove(value: unknown): TaskMove {
  if (value !== "up" && value !== "down") throw new InputError("move");
  return value;
}
