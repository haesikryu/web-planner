import { InputError, object, title } from "./rules";

export const SCHEDULE_START = 360;
export const SCHEDULE_END = 1440;
export const SCHEDULE_STEP = 30;
export type ScheduleSlot = { startMinute: number; title: string };
export type ScheduleEntry = { date: string; slots: ScheduleSlot[]; version: number; updatedAt: string | null };

export function normalizeScheduleSlots(value: unknown): ScheduleSlot[] {
  if (!Array.isArray(value) || value.length > (SCHEDULE_END - SCHEDULE_START) / SCHEDULE_STEP) throw new InputError("slots");
  const used = new Set<number>();
  const slots = value.map(raw => {
    const slot = object(raw, ["startMinute", "title"]), startMinute = slot.startMinute;
    if (typeof startMinute !== "number" || !Number.isInteger(startMinute) || startMinute < SCHEDULE_START || startMinute >= SCHEDULE_END || startMinute % SCHEDULE_STEP !== 0 || used.has(startMinute)) throw new InputError("startMinute");
    used.add(startMinute);
    return { startMinute, title: title(slot.title) };
  });
  return slots.sort((a, b) => a.startMinute - b.startMinute);
}
